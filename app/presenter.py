import logging
import threading
import time
from decimal import Decimal
from flask_socketio import SocketIO
from sqlmodel import select
from typing import Callable, Dict, Any, Optional, Tuple

from app.config import PACKETS_SUBSCRIBERS_ROOM, settings
from .models import MeshtasticPacket, NodeInfo, Position

class Presenter:
    """
    Manages the presentation of data for the frontend
    """
    def __init__(self, socketio: SocketIO, db_factory: Callable):
        self.logger = logging.getLogger(__name__)
        self.socketio = socketio
        self.db_factory = db_factory
        self._node_cache: Dict[str, Tuple[Dict[str, Any], float]] = {}
        self._node_cache_lock = threading.Lock()
        self._node_cache_ttl_seconds = settings.node_cache_ttl_seconds

    @staticmethod
    def _node_payload(node_map: Dict[str, NodeInfo], node_id: str) -> Dict[str, Any]:
        n = node_map.get(node_id)
        if not n:
            return {"id": node_id}
        return {"id": node_id, "short_name": n.short_name, "long_name": n.long_name}

    def _get_cached_node_payload(self, node_id: str) -> Optional[Dict[str, Any]]:
        now = time.time()
        with self._node_cache_lock:
            cached = self._node_cache.get(node_id)
            if not cached:
                return None
            payload, ts = cached
            if now - ts > self._node_cache_ttl_seconds:
                self._node_cache.pop(node_id, None)
                return None
            return payload

    def _set_cached_node_payload(self, node_id: str, payload: Dict[str, Any]) -> None:
        with self._node_cache_lock:
            self._node_cache[node_id] = (payload, time.time())

    def upsert_node_cache(self, nodeinfo: NodeInfo) -> None:
        payload: Dict[str, Any] = {
            "id": nodeinfo.id_,
            "short_name": nodeinfo.short_name,
            "long_name": nodeinfo.long_name,
        }
        self._set_cached_node_payload(nodeinfo.id_, payload)

    def raw_packet_callback(self, packet: MeshtasticPacket):

        self.logger.info("Raw packet callback: %s", packet)
        if packet.rx_snr is not None and not isinstance(packet.rx_snr, Decimal):
            packet.rx_snr = Decimal(str(packet.rx_snr))
        payload = packet.model_dump(mode="json")
        
        # Ensure is_duplicate is included in the payload
        payload["is_duplicate"] = packet.is_duplicate

        # Enrich the data sent to the frontend with resolved node names
        from_id = f"!{packet.from_:08x}"
        uplink_id = packet.uplink  # already has leading '!'
        is_broadcast = (packet.to == 0xffffffff)

        if not is_broadcast:
            to_id = f"!{packet.to:08x}"

        from_node_payload = self._get_cached_node_payload(from_id)
        uplink_node_payload = self._get_cached_node_payload(uplink_id)
        to_node_payload = None if is_broadcast else self._get_cached_node_payload(to_id)

        missing_ids = set()
        if from_node_payload is None:
            missing_ids.add(from_id)
        if uplink_node_payload is None:
            missing_ids.add(uplink_id)
        if not is_broadcast and to_node_payload is None:
            missing_ids.add(to_id)

        if missing_ids:
            with self.db_factory() as db:
                # Only select essential columns to avoid errors with missing channel fields
                result = db.execute(
                    select(NodeInfo).where(NodeInfo.id_.in_(list(missing_ids)))
                )
                nodes = result.scalars().all()
                node_map = {n.id_: n for n in nodes}

                for node_id in missing_ids:
                    resolved = self._node_payload(node_map, node_id)
                    self._set_cached_node_payload(node_id, resolved)

                    if node_id == from_id:
                        from_node_payload = resolved
                    elif node_id == uplink_id:
                        uplink_node_payload = resolved
                    elif not is_broadcast and node_id == to_id:
                        to_node_payload = resolved

        # Add the resolved node names to the payload
        # TODO: is this the best wey, or from/to/uplink nodes should be objects instead of strings?
        payload["from_node"] = from_node_payload or {"id": from_id}
        payload["uplink_node"] = uplink_node_payload or {"id": uplink_id}
        if is_broadcast:
            payload["to_node"] = {"id": packet.to, "name": "BROADCAST"}
        else:
            payload["to_node"] = to_node_payload or {"id": to_id}
    
        self.socketio.emit(
            "packets",
            payload,
            namespace=settings.namespace_packets,
            room=PACKETS_SUBSCRIBERS_ROOM,
        )


    def emit_position_event(self, *, node_id: str, position: Position, node_data=None, ts: int, packet_id: Optional[int] = None) -> None:
        payload: Dict[str, Any] = {
            "type": "position",
            "id": node_id,
            "ts": int(ts),
            "payload": {
                "position": {
                    "latitude": position.latitude,
                    "longitude": position.longitude,
                    "altitude": position.altitude,
                    "ground_speed_kmph": position.ground_speed,
                    "heading": position.heading,
                    "precision_bits": position.precision_bits,
                    "radius": position.radius,
                    "position_age_hours_ago": 0,  # Real-time events are always current
                }
            },
            "meta": {},
        }

        # Include node status and channel info if available
        if node_data:
            payload["payload"]["node"] = node_data

        if packet_id is not None:
            payload["meta"]["packet_id"] = int(packet_id)

        self.socketio.emit("event", payload, namespace=settings.namespace_events)


    def emit_nodeinfo_event(self, *, nodeinfo: NodeInfo, ts: int, packet_id: Optional[int] = None) -> None:
        payload: Dict[str, Any] = {
            "type": "nodeinfo",
            "id": nodeinfo.id_,
            "ts": int(ts),
            "payload": {
                "nodeinfo": {
                    "short_name": nodeinfo.short_name,
                    "long_name": nodeinfo.long_name,
                    "hw_model": nodeinfo.hw_model,
                    "role": nodeinfo.role,
                    "is_unmessagable": nodeinfo.is_unmessagable,
                }
            },
            "meta": {},
        }

        if packet_id is not None:
            payload["meta"]["packet_id"] = int(packet_id)

        self.socketio.emit("event", payload, namespace=settings.namespace_events)

import logging
import threading
import time
from flask_socketio import SocketIO
from sqlmodel import select
from typing import Callable, Dict, Any, Optional, Tuple

from app.config import settings
from .models import MeshtasticPacket, NodeInfo

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
    def _node_payload(node_map: dict, node_id: str):
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
        self.logger.info("Updating cache for node %s", nodeinfo.id_)
        payload: Dict[str, Any] = {
            "id": nodeinfo.id_,
            "short_name": nodeinfo.short_name,
            "long_name": nodeinfo.long_name,
        }
        self._set_cached_node_payload(nodeinfo.id_, payload)

    def raw_packet_callback(self, packet: MeshtasticPacket):

        self.logger.info("Raw packet callback: %s", packet)
        payload = packet.model_dump(by_alias=True)

        from_id = f"!{packet.from_:08x}"
        uplink_id = packet.uplink  # already has leading '!'
        node_ids = {from_id, uplink_id}
        is_broadcast = (packet.to == 0xffffffff)

        if not is_broadcast:
            to_id = f"!{packet.to:08x}"
            node_ids.add(to_id)

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
            self.logger.info("Missing node info, loading from DB: %s", missing_ids)
            with self.db_factory() as db:
                result = db.execute(select(NodeInfo).where(NodeInfo.id_.in_(list(missing_ids))))
                nodes = result.scalars().all()
                node_map = {n.id_: n for n in nodes}

                for node_id in missing_ids:
                    resolved = self._node_payload(node_map, node_id)
                    self._set_cached_node_payload(node_id, resolved)

            if from_node_payload is None:
                from_node_payload = self._get_cached_node_payload(from_id)
            if uplink_node_payload is None:
                uplink_node_payload = self._get_cached_node_payload(uplink_id)
            if not is_broadcast and to_node_payload is None:
                to_node_payload = self._get_cached_node_payload(to_id)

        payload["from_node"] = from_node_payload or {"id": from_id}
        payload["uplink_node"] = uplink_node_payload or {"id": uplink_id}
        if is_broadcast:
            payload["to_node"] = {"id": packet.to, "name": "BROADCAST"}
        else:
            payload["to_node"] = to_node_payload or {"id": to_id}
    
        self.socketio.emit(
            "rawlog", payload, namespace=settings.namespace_rawdata
        )

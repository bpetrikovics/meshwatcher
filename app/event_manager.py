import json
import logging

from datetime import datetime, timezone
import time
from typing import Callable, Any, Optional
from pydantic import ValidationError
from sqlalchemy import text, select
from sqlalchemy.exc import IntegrityError

from meshtastic_mqtt_json import MeshtasticMQTT

from .packet_handling import raw_handler
from .models import (
    MeshtasticPacket,
    NodeInfo,
    Telemetry,
    Metric,
    Position,
    TextMessage,
    Routing,
    LinkObservation,
)
from .presenter import Presenter
from .config import settings
from .link_resolver import NodeSuffixIndex


class PayloadExtractor:
    """
    Base class for payload extraction strategies.
    
    This strategy pattern allows for extensible payload extraction from different
    Meshtastic packet types. Each strategy handles the specific extraction logic
    for a particular packet type and target class combination.
    
    Usage:
        extractor = TextMessageExtractor()
        result = extractor.extract(packet, TextMessage)
    """
    
    def extract(self, packet: MeshtasticPacket, class_to_extract: type):
        """
        Extract and validate payload from packet to target class.
        
        Args:
            packet: The Meshtastic packet to extract from
            class_to_extract: Target class for validation (e.g., TextMessage, Position)
            
        Returns:
            Validated instance of class_to_extract
            
        Raises:
            NotImplementedError: Must be implemented by subclasses
        """
        raise NotImplementedError


class TextMessageExtractor(PayloadExtractor):
    """
    Extractor for TEXT_MESSAGE_APP packets.
    
    Handles the special case where text message data is spread across both
    the payload field and the decoded dictionary, including optional fields
    like replyId, emoji, and bitfield.
    """
    
    def extract(self, packet: MeshtasticPacket, class_to_extract: type):
        """
        Extract payload specifically for text messages.
        
        Args:
            packet: The Meshtastic packet to extract from
            class_to_extract: Target class (should be TextMessage)
            
        Returns:
            Validated TextMessage instance
        """
        text = packet.decoded.get("payload", "")
        if isinstance(text, (bytes, bytearray)):
            text = text.decode(errors='replace')
        
        data = {
            "text": text,
            "channel_name": packet.channel_name,
            "packet_id": packet.id_,
            "timestamp": packet.rx_time
        }
        
        # Only add optional fields if they're not None
        decoded_to_model = {
            "replyId": "reply_id",
            "emoji": "emoji",
            "bitfield": "bitfield",
        }
        for decoded_key, model_key in decoded_to_model.items():
            if packet.decoded.get(decoded_key) is not None:
                data[model_key] = packet.decoded.get(decoded_key)
        
        return class_to_extract.model_validate(data)


class DefaultExtractor(PayloadExtractor):
    """
    Default extractor for standard packet types.
    
    Handles the common case where payload data is contained within the
    decoded['payload'] field and can be directly validated using Pydantic.
    """
    
    def extract(self, packet: MeshtasticPacket, class_to_extract: type):
        """
        Standard payload extraction for other packet types.
        
        Args:
            packet: The Meshtastic packet to extract from
            class_to_extract: Target class for validation
            
        Returns:
            Validated instance of class_to_extract
        """
        payload = packet.decoded.get("payload")
        if payload is None:
            return class_to_extract.model_validate({})

        if isinstance(payload, (bytes, bytearray)):
            payload = payload.decode(errors='replace')

        if isinstance(payload, str):
            return class_to_extract.model_validate_json(payload)

        try:
            return class_to_extract.model_validate(payload)
        except ValidationError:
            return class_to_extract.model_validate_json(json.dumps(payload))


class RoutingExtractor(PayloadExtractor):
    """
    Extractor for ROUTING_APP packets.
    
    Handles routing packets that may contain error information and request/response
    correlation data. Extracts error reasons and request IDs for network analysis.
    """
    
    def extract(self, packet: MeshtasticPacket, class_to_extract: type):
        """
        Extract payload specifically for routing packets.
        
        Args:
            packet: The Meshtastic packet to extract from
            class_to_extract: Target class (should be Routing)
            
        Returns:
            Validated Routing instance
        """
        payload = packet.decoded.get("payload", {})
        
        data = {
            "node_id": f"!{packet.from_:08x}",
            "packet_id": packet.id_,
            "timestamp": packet.rx_time,
            "request_id": packet.decoded.get("requestId"),
            "error_reason": payload.get("errorReason"),
        }
        
        return class_to_extract.model_validate(data)


class EventManager:
    # Class-level constants to avoid repeated instantiation
    _TEXT_EXTRACTOR = TextMessageExtractor()
    _DEFAULT_EXTRACTOR = DefaultExtractor()
    _ROUTING_EXTRACTOR = RoutingExtractor()
    
    def __init__(self, mqtt_client: MeshtasticMQTT, db_factory: Callable, presenter: Presenter):
        self.logger = logging.getLogger(__name__)
        self.mqtt = mqtt_client
        self.db_factory = db_factory
        self.presenter = presenter

        self.suffix_index = NodeSuffixIndex()
        raw_handler.stats.suffix_index = self.suffix_index

        self.mqtt.register_callback('TEXT_MESSAGE_APP', self.on_text_message)
        self.mqtt.register_callback('POSITION_APP', self.on_position)
        self.mqtt.register_callback('NODEINFO_APP', self.on_nodeinfo)
        self.mqtt.register_callback('TRACEROUTE_APP', self.on_traceroute)
        self.mqtt.register_callback('TELEMETRY_APP', self.on_telemetry)
        self.mqtt.register_callback('NEIGHBORINFO_APP', self.on_neighborinfo)
        self.mqtt.register_callback('ROUTING_APP', self.on_routing)
        self.mqtt.register_callback('STORE_FORWARD_APP', self.on_store_forward)

        raw_handler.register_callback("raw", self.presenter.raw_packet_callback)

        self._populate_suffix_index()

        self.mqtt.loop_start()
        self.logger.info("Initialized // version: %s", settings.git_commit)

    def _populate_suffix_index(self) -> None:
        """Pre-populate the suffix index from all nodes already stored in the database."""
        try:
            with self.db_factory() as db:
                node_ids = [row[0] for row in db.execute(
                    text("SELECT id FROM nodes")
                ).fetchall()]
            self.suffix_index.register_all(node_ids)
            self.logger.info("Suffix index pre-populated with %d node(s) from database", len(node_ids))
        except Exception as exc:
            self.logger.warning("Could not pre-populate suffix index: %s", exc)

    def _update_node_last_seen(self, node_id: str, db, channel: Optional[int] = None, channel_name: Optional[str] = None):
        """Update node's last seen timestamp to current time and optionally channel info. Returns the node object."""
        current_time = datetime.now(timezone.utc)
        return self._update_node_last_seen_with_time(node_id, db, current_time, channel, channel_name)

    def _update_node_last_seen_with_time(self, node_id: str, db, current_time: datetime, channel: Optional[int] = None, channel_name: Optional[str] = None):
        """Update node's last seen timestamp to specified time and optionally channel info. Returns the node object."""
        existing_node = db.get(NodeInfo, node_id)
        if existing_node:
            existing_node.updated = current_time
            # Update channel info if provided
            if channel is not None:
                existing_node.last_channel = channel
            if channel_name is not None:
                existing_node.last_channel_name = channel_name
            return existing_node
        else:
            # Create placeholder node with specified timestamp, default role, and channel info
            placeholder_node = NodeInfo(
                id_=node_id, 
                updated=current_time, 
                role="CLIENT",
                last_channel=channel,
                last_channel_name=channel_name
            )
            db.add(placeholder_node)
            db.flush()  # Ensure the placeholder is in the database before returning
            return placeholder_node

    @staticmethod
    def extract_payload(packet: MeshtasticPacket, class_to_extract: type) -> Any:
        """
        Extract and validate payload using strategy pattern.
        
        This method implements the Strategy pattern to select the appropriate
        extractor based on the packet type and target class. The pattern allows
        for easy extension with new packet types without modifying existing code.
        
        Args:
            packet: The Meshtastic packet to extract from
            class_to_extract: Target class for validation (e.g., TextMessage, Position)
            
        Returns:
            Validated instance of class_to_extract
            
        Raises:
            ValueError: If packet is missing required fields
            ValidationError: If payload cannot be validated
        """
        if not packet.decoded_portnum:
            raise ValueError("Packet missing decoded_portnum")
        
        extractor_map = {
            ("TEXT_MESSAGE_APP", TextMessage): EventManager._TEXT_EXTRACTOR,
            ("ROUTING_APP", Routing): EventManager._ROUTING_EXTRACTOR,
        }
        
        key: tuple[str, type] = (packet.decoded_portnum, class_to_extract)
        extractor = extractor_map.get(key, EventManager._DEFAULT_EXTRACTOR)
        return extractor.extract(packet, class_to_extract)

    @raw_handler.validate_packet
    def on_text_message(self, packet: MeshtasticPacket):
        """
        { portnum': 'TEXT_MESSAGE_APP', 'payload': '🙋', 'replyId': 295099086, 'emoji': 1,
         'bitfield': 1
        }
        """
        try:
            text_message = self.extract_payload(packet, TextMessage)
        except ValidationError as exc:
            self.logger.exception(exc)
            self.logger.error(packet.model_dump_json())
            return
        
        node_id = f"!{packet.from_:08x}"
        text_message.node_id = node_id

        self.logger.info(text_message)

        with self.db_factory() as db:
            # Update node's last seen timestamp and channel info
            self._update_node_last_seen(node_id, db, packet.channel, packet.channel_name)
            db.merge(text_message)

    @raw_handler.validate_packet
    def on_position(self, packet: MeshtasticPacket):
        try:
            position = self.extract_payload(packet, Position)
        except ValidationError as exc:
            self.logger.exception(exc)
            return
        
        # Skip packets with no actual coordinates (e.g. node broadcasting before GPS fix)
        if position.latitude_i is None or position.longitude_i is None:
            self.logger.warning("Received position packet with missing coordinates from node %s, skipping", hex(packet.from_))
            return

        node_id = f"!{packet.from_:08x}"
        position.node_id = node_id

        self.logger.info(position)

        with self.db_factory() as db:
            # Update node's last seen timestamp and get the synchronized timestamp
            current_time = datetime.now(timezone.utc)
            updated_node = self._update_node_last_seen_with_time(node_id, db, current_time, packet.channel, packet.channel_name)
            
            # Ensure position timestamp matches node timestamp for consistency
            position.created_at = current_time
            db.merge(position)

            # Extract node data while session is still open to avoid DetachedInstanceError
            node_data = {
                "status": "currently_active",  # Node is active because we just received a packet
                "role": updated_node.role or "CLIENT",
                "last_channel": updated_node.last_channel,
                "last_channel_name": updated_node.last_channel_name,
            }

        try:
            self.presenter.emit_position_event(
                node_id=node_id,
                position=position,
                node_data=node_data,  # Use extracted data instead of detached object
                ts=int(time.time()),
                packet_id=packet.id_,
            )
        except Exception as exc:
            self.logger.exception(exc)

    @raw_handler.validate_packet
    def on_nodeinfo(self, packet: MeshtasticPacket):
        try:
            nodeinfo = self.extract_payload(packet, NodeInfo)
        except ValidationError as exc:
            self.logger.exception(exc)
            return

        self.logger.info(nodeinfo)

        # TODO: recognize nodeinfo request/exchanges, directed vs broadcast

        with self.db_factory() as db:
            # Update node's last seen timestamp and get the node object
            existing_node = self._update_node_last_seen(nodeinfo.id_, db, packet.channel, packet.channel_name)
            
            # Update the existing node with nodeinfo data
            if nodeinfo.short_name is not None:
                existing_node.short_name = nodeinfo.short_name
            if nodeinfo.long_name is not None:
                existing_node.long_name = nodeinfo.long_name
            if nodeinfo.macaddr is not None:
                existing_node.macaddr = nodeinfo.macaddr
            if nodeinfo.hw_model is not None:
                existing_node.hw_model = nodeinfo.hw_model
            if nodeinfo.public_key is not None:
                existing_node.public_key = nodeinfo.public_key
            if nodeinfo.role is not None:
                existing_node.role = nodeinfo.role
            else:
                # Default to CLIENT if role is not specified
                existing_node.role = "CLIENT"
            if nodeinfo.is_unmessagable is not None:
                existing_node.is_unmessagable = nodeinfo.is_unmessagable
            
            # Use the updated existing_node for cache
            self.presenter.upsert_node_cache(existing_node)

            try:
                self.presenter.emit_nodeinfo_event(
                    nodeinfo=existing_node,
                    ts=int(time.time()),
                    packet_id=packet.id_,
                )
            except Exception as exc:
                self.logger.exception(exc)

        self.logger.debug("Node %s was upserted", nodeinfo.id_)
        self.suffix_index.register(nodeinfo.id_)
        self._resolve_deferred_observations(nodeinfo.id_)

    def _resolve_deferred_observations(self, node_id: str) -> None:
        """
        Phase 7 — deferred resolution pass.

        Called after a new node is registered in the suffix index.  If this
        node's last byte now uniquely identifies a single known node (i.e.
        the suffix is no longer ambiguous), back-fill all LinkObservation rows
        that were stored with is_resolved=False and raw_suffix matching this
        node's last byte.
        """
        raw_suffix_int = int(node_id.lstrip("!")[-2:], 16)
        resolved_id, is_definitive = self.suffix_index.resolve(raw_suffix_int)
        if not is_definitive:
            return

        try:
            with self.db_factory() as db:
                stmt = select(LinkObservation).where(
                    LinkObservation.is_resolved == False,  # noqa: E712
                    LinkObservation.raw_suffix == raw_suffix_int,
                )
                rows = db.execute(stmt).scalars().all()
                if not rows:
                    return
                for row in rows:
                    if row.edge_type == "nexthop":
                        row.dst_node = resolved_id
                    else:
                        row.src_node = resolved_id
                    row.is_resolved = True
                self.logger.info(
                    "Deferred resolution: back-filled %d LinkObservation(s) for suffix 0x%02x → %s",
                    len(rows), raw_suffix_int, resolved_id,
                )
        except Exception as exc:
            self.logger.exception("Deferred resolution failed for node %s: %s", node_id, exc)

    # If TR handler gets deduplicated packets, it will not receive all responses only the first
    @raw_handler.validate_packet(dedup=False)
    def on_traceroute(self, packet: MeshtasticPacket):
        """
        {'from': 2956776068, 'to': 2552625594, 'channel': 8,
        'decoded': {
            'portnum': 'TRACEROUTE_APP', 'wantResponse': True, 'bitfield': 3,
            'payload': {}
            },
        'id': 2363252984, 'rxTime': 1759165167, 'hopLimit': 7, 'wantAck': True, 'priority': 'RELIABLE', 'hopStart': 7, 'nextHop': 227, 'relayNode': 132}

        {'from': 2552625594, 'to': 2956776068, 'channel': 8,
        'decoded':
            {'portnum': 'TRACEROUTE_APP',
                'payload': {
                    'route': [2574456035, 146503212],
                    'snrTowards': [11, -54, -4],
                    'routeBack': [146509480],
                    'snrBack': [36]
                    },
                'requestId': 2363252984, 'bitfield': 1
            },
        'id': 3427050615, 'rxTime': 1759165174, 'rxSnr': -13.0, 'hopLimit': 2, 'wantAck': True, 'rxRssi': -123, 'hopStart': 3, 'relayNode': 168}
        ka8b -> 2.75 -> csh -> -13.5 -> csgy -> -1.0 -> mtrx
        mtrx -> 9.0 -> jant -> 0.0  -> ka8b
        dB = mqtt dB / 4
        """

        if packet.decoded_requestid:
            self.logger.info(
                "Packet %s traceroute response to request %s",
                hex(packet.id_), hex(packet.decoded_requestid),
            )
        else:
            self.logger.info("Packet %s traceroute request (partial route may be present)", hex(packet.id_))

        payload = packet.decoded.get("payload") or {}
        if not isinstance(payload, dict):
            return

        route = payload.get("route")
        if not route:
            return

        snr_towards = payload.get("snrTowards") or []
        route_back = payload.get("routeBack") or []
        snr_back = payload.get("snrBack") or []

        _BROADCAST = 0xFFFFFFFF

        # For a response the direction is: original requester (to) → intermediates → responder (from_).
        # For a request captured mid-flight the direction is: originator (from_) → intermediates → destination (to).
        if packet.decoded_requestid:
            full_route = [f"!{n:08x}" for n in ([packet.to] + list(route) + [packet.from_])]
        else:
            full_route = [f"!{n:08x}" for n in ([packet.from_] + list(route) + [packet.to])]

        for node_id in full_route:
            self.suffix_index.register(node_id)

        observed_at = datetime.now(timezone.utc)
        observations = []
        for i in range(len(full_route) - 1):
            src = full_route[i]
            dst = full_route[i + 1]
            if src == "!ffffffff" or dst == "!ffffffff":
                self.logger.debug(
                    "Traceroute %s hop %d skipped: broadcast node id", hex(packet.id_), i
                )
                continue
            # snrTowards values are raw integer SNR × 4
            snr = snr_towards[i] / 4.0 if i < len(snr_towards) else None
            observations.append(LinkObservation(
                observed_at=observed_at,
                packet_id=packet.id_,
                src_node=src,
                dst_node=dst,
                edge_type="traceroute_hop",
                hops_taken=i,
                rx_snr=snr,
                channel=packet.channel,
                channel_name=packet.channel_name,
                is_resolved=True,
            ))

        # --- Back-route hops (response packets only) -------------------------
        # routeBack/snrBack describe the return path from responder to requester.
        if packet.decoded_requestid and route_back:
            # Back route direction: from_ (responder) → routeBack intermediates → to (requester)
            full_route_back = [f"!{n:08x}" for n in ([packet.from_] + list(route_back) + [packet.to])]
            for node_id in full_route_back:
                self.suffix_index.register(node_id)
            for i in range(len(full_route_back) - 1):
                src = full_route_back[i]
                dst = full_route_back[i + 1]
                if src == "!ffffffff" or dst == "!ffffffff":
                    self.logger.debug(
                        "Traceroute %s back hop %d skipped: broadcast node id", hex(packet.id_), i
                    )
                    continue
                snr = snr_back[i] / 4.0 if i < len(snr_back) else None
                observations.append(LinkObservation(
                    observed_at=observed_at,
                    packet_id=packet.id_,
                    src_node=src,
                    dst_node=dst,
                    edge_type="traceroute_hop_back",
                    hops_taken=i,
                    rx_snr=snr,
                    channel=packet.channel,
                    channel_name=packet.channel_name,
                    is_resolved=True,
                ))

        self.logger.info(
            "Traceroute %s: %d hop observation(s) recorded",
            hex(packet.id_), len(observations),
        )

        node_id = f"!{packet.from_:08x}"
        with self.db_factory() as db:
            self._update_node_last_seen(node_id, db, packet.channel, packet.channel_name)
            db.add_all(observations)

    @raw_handler.validate_packet
    def on_telemetry(self, packet: MeshtasticPacket):
        node_id = f"!{packet.from_:08x}"

        try:
            telemetry_obj = self.extract_payload(packet, Telemetry)
        except ValidationError as exc:
            self.logger.exception(exc)
            return

        telemetry_obj.node_id = node_id
        self.logger.info(telemetry_obj)

        # Validate payload before any database operations
        if not isinstance(telemetry_obj.payload, dict):
            return

        with self.db_factory() as db:
            # Update node's last seen timestamp and channel info
            self._update_node_last_seen(node_id, db, packet.channel, packet.channel_name)

            telemetry_id = None

            # Conditionally save raw telemetry packet based on configuration
            # When disabled, only individual metrics are saved (telemetry_id=None)
            if settings.raw_telemetry_log:
                try:
                    db.add(telemetry_obj)
                    db.flush()
                    telemetry_id = telemetry_obj.db_id
                except IntegrityError:
                    db.rollback()
                    return

            # Extract and save individual metrics from telemetry payload
            metric_rows = []
            for k, v in telemetry_obj.payload.items():
                if isinstance(v, (int, float)):
                    metric_rows.append(
                        Metric(
                            telemetry_id=telemetry_id,
                            node_id=telemetry_obj.node_id,
                            metric_type=telemetry_obj.metric_type,
                            metric=str(k),
                            ts=telemetry_obj.ts,
                            value=float(v),
                        )
                    )

            if metric_rows:
                db.add_all(metric_rows)

    @raw_handler.validate_packet
    def on_neighborinfo(self, packet: MeshtasticPacket):
        """
        {'from': 3031777281, 'to': 1, 'channel': 8,
        'decoded': {
            'portnum': 'NEIGHBORINFO_APP',
            'payload': {
              'nodeId': 3031777281, 'lastSentById': 3031777281, 'nodeBroadcastIntervalSecs': 300,
              'neighbors': [
                {'nodeId': 3663224352, 'snr': 10.25}
                ]},
            'bitfield': 1},
        'id': 3781190161, 'rxTime': 1734511540, 'priority': 'BACKGROUND', 'hopStart': 7} 
        """
        payload = packet.decoded.get("payload") or {}
        if not isinstance(payload, dict):
            return
        neighbors = payload.get("neighbors")
        if not neighbors:
            return

        src_node = f"!{packet.from_:08x}"
        observed_at = datetime.now(timezone.utc)
        self.suffix_index.register(src_node)

        observations = []
        for neighbor in neighbors:
            node_id_int = neighbor.get("nodeId")
            if node_id_int is None:
                continue
            dst_node = f"!{node_id_int:08x}"
            self.suffix_index.register(dst_node)
            observations.append(LinkObservation(
                observed_at=observed_at,
                packet_id=packet.id_,
                src_node=src_node,
                dst_node=dst_node,
                edge_type="neighbor_report",
                rx_snr=neighbor.get("snr"),
                channel=packet.channel,
                channel_name=packet.channel_name,
                is_resolved=True,
            ))

        if not observations:
            return

        self.logger.info(
            "Neighborinfo from %s: %d neighbor(s)", src_node, len(observations)
        )

        with self.db_factory() as db:
            self._update_node_last_seen(src_node, db, packet.channel, packet.channel_name)
            db.add_all(observations)

    @raw_handler.validate_packet
    def on_routing(self, packet: MeshtasticPacket):
        """
        {'from': 977800444, 'to': 2224788660, 'channel': 31,
        'decoded': {
            'portnum': 'ROUTING_APP',
            'payload': {
                'errorReason': 'NO_RESPONSE'}, 'requestId': 43532287, 'bitfield': 1},
            'id': 465935777, 'rxTime': 1766230534, 'rxSnr': 11.75, 'hopLimit': 3,
            'rxRssi': -54, 'hopStart': 6, 'relayNode': 186, 'transportMechanism': 'TRANSPORT_LORA',
            'channelName': 'MediumFast'}        
        """
        try:
            routing = self.extract_payload(packet, Routing)
        except ValidationError as exc:
            self.logger.exception(exc)
            self.logger.error(packet.model_dump_json())
            return

        self.logger.info(routing)

        # Update node's last seen timestamp and channel info even though we don't store routing data
        node_id = f"!{packet.from_:08x}"
        with self.db_factory() as db:
            self._update_node_last_seen(node_id, db, packet.channel, packet.channel_name)

        # For now, we're not storing routing packets in database as requested
        # The routing data is parsed and logged for analysis purposes only

    def on_store_forward(self, json_data):
        pass

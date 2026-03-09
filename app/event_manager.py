import json
import logging

from datetime import datetime, timezone
from typing import Callable, Any
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError
from sqlmodel import select

from meshtastic_mqtt_json import MeshtasticMQTT

from .packet_handling import raw_handler
from .models import MeshtasticPacket, NodeInfo, Telemetry, Metric, Position, TextMessage, Routing
from .presenter import Presenter
from .config import settings


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
            text = text.decode()
        
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
            payload = payload.decode()

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

        self.mqtt.register_callback('TEXT_MESSAGE_APP', self.on_text_message)
        self.mqtt.register_callback('POSITION_APP', self.on_position)
        self.mqtt.register_callback('NODEINFO_APP', self.on_nodeinfo)
        self.mqtt.register_callback('TRACEROUTE_APP', self.on_traceroute)
        self.mqtt.register_callback('TELEMETRY_APP', self.on_telemetry)
        self.mqtt.register_callback('NEIGHBORINFO_APP', self.on_neighborinfo)
        self.mqtt.register_callback('ROUTING_APP', self.on_routing)
        self.mqtt.register_callback('STORE_FORWARD_APP', self.on_store_forward)

        raw_handler.register_callback("raw", self.presenter.raw_packet_callback)

        self.mqtt.loop_start()
        self.logger.info("Initialized // version: %s", settings.git_commit)

    def _update_node_last_seen(self, node_id: str, db):
        """Update node's last seen timestamp to current time. Returns the node object."""
        existing_node = db.get(NodeInfo, node_id)
        current_time = datetime.now(timezone.utc)
        if existing_node:
            existing_node.updated = current_time
            return existing_node
        else:
            # Create placeholder node with current timestamp
            placeholder_node = NodeInfo(id_=node_id, updated=current_time)
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
            # Update node's last seen timestamp
            self._update_node_last_seen(node_id, db)
            db.merge(text_message)

    @raw_handler.validate_packet
    def on_position(self, packet: MeshtasticPacket):
        try:
            position = self.extract_payload(packet, Position)
        except ValidationError as exc:
            self.logger.exception(exc)
            return
        
        node_id = f"!{packet.from_:08x}"
        position.node_id = node_id

        self.logger.info(position)

        with self.db_factory() as db:
            # Update node's last seen timestamp
            self._update_node_last_seen(node_id, db)
            db.merge(position)

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
            existing_node = self._update_node_last_seen(nodeinfo.id_, db)
            
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
            if nodeinfo.is_unmessagable is not None:
                existing_node.is_unmessagable = nodeinfo.is_unmessagable
            
            # Use the updated existing_node for cache
            self.presenter.upsert_node_cache(existing_node)

        self.logger.debug("Node %s was upserted", nodeinfo.id_)

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
            self.logger.info("Packet %s traceroute is response to previous request %s", hex(packet.id_), hex(packet.decoded_requestid))
        else:
            self.logger.info("Not a TR response")

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
            # Update node's last seen timestamp
            self._update_node_last_seen(node_id, db)

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

    def on_neighborinfo(self, json_data):
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
        pass

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

        # Update node's last seen timestamp even though we don't store routing data
        node_id = f"!{packet.from_:08x}"
        with self.db_factory() as db:
            self._update_node_last_seen(node_id, db)

        # For now, we're not storing routing packets in database as requested
        # The routing data is parsed and logged for analysis purposes only

    def on_store_forward(self, json_data):
        pass

import json
import logging

from typing import Callable
from pydantic import ValidationError

from meshtastic_mqtt_json import MeshtasticMQTT

from .packet_handling import raw_handler
from .models import MeshtasticPacket, NodeInfo, Telemetry
from .presenter import Presenter


class EventManager:
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
        self.logger.info("Initialized")

    @staticmethod
    def extract_payload(packet: MeshtasticPacket, class_to_extract):
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

    @raw_handler.validate_packet
    def on_text_message(self, packet: MeshtasticPacket):
        """
        { portnum': 'TEXT_MESSAGE_APP', 'payload': '🙋', 'replyId': 295099086, 'emoji': 1,
         'bitfield': 1
        }
        """
        self.logger.info(packet)

    def on_position(self, json_data):
        pass

    @raw_handler.validate_packet
    def on_nodeinfo(self, packet: MeshtasticPacket):
        """
        { 'portnum': 'NODEINFO_APP', 'payload': {
          'id': '!d45a9a80', 'longName': '🇭🇺 CzD B2', 'shortName': 'czd4', 'macaddr': 'HNvUWpqA','hwModel': 'SEEED_XIAO_S3',
          'role': 'CLIENT_BASE', 'publicKey': 'sXwaWsSIxXwHHNtaAumip6sBeajxwGbS5gFrLX5r83U=', 'isUnmessagable': True},
          'requestId': 5571986, 'bitfield': 1
        }
        """
        try:
            nodeinfo = self.extract_payload(packet, NodeInfo)
        except ValidationError as exc:
            self.logger.exception(exc)
            return

        self.logger.info(nodeinfo)

        # TODO: recognize nodeinfo request/exchanges, directed vs broadcast

        with self.db_factory() as db:
            db.merge(nodeinfo)

        self.presenter.upsert_node_cache(nodeinfo)

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
        """
        {'from': 2922542922, 'to': 4294967295,
        'channel': 8,
        'decoded': {
          'portnum': 'TELEMETRY_APP',
          'payload': {
              'time': 1747876154,
              'deviceMetrics': {
                  'batteryLevel': 91, 'voltage': 4.07, 'channelUtilization': 12.825001, 'airUtilTx': 6.1378055, 'uptimeSeconds': 1063460
                  }
              },
          'bitfield': 1},
        'id': 923524629, 'rxTime': 1747876154, 'priority': 'BACKGROUND', 'hopStart': 3, 'relayNode': 74}
        """
        self.logger.info(f"Telemetry payload: {packet.decoded}")
        node_id = f"!{packet.from_:08x}"

        try:
            metric = self.extract_payload(packet, Telemetry)
        except ValidationError as exc:
            self.logger.exception(exc)
            return

        metric.node_id = node_id
        self.logger.info(metric)

        with self.db_factory() as db:
            # Allow handling of telemetry before nodeinfo received for the corresponding node
            db.merge(NodeInfo(id_=node_id))
            db.add(metric)

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

    def on_routing(self, json_data):
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
        pass

    def on_store_forward(self, json_data):
        pass

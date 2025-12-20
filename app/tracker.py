import time
import logging

from typing import Callable, List, Dict, Optional
from pydantic import ValidationError
from meshtastic_mqtt_json import MeshtasticMQTT

from .config import settings
from .util import skip_dups, json_log

class Tracker:
    def __init__(self, client: MeshtasticMQTT):
        self.client = client
        self.logger = logging.getLogger(__name__)

        self.client.register_callback('TEXT_MESSAGE_APP', self.on_text_message)
        self.client.register_callback('POSITION_APP', self.on_position)
        self.client.register_callback('NODEINFO_APP', self.on_nodeinfo)
        self.client.register_callback('TRACEROUTE_APP', self.on_traceroute)
        self.client.register_callback('TELEMETRY_APP', self.on_telemetry)
        self.client.register_callback('NEIGHBORINFO_APP', self.on_neighborinfo)
        self.client.register_callback('ROUTING_APP', self.on_routing)
        self.client.register_callback('STORE_FORWARD_APP', self.on_store_forward)

        self.client.loop_start()
        self.logger.info("Initialized")

    @skip_dups
    @json_log
    def on_text_message(self, json_data):
        """
        {'from': 2956776068, 'to': 4294967295, 'channel': 31,
        'decoded': {
            portnum': 'TEXT_MESSAGE_APP', 'payload': '🙋', 'replyId': 295099086, 'emoji': 1, 'bitfield': 1
            },
        'id': 3272591329, 'rxTime': 1763212101, 'hopLimit': 7, 'priority': 'BACKGROUND', 'hopStart': 7, 'relayNode': 132}}
        """
        pass

    @skip_dups
    @json_log
    def on_position(self, json_data):
        pass

    @skip_dups
    @json_log
    def on_nodeinfo(self, json_data):
        pass

    @skip_dups
    @json_log
    def on_traceroute(self, json_data):
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

        pass

    @skip_dups
    @json_log
    def on_telemetry(self, json_data):
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
        pass

    @skip_dups
    @json_log
    def on_neighborinfo(self, json_data):
        #  {'from': 3031777281, 'to': 1, 'channel': 8, 'decoded':
        # {'portnum': 'NEIGHBORINFO_APP', 'payload': {'nodeId': 3031777281, 'lastSentById': 3031777281,
        # 'nodeBroadcastIntervalSecs': 300, 'neighbors':
        # [{'nodeId': 3663224352, 'snr': 10.25}]},
        # 'bitfield': 1},
        # 'id': 3781190161, 'rxTime': 1734511540, 'priority': 'BACKGROUND', 'hopStart': 7} 
        pass

    @skip_dups
    @json_log
    def on_routing(self, json_data):
        pass

    @skip_dups
    @json_log
    def on_store_forward(self, json_data):
        pass

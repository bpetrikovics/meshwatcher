import time
import logging

from .config import settings
from .models import MeshtasticPacket


class PacketStat:
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        self.cache = {}
        self.sources = {} # FIXME this is temporary
        self.counter = 0 # FIXME this is temporary
        self.dup_cleanup_time = 0

    def analyze(self, packet: MeshtasticPacket) -> bool:
        """
        Perform analysis and storage of an incoming packet.
        
        :param packet: Incoming Meshtastic MQTT paclet
        :type packet: MeshtasticPacket
        :return: True if packet is unique and should be processed further, False if duplicate
        :rtype: bool
        """
        self.logger.info("Analyzing packet %s", hex(packet.id_))

        # Random stats

        # if self.sources.get(packet.id_):
        #     self.sources[packet.id_]['count'] += 1
        #     if packet.relay_node and hex(packet.relay_node) not in self.sources[packet.id_]['relays']:
        #         self.sources[packet.id_]['relays'].append(hex(packet.relay_node))
        # else:
        #     self.sources[packet.id_] = {
        #         'count': 1,
        #         'app': packet.decoded_portnum,
        #         'relays': [hex(packet.relay_node)] if packet.relay_node else [],
        #         'responses': []
        #     }
        # if self.sources.get(packet.decoded_requestid) and packet.id_ not in self.sources[packet.decoded_requestid]['responses']:
        #     self.sources[packet.decoded_requestid]['responses'].append(packet.id_)

        # Any further raw packet handling, reporting needs to happen here
        # ...

        # Duplicate check
        if self.check_dup(packet):
            return False

        return True

    def check_dup(self, packet: MeshtasticPacket) -> bool:
        now = time.time()

        self.dup_cleanup(now)  # Cleanup cache at most once per minute

        if packet.id_ in self.cache and (now - self.cache[packet.id_] <= settings.dup_cleanup_max_age):
            self.logger.debug(f"Packet {hex(packet.id_)} is duplicate")
            self.cache[packet.id_] = now
            return True

        self.cache[packet.id_] = now

        return False

    def dup_cleanup(self, now: float):
        # Cleanup entries older than 60 seconds, but only once every dup_cleanup_period seconds
        if now - self.dup_cleanup_time >= settings.dup_cleanup_period:
            expired_keys = [k for k, ts in self.cache.items() if now - ts > settings.dup_cleanup_max_age]
            for k in expired_keys:
                del self.cache[k]
            if len(expired_keys):
                self.logger.info(f"Expired {len(expired_keys)} message IDs from dup cache")
            self.dup_cleanup_time = now

    def dump_stats(self):
        pass

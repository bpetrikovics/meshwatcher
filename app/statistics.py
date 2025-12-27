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
        Perform analysis of an incoming packet, compute statistics
        
        :param packet: Incoming Meshtastic MQTT paclet
        :type packet: MeshtasticPacket
        :return: True if packet is unique and should be processed further, False if duplicate
        :rtype: bool
        """
        self.logger.info("Analyzing packet %s received via %s->%s", hex(packet.id_), hex(packet.relay_node), packet.uplink)

        # --- Any further raw packet handling, reporting needs to happen here --- #
        # Such as: relaynode and nexthop analysis, neighbor detection

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
        # self.cache[packet.id_] = {
        #     'stamp': now,
        #     'sources': [
        #         {
        #             'uplink': packet.uplink,
        #             'relay': packet.relay_node,
        #             'nexthop': packet.nexthop,
        #             'hoplimit': packet.hop_limit,
        #             'hopstart': packet.hop_start,
        #             'rssi': packet.rx_rssi,
        #             'snr': packet.rx_snr
        #         }]}

        return False

    def dup_cleanup(self, now: float):
        # Cleanup entries older than the max age, but only once every dup_cleanup_period seconds
        if now - self.dup_cleanup_time >= settings.dup_cleanup_period:
            expired_keys = [k for k, ts in self.cache.items() if now - ts > settings.dup_cleanup_max_age]
            for k in expired_keys:
                # --- if we're writing packet stats using the cache, this is the point to save it to DB
                del self.cache[k]
            if len(expired_keys):
                self.logger.info(f"Expired {len(expired_keys)} message IDs from dup cache")
            self.dup_cleanup_time = now

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
        self.total_packets = 0
        self.unique_packets = 0

    def analyze(self, packet: MeshtasticPacket) -> bool:
        """
        Perform analysis of an incoming packet, compute statistics
        
        :param packet: Incoming Meshtastic MQTT packet
        :type packet: MeshtasticPacket
        :return: True if packet is unique and should be processed further, False if duplicate
        :rtype: bool
        """

        # check if self report; from == uplink and relay host == last 2 bytes of uplink/host
        # ignore metrics in this case
        # TODO: check if next_hop is set as it gives another neighbor connection
        if packet.uplink.lstrip('!') == f"{packet.from_:08x}":
            self.logger.info("Packet %s is self-reported/outgoing, skipping hop/path analysis", packet.id_)
        else:
            hops_taken = None
            if packet.hop_start and packet.hop_limit:
                hops_taken = packet.hop_start - packet.hop_limit

            if packet.uplink.lstrip('!') == f"{packet.to:08x}":
                self.logger.info("Packet %s arrived to final recipient, this is the last hop", hex(packet.id_))

            self.logger.info(
                "Packet %s received via %s -> %s, %s/%s hops (%s taken), SNR=%s dB, RSSI=%s dBm",
                hex(packet.id_),
                hex(packet.relay_node) if packet.relay_node else "N/A",
                packet.uplink,
                packet.hop_start if packet.hop_start else '?',
                packet.hop_limit if packet.hop_limit else '?',
                hops_taken if hops_taken else 'N/A',
                packet.rx_snr if packet.rx_snr else 'N/A',
                packet.rx_rssi if packet.rx_rssi else 'N/A',
            )

            # relay_node -> uplink rsi and snr is know at this point
            if packet.relay_node and packet.rx_snr:
                self.logger.info("Packet %s SNR metrics: 0x%02x -> %s = %s dB", hex(packet.id_), packet.relay_node, packet.uplink, packet.rx_snr)
            
            if packet.relay_node and packet.rx_rssi:
                self.logger.info("Packet %s RSSI metrics: 0x%02x -> %s = %s dBm", hex(packet.id_), packet.relay_node, packet.uplink, packet.rx_rssi)

            # from -> uplink hops taken can be computed
            if hops_taken is not None:
                self.logger.info("Packet %s Hop metrics: !%08x -> %s = %s hops", hex(packet.id_), packet.from_, packet.uplink, hops_taken)
                if hops_taken == 0:
                    # TODO: DOUBLE CHECK THIS!
                    self.logger.info("Packet %s !%08x and %s are directly connected", hex(packet.id_), packet.from_, packet.uplink)
                    if packet.relay_node is not None and f"{packet.relay_node:02x}" == f"{packet.from_:08x}"[-2:]:
                        self.logger.info("Packet %s relay_node %02x for %s is !%08x", hex(packet.id_), packet.relay_node, packet.uplink, packet.from_)

        self.total_packets += 1
        # --- Any further raw packet handling, reporting needs to happen here --- #
        # Such as: relaynode and nexthop analysis, neighbor detection

        # Duplicate check
        if self.check_dup(packet):
            return False

        self.unique_packets += 1
        return True

    def check_dup(self, packet: MeshtasticPacket) -> bool:
        now = time.time()

        self.dup_cleanup(now)  # Trigger dup cache cleanup from here - quick and dirty but no scheduler needed

        if packet.id_ in self.cache:
            if now - self.cache[packet.id_] <= settings.duplicate_detection_window:
                self.logger.debug(f"Packet {hex(packet.id_)} is duplicate")
                return True
            # Old entry, will be cleaned up by dup_cleanup()

        self.cache[packet.id_] = now
        return False

    def dup_cleanup(self, now: float):
        # Cleanup entries older than the max age, but only once every dup_cleanup_period seconds
        if now - self.dup_cleanup_time >= settings.cache_cleanup_interval:
            expired_keys = [k for k, ts in self.cache.items() if now - ts > settings.duplicate_detection_window]
            for k in expired_keys:
                # --- if we're writing packet stats using the cache, this is the point to save it to DB
                del self.cache[k]
            if len(expired_keys):
                self.logger.info(f"Expired {len(expired_keys)} message IDs from dup cache")
            self.dup_cleanup_time = now

            self.logger.info(
                "Packet stat: %s packets total, %s unique, ratio: %.2f",
                self.total_packets,
                self.unique_packets,
                self.unique_packets / self.total_packets,
            )

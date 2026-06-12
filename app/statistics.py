import time
import logging
from typing import Callable, Optional

from .config import settings
from .models import MeshtasticPacket, LinkObservation
from .link_resolver import NodeSuffixIndex


class PacketStat:
    def __init__(
        self,
        suffix_index: Optional[NodeSuffixIndex] = None,
        db_factory: Optional[Callable] = None,
    ):
        self.logger = logging.getLogger(__name__)
        self.cache = {}
        self.sources = {} # FIXME this is temporary
        self.counter = 0 # FIXME this is temporary
        self.dup_cleanup_time = time.time()  # initialise to now so first flush fires after the configured interval
        self.total_packets = 0
        self.unique_packets = 0
        self.suffix_index: NodeSuffixIndex = suffix_index if suffix_index is not None else NodeSuffixIndex()
        # db_factory follows the same pattern as EventManager: a callable that
        # returns a context manager yielding a SQLAlchemy session.  When None,
        # the real db_session is imported lazily on first flush.
        self._db_factory: Optional[Callable] = db_factory

        # --- In-memory live-stats accumulators (flushed periodically to DB) ---
        # Buffer of LinkObservation objects ready to be persisted.
        # Populated by _buffer_observation(); drained by flush_to_db().
        self._pending_observations: list[LinkObservation] = []
        # Packets transmitted per originating node since last flush.
        self.node_tx_counts: dict[str, int] = {}
        # Packets seen per channel since last flush.
        self.channel_counts: dict[int, int] = {}

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

            # from -> uplink hops taken can be computed
            if hops_taken == 0:
                self.logger.info("Packet %s !%08x and %s are directly connected", hex(packet.id_), packet.from_, packet.uplink)

            for obs in self._extract_observations(packet, hops_taken):
                self._buffer_observation(obs)

        self.total_packets += 1
        self.node_tx_counts[f"!{packet.from_:08x}"] = self.node_tx_counts.get(f"!{packet.from_:08x}", 0) + 1
        self.channel_counts[packet.channel] = self.channel_counts.get(packet.channel, 0) + 1
        # --- Any further raw packet handling, reporting needs to happen here --- #
        # Such as: relaynode and nexthop analysis, neighbor detection

        # Duplicate check
        if self.check_dup(packet):
            return False

        self.unique_packets += 1
        return True

    def _extract_observations(
        self, packet: MeshtasticPacket, hops_taken: Optional[int]
    ) -> list[LinkObservation]:
        """
        Derive LinkObservation records from a non-self-report packet.

        Three edge types are extracted:

        relay_to_uplink:  The node that relayed the packet to the uplink gateway.
                          relay_node is a 1-byte suffix — resolved via the suffix
                          index.  SNR / RSSI for this specific RF hop are known.

        from_to_uplink:   The originating node's path to the uplink gateway.
                          from_ is always a full 4-byte ID (always resolved).
                          hops_taken tells us how many mesh hops separated them.

        nexthop:          The next node the uplink intends to forward to (routing
                          hint, not a relay confirmation).  next_hop is a 1-byte
                          suffix resolved via the suffix index.
        """
        if packet.uplink.lstrip('!') == f"{packet.from_:08x}":
            raise ValueError(
                f"_extract_observations must not be called for self-report packets (packet {hex(packet.id_)})"
            )

        observations: list[LinkObservation] = []

        common: dict = dict(
            packet_id=packet.id_,
            channel=packet.channel,
            channel_name=packet.channel_name,
        )

        # --- 1. relay_node → uplink -------------------------------------------
        if packet.relay_node is not None:
            # When hops_taken == 0 the originating node relayed directly to the
            # uplink, so relay_node's suffix must belong to from_ — confirm
            # definitively without needing an index lookup.
            if hops_taken == 0 and f"{packet.relay_node:02x}" == f"{packet.from_:08x}"[-2:]:
                src_node, is_resolved = f"!{packet.from_:08x}", True
                self.logger.info(
                    "Packet %s relay_node 0x%02x confirmed as %s (direct connection)",
                    hex(packet.id_), packet.relay_node, src_node,
                )
            else:
                src_node, is_resolved = self.suffix_index.resolve(packet.relay_node)
            if packet.rx_snr is not None:
                self.logger.info("Packet %s SNR metrics: 0x%02x -> %s = %s dB", hex(packet.id_), packet.relay_node, packet.uplink, packet.rx_snr)
            if packet.rx_rssi is not None:
                self.logger.info("Packet %s RSSI metrics: 0x%02x -> %s = %s dBm", hex(packet.id_), packet.relay_node, packet.uplink, packet.rx_rssi)
            observations.append(LinkObservation(
                src_node=src_node,
                dst_node=packet.uplink,
                edge_type="relay_to_uplink",
                rx_snr=packet.rx_snr,
                rx_rssi=packet.rx_rssi,
                is_resolved=is_resolved,
                raw_suffix=None if is_resolved else packet.relay_node,
                **common,
            ))

        # --- 2. from_ → uplink ------------------------------------------------
        if hops_taken is not None:
            self.logger.info("Packet %s Hop metrics: !%08x -> %s = %s hops", hex(packet.id_), packet.from_, packet.uplink, hops_taken)
        observations.append(LinkObservation(
            src_node=f"!{packet.from_:08x}",
            dst_node=packet.uplink,
            edge_type="from_to_uplink",
            hops_taken=hops_taken,
            is_resolved=True,
            **common,
        ))

        # --- 3. uplink → next_hop (forward routing hint) ----------------------
        if packet.next_hop is not None:
            dst_node, is_resolved = self.suffix_index.resolve(packet.next_hop)
            if not is_resolved:
                # Store a compact placeholder so dst_node stays non-null.
                # Phase 7 will back-fill the real node ID once it is known.
                dst_node = f"?{packet.next_hop:02x}"
            observations.append(LinkObservation(
                src_node=packet.uplink,
                dst_node=dst_node,
                edge_type="nexthop",
                is_resolved=is_resolved,
                raw_suffix=None if is_resolved else packet.next_hop,
                **common,
            ))

        return observations

    def _buffer_observation(self, obs: LinkObservation) -> None:
        """Append a LinkObservation to the in-memory buffer for the next flush."""
        self._pending_observations.append(obs)

    def flush_to_db(self) -> int:
        """
        Persist buffered LinkObservation rows to the database and reset accumulators.

        Opens its own session so it can be called from dup_cleanup() without
        the caller needing to manage a session.  Safe to call when the buffer
        is empty (no-op).

        :return: Number of observations written.
        """
        if self._db_factory is not None:
            db_factory = self._db_factory
        else:
            # Lazy import to avoid a circular dependency at module load time.
            from .database import db_session  # noqa: PLC0415
            db_factory = db_session

        pending = self._pending_observations
        if not pending:
            return 0

        # Swap the buffer first so new observations during the flush are not lost.
        self._pending_observations = []
        saved_node_tx_counts = self.node_tx_counts
        saved_channel_counts = self.channel_counts
        self.node_tx_counts = {}
        self.channel_counts = {}

        try:
            with db_factory() as db:
                for obs in pending:
                    db.add(obs)
            self.logger.info("Flushed %d link observation(s) to database", len(pending))
        except Exception:
            # Restore unflushed observations and counts so they can be retried next cycle.
            self._pending_observations = pending + self._pending_observations
            for node, count in self.node_tx_counts.items():
                saved_node_tx_counts[node] = saved_node_tx_counts.get(node, 0) + count
            for channel, count in self.channel_counts.items():
                saved_channel_counts[channel] = saved_channel_counts.get(channel, 0) + count
            self.node_tx_counts = saved_node_tx_counts
            self.channel_counts = saved_channel_counts
            self.logger.exception("Failed to flush link observations; will retry next cycle")
            return 0

        return len(pending)

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

            self.flush_to_db()

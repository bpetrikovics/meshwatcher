"""
Tests for PacketStat._extract_observations() and the analyze() buffering path.

These tests exercise the logic that turns raw MeshtasticPacket fields into
LinkObservation objects without touching the database.
"""

from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock

import pytest

from app.link_resolver import NodeSuffixIndex
from app.models import MeshtasticPacket
from app.statistics import PacketStat


@contextmanager
def _noop_db_factory():
    """Drop-in replacement for db_session that never touches a real database."""
    yield MagicMock()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_packet(**overrides) -> MeshtasticPacket:
    """Build a minimal valid MeshtasticPacket, overridable per test."""
    defaults = {
        "id_": 0xDEADBEEF,
        "from_": 0xAB1234CD,   # node !ab1234cd, last byte = 0xcd
        "to": 0xFFFFFFFF,
        "channel": 0,
        "channel_name": "MediumFast",
        "decoded": {"portnum": "TEXT_MESSAGE_APP"},
        "uplink": "!gateway1",
        "rx_time": 1700000000,
    }
    defaults.update(overrides)
    return MeshtasticPacket.model_validate(defaults)


def _make_stat(*known_node_ids: str) -> PacketStat:
    idx = NodeSuffixIndex()
    idx.register_all(list(known_node_ids))
    return PacketStat(suffix_index=idx, db_factory=_noop_db_factory)


# ---------------------------------------------------------------------------
# Self-report: no observations emitted
# ---------------------------------------------------------------------------

def test_self_report_produces_no_observations():
    # uplink == from_ → self-reported outgoing packet
    pkt = _make_packet(**{
        "from_": 0xAB1234CD,
        "uplink": "!ab1234cd",
    })
    stat = _make_stat()
    with pytest.raises(ValueError, match="must not be called for self-report"):
        stat._extract_observations(pkt, hops_taken=None)


# ---------------------------------------------------------------------------
# from_to_uplink — always present for non-self-report packets
# ---------------------------------------------------------------------------

def test_from_to_uplink_always_produced():
    pkt = _make_packet()
    stat = _make_stat()
    obs = stat._extract_observations(pkt, hops_taken=None)
    ftu = [o for o in obs if o.edge_type == "from_to_uplink"]
    assert len(ftu) == 1


def test_from_to_uplink_fields():
    pkt = _make_packet(**{
        "from_": 0xAB1234CD,
        "uplink": "!gateway1",
        "hop_start": 5,
        "hop_limit": 3,
        "channel": 2,
        "channel_name": "LongFast",
    })
    stat = _make_stat()
    obs = stat._extract_observations(pkt, hops_taken=2)
    ftu = next(o for o in obs if o.edge_type == "from_to_uplink")

    assert ftu.src_node == "!ab1234cd"
    assert ftu.dst_node == "!gateway1"
    assert ftu.hops_taken == 2
    assert ftu.is_resolved is True
    assert ftu.raw_suffix is None
    assert ftu.channel == 2
    assert ftu.channel_name == "LongFast"
    assert ftu.packet_id == pkt.id_


def test_from_to_uplink_hops_none_when_not_computable():
    pkt = _make_packet()  # no hop_start / hop_limit
    stat = _make_stat()
    obs = stat._extract_observations(pkt, hops_taken=None)
    ftu = next(o for o in obs if o.edge_type == "from_to_uplink")
    assert ftu.hops_taken is None


# ---------------------------------------------------------------------------
# relay_to_uplink — emitted when relay_node is set
# ---------------------------------------------------------------------------

def test_relay_to_uplink_not_produced_without_relay_node():
    pkt = _make_packet()  # relay_node not set
    stat = _make_stat()
    obs = stat._extract_observations(pkt, hops_taken=None)
    assert not any(o.edge_type == "relay_to_uplink" for o in obs)


def test_relay_to_uplink_definitive_when_node_known():
    # relay_node = 0xcd, known node !ab1234cd
    pkt = _make_packet(**{
        "relay_node": 0xCD,
        "rx_snr": -13.5,
        "rx_rssi": -110,
        "uplink": "!gateway1",
    })
    stat = _make_stat("!ab1234cd")
    obs = stat._extract_observations(pkt, hops_taken=None)
    rtu = next(o for o in obs if o.edge_type == "relay_to_uplink")

    assert rtu.src_node == "!ab1234cd"
    assert rtu.dst_node == "!gateway1"
    assert rtu.is_resolved is True
    assert rtu.raw_suffix is None
    assert rtu.rx_snr == Decimal("-13.5")
    assert rtu.rx_rssi == -110


def test_relay_to_uplink_unresolved_when_node_unknown():
    pkt = _make_packet(**{"relay_node": 0xCD})
    stat = _make_stat()  # empty index
    obs = stat._extract_observations(pkt, hops_taken=None)
    rtu = next(o for o in obs if o.edge_type == "relay_to_uplink")

    assert rtu.src_node is None
    assert rtu.is_resolved is False
    assert rtu.raw_suffix == 0xCD


def test_relay_to_uplink_unresolved_when_ambiguous():
    pkt = _make_packet(**{"relay_node": 0xCD})
    stat = _make_stat("!ab1234cd", "!ef5678cd")  # two nodes share suffix
    obs = stat._extract_observations(pkt, hops_taken=None)
    rtu = next(o for o in obs if o.edge_type == "relay_to_uplink")

    assert rtu.src_node is None
    assert rtu.is_resolved is False
    assert rtu.raw_suffix == 0xCD


# ---------------------------------------------------------------------------
# nexthop — emitted when next_hop is set
# ---------------------------------------------------------------------------

def test_nexthop_not_produced_without_next_hop():
    pkt = _make_packet()  # next_hop not set
    stat = _make_stat()
    obs = stat._extract_observations(pkt, hops_taken=None)
    assert not any(o.edge_type == "nexthop" for o in obs)


def test_nexthop_definitive_when_node_known():
    pkt = _make_packet(**{
        "next_hop": 0xAB,
        "uplink": "!gateway1",
    })
    stat = _make_stat("!ff0000ab")
    obs = stat._extract_observations(pkt, hops_taken=None)
    nh = next(o for o in obs if o.edge_type == "nexthop")

    assert nh.src_node == "!gateway1"
    assert nh.dst_node == "!ff0000ab"
    assert nh.is_resolved is True
    assert nh.raw_suffix is None


def test_nexthop_unresolved_placeholder_when_unknown():
    pkt = _make_packet(**{
        "next_hop": 0xAB,
        "uplink": "!gateway1",
    })
    stat = _make_stat()  # empty index
    obs = stat._extract_observations(pkt, hops_taken=None)
    nh = next(o for o in obs if o.edge_type == "nexthop")

    assert nh.src_node == "!gateway1"
    assert nh.dst_node == "?ab"
    assert nh.is_resolved is False
    assert nh.raw_suffix == 0xAB


# ---------------------------------------------------------------------------
# Combined — all three observations when all fields are set
# ---------------------------------------------------------------------------

def test_all_three_observations_when_all_fields_present():
    pkt = _make_packet(**{
        "relay_node": 0xCD,
        "next_hop": 0xAB,
        "rx_snr": -5.0,
        "rx_rssi": -95,
        "uplink": "!gateway1",
    })
    stat = _make_stat("!ab1234cd", "!ff0000ab")
    obs = stat._extract_observations(pkt, hops_taken=3)

    types = {o.edge_type for o in obs}
    assert types == {"relay_to_uplink", "from_to_uplink", "nexthop"}


def test_only_from_to_uplink_when_no_relay_or_nexthop():
    pkt = _make_packet()  # no relay_node, no next_hop
    stat = _make_stat()
    obs = stat._extract_observations(pkt, hops_taken=None)
    assert len(obs) == 1
    assert obs[0].edge_type == "from_to_uplink"


# ---------------------------------------------------------------------------
# analyze() integration: buffering and counter increments
# ---------------------------------------------------------------------------

def test_analyze_buffers_observations_for_non_self_report():
    pkt = _make_packet(**{
        "from_": 0xAB1234CD,
        "uplink": "!gateway1",  # different from from_
        "relay_node": 0xCD,
    })
    stat = _make_stat("!ab1234cd")
    stat.analyze(pkt)
    assert len(stat._pending_observations) >= 1


def test_analyze_does_not_buffer_for_self_report():
    pkt = _make_packet(**{
        "from_": 0xAB1234CD,
        "uplink": "!ab1234cd",  # same as from_ → self-report
    })
    stat = _make_stat()
    stat.analyze(pkt)
    assert len(stat._pending_observations) == 0


def test_analyze_increments_node_tx_and_channel_counts():
    pkt = _make_packet(**{
        "from_": 0xAB1234CD,
        "channel": 3,
        "uplink": "!gateway1",
    })
    stat = _make_stat()
    stat.analyze(pkt)

    assert stat.node_tx_counts.get("!ab1234cd") == 1
    assert stat.channel_counts.get(3) == 1


def test_analyze_buffers_observations_even_for_duplicate():
    """RF link evidence is real even when the payload is a duplicate."""
    pkt = _make_packet(**{
        "from_": 0xAB1234CD,
        "uplink": "!gateway1",
    })
    stat = _make_stat()

    # First call: unique
    stat.analyze(pkt)
    count_after_first = len(stat._pending_observations)

    # Second call with the same packet: duplicate, but observations should still buffer
    stat.analyze(pkt)
    assert len(stat._pending_observations) > count_after_first


# ---------------------------------------------------------------------------
# flush_to_db: no-op when buffer is empty
# ---------------------------------------------------------------------------

def test_flush_to_db_noop_when_empty():
    stat = _make_stat()
    result = stat.flush_to_db()
    assert result == 0

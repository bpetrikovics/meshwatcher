"""
Tests for EventManager.on_neighborinfo() — Phase 5.

Verifies that NEIGHBORINFO_APP packets are parsed into LinkObservation rows
with the correct fields, that nodes are registered in the suffix index, and
that edge cases (empty/missing neighbors, bad payload) are handled gracefully.
"""

from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock, Mock, call, patch

import pytest

from app.event_manager import EventManager
from app.models import LinkObservation
from app.packet_handling import raw_handler


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

NEIGHBORINFO_JSON = {
    "from": 3031777281,
    "to": 1,
    "channel": 8,
    "channelName": "MediumFast",
    "decoded": {
        "portnum": "NEIGHBORINFO_APP",
        "payload": {
            "nodeId": 3031777281,
            "lastSentById": 3031777281,
            "nodeBroadcastIntervalSecs": 300,
            "neighbors": [
                {"nodeId": 3663224352, "snr": 10.25},
                {"nodeId": 2956776068, "snr": -3.5},
            ],
        },
        "bitfield": 1,
    },
    "id": 3781190161,
    "rxTime": 1734511540,
    "uplink": "!gateway01",
    "priority": "BACKGROUND",
    "hopStart": 7,
}


@pytest.fixture(autouse=True)
def _clear_dup_cache():
    """Ensure the global dedup cache is empty before each test."""
    raw_handler.stats.cache.clear()
    yield


@pytest.fixture
def event_manager():
    mock_mqtt = Mock()
    mock_presenter = Mock()
    mock_presenter.raw_packet_callback.__qualname__ = "mock_raw_packet_callback"
    em = EventManager(
        mqtt_client=mock_mqtt,
        db_factory=Mock(),
        presenter=mock_presenter,
    )
    return em


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_neighborinfo(em: EventManager, json_data: dict) -> list[LinkObservation]:
    """
    Call on_neighborinfo and capture the rows passed to db.add_all().
    Returns the list of LinkObservation objects, or [] if add_all was not called.
    """
    captured: list[list[LinkObservation]] = []

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        mock_db.get.return_value = MagicMock()  # simulate existing node
        mock_db.add_all.side_effect = lambda rows: captured.append(list(rows))
        yield mock_db

    em.db_factory = fake_db_factory
    em.on_neighborinfo(json_data)

    return captured[0] if captured else []


# ---------------------------------------------------------------------------
# Happy-path tests
# ---------------------------------------------------------------------------

def test_neighborinfo_creates_correct_number_of_observations(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    assert len(obs) == 2


def test_neighborinfo_edge_type(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    assert all(o.edge_type == "neighbor_report" for o in obs)


def test_neighborinfo_src_node(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    # 3031777281 == 0xb4b54001
    assert all(o.src_node == "!b4b54001" for o in obs)


def test_neighborinfo_dst_nodes(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    dst_nodes = {o.dst_node for o in obs}
    # 3663224352 == 0xda585e20, 2956776068 == 0xb03cd284
    assert dst_nodes == {"!da585e20", "!b03cd284"}


def test_neighborinfo_snr_values(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    snr_map = {o.dst_node: o.rx_snr for o in obs}
    assert snr_map["!da585e20"] == Decimal("10.25")
    assert snr_map["!b03cd284"] == Decimal("-3.5")


def test_neighborinfo_is_resolved(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    assert all(o.is_resolved is True for o in obs)


def test_neighborinfo_channel_fields(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    assert all(o.channel == 8 for o in obs)
    assert all(o.channel_name == "MediumFast" for o in obs)


def test_neighborinfo_packet_id(event_manager):
    obs = _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    assert all(o.packet_id == 3781190161 for o in obs)


# ---------------------------------------------------------------------------
# Suffix index registration
# ---------------------------------------------------------------------------

def test_neighborinfo_registers_nodes_in_suffix_index(event_manager):
    _run_neighborinfo(event_manager, NEIGHBORINFO_JSON)
    # src and both dst nodes must be registered
    assert event_manager.suffix_index.resolve(0x01)[1] is True   # !b4e0a001 suffix 01
    assert event_manager.suffix_index.resolve(0x20)[1] is True   # !da585e20 suffix 20
    assert event_manager.suffix_index.resolve(0x84)[1] is True   # !b02dbe84 suffix 84


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_neighborinfo_empty_neighbors_list(event_manager):
    data = {**NEIGHBORINFO_JSON, "decoded": {
        "portnum": "NEIGHBORINFO_APP",
        "payload": {"nodeId": 3031777281, "neighbors": []},
        "bitfield": 1,
    }}
    obs = _run_neighborinfo(event_manager, data)
    assert obs == []


def test_neighborinfo_missing_neighbors_key(event_manager):
    data = {**NEIGHBORINFO_JSON, "decoded": {
        "portnum": "NEIGHBORINFO_APP",
        "payload": {"nodeId": 3031777281},
        "bitfield": 1,
    }}
    obs = _run_neighborinfo(event_manager, data)
    assert obs == []


def test_neighborinfo_missing_payload(event_manager):
    data = {**NEIGHBORINFO_JSON, "decoded": {
        "portnum": "NEIGHBORINFO_APP",
        "bitfield": 1,
    }}
    obs = _run_neighborinfo(event_manager, data)
    assert obs == []


def test_neighborinfo_single_neighbor_missing_nodeid_is_skipped(event_manager):
    data = {**NEIGHBORINFO_JSON, "decoded": {
        "portnum": "NEIGHBORINFO_APP",
        "payload": {
            "nodeId": 3031777281,
            "neighbors": [
                {"snr": 5.0},                      # no nodeId
                {"nodeId": 2956776068, "snr": 2.0}, # valid
            ],
        },
        "bitfield": 1,
    }, "id": 3781190162}  # unique packet ID to avoid dedup
    obs = _run_neighborinfo(event_manager, data)
    assert len(obs) == 1
    assert obs[0].dst_node == "!b03cd284"

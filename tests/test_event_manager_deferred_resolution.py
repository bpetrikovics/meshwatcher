"""
Tests for EventManager._resolve_deferred_observations() — Phase 7.

Verifies that when a new node is registered via on_nodeinfo(), any previously
unresolved LinkObservation rows whose raw_suffix matches the new node's last
byte are back-filled (src_node set, is_resolved=True), but only when the
suffix is now unambiguous (exactly one candidate in the suffix index).
"""

from contextlib import contextmanager
from unittest.mock import MagicMock, Mock, call

import pytest

from app.event_manager import EventManager
from app.models import LinkObservation
from app.packet_handling import raw_handler


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clear_dup_cache():
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


def _make_unresolved_obs(raw_suffix: int) -> LinkObservation:
    """Create a minimal unresolved LinkObservation for testing."""
    return LinkObservation(
        dst_node="!gateway01",
        edge_type="relay_to_uplink",
        is_resolved=False,
        raw_suffix=raw_suffix,
        channel=0,
        channel_name="test",
    )


# ---------------------------------------------------------------------------
# _resolve_deferred_observations — direct unit tests
# ---------------------------------------------------------------------------

def _make_unresolved_nexthop_obs(raw_suffix: int, uplink: str) -> LinkObservation:
    """Create a minimal unresolved nexthop LinkObservation for testing."""
    return LinkObservation(
        src_node=uplink,
        edge_type="nexthop",
        is_resolved=False,
        raw_suffix=raw_suffix,
        channel=0,
        channel_name="test",
    )


def test_resolves_rows_when_suffix_is_unambiguous(event_manager):
    """
    When the newly registered node is the only candidate for its suffix,
    all unresolved LinkObservation rows with a matching raw_suffix are
    back-filled with src_node and is_resolved=True.
    """
    node_id = "!ab1234cd"
    raw_suffix_int = 0xCD  # int("cd", 16)

    # Register only this node so the suffix is unambiguous.
    event_manager.suffix_index.register(node_id)

    obs1 = _make_unresolved_obs(raw_suffix_int)
    obs2 = _make_unresolved_obs(raw_suffix_int)

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        mock_db.execute.return_value.scalars.return_value.all.return_value = [obs1, obs2]
        yield mock_db

    event_manager.db_factory = fake_db_factory
    event_manager._resolve_deferred_observations(node_id)

    assert obs1.src_node == node_id
    assert obs1.is_resolved is True
    assert obs2.src_node == node_id
    assert obs2.is_resolved is True


def test_does_not_resolve_when_suffix_is_ambiguous(event_manager):
    """
    When two or more nodes share the same suffix the suffix index returns
    (None, False), so no DB session is opened and no rows are modified.
    """
    node_a = "!ab1234cd"
    node_b = "!ef5678cd"  # same last byte: 0xcd

    event_manager.suffix_index.register(node_a)
    event_manager.suffix_index.register(node_b)

    db_opened = []

    @contextmanager
    def fake_db_factory():
        db_opened.append(True)
        yield MagicMock()

    event_manager.db_factory = fake_db_factory

    # Calling with either node should not open the DB because suffix is ambiguous.
    event_manager._resolve_deferred_observations(node_a)
    event_manager._resolve_deferred_observations(node_b)

    assert db_opened == [], "DB should not be opened when suffix is ambiguous"


def test_does_nothing_when_no_unresolved_rows(event_manager):
    """
    When the suffix is unambiguous but there are no unresolved rows in the DB,
    nothing is written and no exception is raised.
    """
    node_id = "!ab1234cd"
    event_manager.suffix_index.register(node_id)

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        mock_db.execute.return_value.scalars.return_value.all.return_value = []
        yield mock_db

    event_manager.db_factory = fake_db_factory
    # Should not raise.
    event_manager._resolve_deferred_observations(node_id)


def test_only_updates_rows_matching_suffix(event_manager):
    """
    Only observations whose raw_suffix matches the registered node's last byte
    are updated; rows with a different raw_suffix are left untouched.
    """
    node_id = "!ab1234cd"
    raw_suffix_cd = 0xCD
    raw_suffix_ab = 0xAB

    event_manager.suffix_index.register(node_id)

    matching_obs = _make_unresolved_obs(raw_suffix_cd)
    unrelated_obs = _make_unresolved_obs(raw_suffix_ab)
    unrelated_obs.is_resolved = False  # ensure it stays unresolved

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        # Only matching_obs is returned (DB filters by raw_suffix in the real query).
        mock_db.execute.return_value.scalars.return_value.all.return_value = [matching_obs]
        yield mock_db

    event_manager.db_factory = fake_db_factory
    event_manager._resolve_deferred_observations(node_id)

    assert matching_obs.src_node == node_id
    assert matching_obs.is_resolved is True
    # unrelated_obs was never touched.
    assert unrelated_obs.src_node is None
    assert unrelated_obs.is_resolved is False


def test_nexthop_rows_back_fill_dst_node(event_manager):
    """
    For edge_type='nexthop' rows, the resolved node ID must be written to
    dst_node (not src_node), because src_node is already the known uplink.
    """
    uplink = "!gateway01"
    node_id = "!ab1234cd"
    raw_suffix_int = 0xCD

    event_manager.suffix_index.register(node_id)

    obs = _make_unresolved_nexthop_obs(raw_suffix_int, uplink)

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        mock_db.execute.return_value.scalars.return_value.all.return_value = [obs]
        yield mock_db

    event_manager.db_factory = fake_db_factory
    event_manager._resolve_deferred_observations(node_id)

    # dst_node must be filled in; src_node must remain the uplink.
    assert obs.dst_node == node_id
    assert obs.src_node == uplink
    assert obs.is_resolved is True


def test_relay_to_uplink_rows_back_fill_src_node(event_manager):
    """
    For edge_type='relay_to_uplink' rows, the resolved node ID must be written
    to src_node (dst_node is already the known uplink).
    """
    node_id = "!ab1234cd"
    raw_suffix_int = 0xCD

    event_manager.suffix_index.register(node_id)

    obs = _make_unresolved_obs(raw_suffix_int)

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        mock_db.execute.return_value.scalars.return_value.all.return_value = [obs]
        yield mock_db

    event_manager.db_factory = fake_db_factory
    event_manager._resolve_deferred_observations(node_id)

    assert obs.src_node == node_id
    assert obs.is_resolved is True


# ---------------------------------------------------------------------------
# Integration via on_nodeinfo
# ---------------------------------------------------------------------------

NODEINFO_JSON = {
    "from": 2956776068,   # !b03cd284
    "to": 4294967295,
    "channel": 0,
    "channelName": "LongFast",
    "decoded": {
        "portnum": "NODEINFO_APP",
        "payload": {
            "id": "!b03cd284",
            "longName": "TestNode",
            "shortName": "TN",
            "hwModel": "TBEAM",
        },
    },
    "id": 123456789,
    "rxTime": 1759165000,
    "uplink": "!gateway01",
}


def test_on_nodeinfo_triggers_deferred_resolution(event_manager):
    """
    Calling on_nodeinfo() with a packet for a previously unknown node should
    trigger back-filling of unresolved LinkObservation rows that match that
    node's last byte.
    """
    node_id = "!b03cd284"
    raw_suffix_int = 0x84  # last byte of !b03cd284

    unresolved = _make_unresolved_obs(raw_suffix_int)

    db_calls = []

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        # First db_factory call is from _update_node_last_seen inside on_nodeinfo.
        # Second is from _resolve_deferred_observations.
        mock_db.get.return_value = MagicMock(
            id_=node_id,
            short_name=None,
            long_name=None,
            macaddr=None,
            hw_model=None,
            public_key=None,
            role=None,
            is_unmessagable=None,
        )
        mock_db.execute.return_value.scalars.return_value.all.return_value = [unresolved]
        db_calls.append(mock_db)
        yield mock_db

    event_manager.db_factory = fake_db_factory
    event_manager.on_nodeinfo(NODEINFO_JSON)

    # After on_nodeinfo the suffix must be in the index.
    resolved_id, is_definitive = event_manager.suffix_index.resolve(raw_suffix_int)
    assert is_definitive
    assert resolved_id == node_id

    # The unresolved observation should have been back-filled.
    assert unresolved.src_node == node_id
    assert unresolved.is_resolved is True

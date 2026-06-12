"""
Tests for EventManager.on_traceroute() — Phase 6.

Verifies that TRACEROUTE_APP response packets produce consecutive-pair
LinkObservation rows with the correct fields, that SNR values are correctly
divided by 4, that all nodes are registered in the suffix index, and that
edge cases (request packets, missing/empty route) are handled gracefully.

Packet values from the docstring example:
  from_ = 2552625594  (0x9825f9ba = mtrx, the traceroute responder)
  to    = 2956776068  (0xb03cd284 = ka8b, the original requester)
  route = [2574456035 (0x997314e3 = csh), 146503212 (0x08bb762c = csgy)]
  snrTowards = [11, -54, -4]  →  [2.75, -13.5, -1.0] dB
  Full forward path: ka8b -> csh -> csgy -> mtrx
"""

from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock, Mock

import pytest

from app.event_manager import EventManager
from app.models import LinkObservation
from app.packet_handling import raw_handler

# ---------------------------------------------------------------------------
# Packet fixtures
# ---------------------------------------------------------------------------

# Traceroute RESPONSE — has requestId and a populated route
TR_RESPONSE = {
    "from": 2552625594,        # mtrx  0x9825f9ba
    "to": 2956776068,          # ka8b  0xb03cd284
    "channel": 8,
    "channelName": "MediumFast",
    "decoded": {
        "portnum": "TRACEROUTE_APP",
        "payload": {
            "route": [2574456035, 146503212],   # csh, csgy
            "snrTowards": [11, -54, -4],
            "routeBack": [146509480],
            "snrBack": [36],
        },
        "requestId": 2363252984,
        "bitfield": 1,
    },
    "id": 3427050615,
    "rxTime": 1759165174,
    "rxSnr": -13.0,
    "hopLimit": 2,
    "wantAck": True,
    "rxRssi": -123,
    "hopStart": 3,
    "relayNode": 168,
    "uplink": "!gateway01",
}

# Traceroute REQUEST — no requestId, empty payload
TR_REQUEST = {
    "from": 2956776068,
    "to": 2552625594,
    "channel": 8,
    "channelName": "MediumFast",
    "decoded": {
        "portnum": "TRACEROUTE_APP",
        "wantResponse": True,
        "bitfield": 3,
        "payload": {},
    },
    "id": 2363252984,
    "rxTime": 1759165167,
    "hopLimit": 7,
    "wantAck": True,
    "priority": "RELIABLE",
    "hopStart": 7,
    "nextHop": 227,
    "relayNode": 132,
    "uplink": "!gateway01",
}

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


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _run_traceroute(em: EventManager, json_data: dict) -> list[LinkObservation]:
    """Call on_traceroute and return the observations passed to db.add_all()."""
    captured: list[list[LinkObservation]] = []

    @contextmanager
    def fake_db_factory():
        mock_db = MagicMock()
        mock_db.get.return_value = MagicMock()
        mock_db.add_all.side_effect = lambda rows: captured.append(list(rows))
        yield mock_db

    em.db_factory = fake_db_factory
    em.on_traceroute(json_data)
    return captured[0] if captured else []


# ---------------------------------------------------------------------------
# Happy-path: correct number and ordering of observations
# ---------------------------------------------------------------------------

def test_traceroute_produces_three_observations(event_manager):
    # full forward route: ka8b -> csh -> csgy -> mtrx  →  3 forward pairs
    # plus back route: mtrx -> jant -> ka8b  →  2 back pairs
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    assert len(obs) == 5


def test_traceroute_edge_type(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    assert [o.edge_type for o in obs] == [
        "traceroute_hop", "traceroute_hop", "traceroute_hop",
        "traceroute_hop_back", "traceroute_hop_back",
    ]


def test_traceroute_hops_taken_sequence(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    # Forward hops 0–2, back hops 0–1
    assert [o.hops_taken for o in obs] == [0, 1, 2, 0, 1]


def test_traceroute_src_dst_pairs(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    pairs = [(o.src_node, o.dst_node) for o in obs]
    assert pairs == [
        ("!b03cd284", "!997314e3"),   # ka8b -> csh      forward hop 0
        ("!997314e3", "!08bb762c"),   # csh  -> csgy     forward hop 1
        ("!08bb762c", "!9825f9ba"),   # csgy -> mtrx     forward hop 2
        ("!9825f9ba", "!08bb8ea8"),   # mtrx -> jant     back hop 0
        ("!08bb8ea8", "!b03cd284"),   # jant -> ka8b     back hop 1
    ]


def test_traceroute_snr_values_divided_by_4(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    assert obs[0].rx_snr == Decimal("2.75")    # 11 / 4
    assert obs[1].rx_snr == Decimal("-13.5")   # -54 / 4
    assert obs[2].rx_snr == Decimal("-1.0")    # -4 / 4


def test_traceroute_channel_fields(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    assert all(o.channel == 8 for o in obs)
    assert all(o.channel_name == "MediumFast" for o in obs)


def test_traceroute_packet_id(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    assert all(o.packet_id == 3427050615 for o in obs)


def test_traceroute_is_resolved(event_manager):
    obs = _run_traceroute(event_manager, TR_RESPONSE)
    assert all(o.is_resolved is True for o in obs)


# ---------------------------------------------------------------------------
# Suffix index registration
# ---------------------------------------------------------------------------

def test_traceroute_registers_all_nodes_in_suffix_index(event_manager):
    _run_traceroute(event_manager, TR_RESPONSE)
    # ka8b suffix 0x84, csh suffix 0xe3, csgy suffix 0x2c, mtrx suffix 0xba
    assert event_manager.suffix_index.resolve(0x84)[1] is True  # !b03cd284
    assert event_manager.suffix_index.resolve(0xe3)[1] is True  # !997314e3
    assert event_manager.suffix_index.resolve(0x2c)[1] is True  # !08bb762c
    assert event_manager.suffix_index.resolve(0xba)[1] is True  # !9825f9ba


# ---------------------------------------------------------------------------
# SNR missing for last hop (fewer snrTowards entries than hops)
# ---------------------------------------------------------------------------

def test_traceroute_missing_snr_entry_is_none(event_manager):
    data = dict(TR_RESPONSE)
    data["decoded"] = {
        **TR_RESPONSE["decoded"],
        "payload": {
            "route": [2574456035, 146503212],
            "snrTowards": [11],   # only one SNR value for three hops
        },
        "requestId": 2363252984,
    }
    data["id"] = 3427050616  # unique ID to avoid dedup
    obs = _run_traceroute(event_manager, data)
    assert obs[0].rx_snr == Decimal("2.75")
    assert obs[1].rx_snr is None
    assert obs[2].rx_snr is None


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------

def test_traceroute_request_with_partial_route_produces_observations(event_manager):
    """A request captured mid-flight by MQTT already has route data — extract it."""
    data = {**TR_REQUEST, "decoded": {
        "portnum": "TRACEROUTE_APP",
        "wantResponse": True,
        "bitfield": 3,
        "payload": {
            "route": [2574456035],   # one intermediate hop accumulated so far
            "snrTowards": [11],
        },
    }, "id": 3427050620}
    obs = _run_traceroute(event_manager, data)
    # from_=ka8b, to=mtrx, route=[csh]  →  ka8b->csh, csh->mtrx
    assert len(obs) == 2
    assert obs[0].src_node == "!b03cd284"  # ka8b
    assert obs[0].dst_node == "!997314e3"  # csh
    assert obs[1].src_node == "!997314e3"  # csh
    assert obs[1].dst_node == "!9825f9ba"  # mtrx


def test_traceroute_request_with_empty_payload_with_empty_payload_produces_no_observations(event_manager):
    obs = _run_traceroute(event_manager, TR_REQUEST)
    assert obs == []


def test_traceroute_empty_route_produces_no_observations(event_manager):
    data = {**TR_RESPONSE, "decoded": {
        "portnum": "TRACEROUTE_APP",
        "payload": {"route": []},
        "requestId": 2363252984,
        "bitfield": 1,
    }, "id": 3427050617}
    obs = _run_traceroute(event_manager, data)
    assert obs == []


def test_traceroute_missing_route_key_produces_no_observations(event_manager):
    data = {**TR_RESPONSE, "decoded": {
        "portnum": "TRACEROUTE_APP",
        "payload": {},
        "requestId": 2363252984,
        "bitfield": 1,
    }, "id": 3427050618}
    obs = _run_traceroute(event_manager, data)
    assert obs == []


def test_traceroute_broadcast_node_in_route_is_skipped(event_manager):
    """Hops involving 0xffffffff (broadcast) must not produce observations."""
    data = {**TR_RESPONSE, "decoded": {
        "portnum": "TRACEROUTE_APP",
        "payload": {
            "route": [0xFFFFFFFF, 146503212],   # broadcast in middle of path
            "snrTowards": [11, -54, -4],
        },
        "requestId": 2363252984,
        "bitfield": 1,
    }, "id": 3427050621}
    obs = _run_traceroute(event_manager, data)
    # full path: ka8b -> 0xffffffff -> csgy -> mtrx
    # hop 0 (ka8b->broadcast) and hop 1 (broadcast->csgy) must be dropped
    # hop 2 (csgy->mtrx) is retained
    assert len(obs) == 1
    assert obs[0].src_node == "!08bb762c"   # csgy
    assert obs[0].dst_node == "!9825f9ba"   # mtrx
    assert "!ffffffff" not in {obs[0].src_node, obs[0].dst_node}


def test_traceroute_broadcast_as_endpoint_produces_no_observations(event_manager):
    """Route where to= is broadcast: all hops involving it are dropped."""
    data = {**TR_RESPONSE,
            "to": 0xFFFFFFFF,
            "decoded": {
                "portnum": "TRACEROUTE_APP",
                "payload": {
                    "route": [2574456035],
                    "snrTowards": [11, -4],
                },
                "requestId": 2363252984,
                "bitfield": 1,
            }, "id": 3427050622}
    obs = _run_traceroute(event_manager, data)
    # full path: 0xffffffff -> csh -> mtrx
    # hop 0 (broadcast->csh) dropped; hop 1 (csh->mtrx) retained
    assert len(obs) == 1
    assert obs[0].src_node == "!997314e3"   # csh
    assert obs[0].dst_node == "!9825f9ba"   # mtrx
    """Single intermediate hop produces 2 pairs: src->hop, hop->dst."""
    data = {**TR_RESPONSE, "decoded": {
        "portnum": "TRACEROUTE_APP",
        "payload": {
            "route": [2574456035],   # one intermediate node
            "snrTowards": [8, -20],
        },
        "requestId": 2363252984,
        "bitfield": 1,
    }, "id": 3427050619}
    obs = _run_traceroute(event_manager, data)
    assert len(obs) == 2
    assert obs[0].hops_taken == 0
    assert obs[1].hops_taken == 1

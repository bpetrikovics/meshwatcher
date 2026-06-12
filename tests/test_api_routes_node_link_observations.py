import pytest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch, Mock

with patch("app.database.create_engine"), patch("app.database.init_db"):
    from app import create_app
    from app.routes import api_routes


def _make_obs_row(
    observed_at=None,
    rx_snr=None,
    rx_rssi=None,
    hops_taken=None,
    packet_id=None,
):
    """Build a mock row matching the columns returned by the observations query."""
    row = Mock()
    row.observed_at = observed_at or datetime(2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc)
    row.rx_snr = rx_snr
    row.rx_rssi = rx_rssi
    row.hops_taken = hops_taken
    row.packet_id = packet_id
    return row


@contextmanager
def _mock_db_session(rows):
    """Return a session mock whose final .all() yields `rows`."""
    session = Mock()
    query = Mock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.limit.return_value = query
    query.union_all.return_value = query
    query.all.return_value = rows
    session.query.return_value = query
    yield session


@pytest.fixture
def app():
    with patch("app.init_db"):
        _app = create_app()
    _app.config.update({"TESTING": True})
    return _app


# ---------------------------------------------------------------------------
# Parameter validation
# ---------------------------------------------------------------------------

def test_get_obs_invalid_edge_type(app):
    with app.test_request_context(
        "/api/nodes/!aabbccdd/links/bogus_type/!ff0000ab/observations",
        environ_base={"HTTP_ORIGIN": "http://localhost"},
    ):
        resp, status = api_routes.get_node_link_observations(
            "!aabbccdd", "bogus_type", "!ff0000ab"
        )
        assert status == 400
        data = resp.get_json()
        assert "error" in data


def test_get_obs_invalid_since_hours(app):
    with app.test_request_context(
        "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations?since_hours=abc",
        environ_base={"HTTP_ORIGIN": "http://localhost"},
    ):
        resp, status = api_routes.get_node_link_observations(
            "!aabbccdd", "neighbor_report", "!ff0000ab"
        )
        assert status == 400
        assert "error" in resp.get_json()


def test_get_obs_invalid_limit(app):
    with app.test_request_context(
        "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations?limit=abc",
        environ_base={"HTTP_ORIGIN": "http://localhost"},
    ):
        resp, status = api_routes.get_node_link_observations(
            "!aabbccdd", "neighbor_report", "!ff0000ab"
        )
        assert status == 400
        assert "error" in resp.get_json()


# ---------------------------------------------------------------------------
# Empty result
# ---------------------------------------------------------------------------

def test_get_obs_empty_result(app):
    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_link_observations(
                "!aabbccdd", "neighbor_report", "!ff0000ab"
            )
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["node_id"] == "!aabbccdd"
            assert data["peer_id"] == "!ff0000ab"
            assert data["edge_type"] == "neighbor_report"
            assert data["observations"] == []
            assert data["total"] == 0


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------

def test_get_obs_response_shape(app):
    row = _make_obs_row(
        observed_at=datetime(2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc),
        rx_snr=-5.0,
        rx_rssi=-88,
        hops_taken=2,
        packet_id=3427050615,
    )

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_link_observations(
                "!aabbccdd", "neighbor_report", "!ff0000ab"
            )
            assert resp.status_code == 200
            data = resp.get_json()

    assert data["node_id"] == "!aabbccdd"
    assert data["peer_id"] == "!ff0000ab"
    assert data["edge_type"] == "neighbor_report"
    assert data["total"] == 1

    obs = data["observations"][0]
    assert obs["observed_at"] == "2026-06-12T10:00:00+00:00"
    assert obs["rx_snr"] == -5.0
    assert obs["rx_rssi"] == -88
    assert obs["hops_taken"] == 2
    assert obs["packet_id"] == 3427050615


def test_get_obs_multiple_observations_returned(app):
    rows = [
        _make_obs_row(
            observed_at=datetime(2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc),
            rx_snr=-5.0, rx_rssi=-88, hops_taken=2, packet_id=1001,
        ),
        _make_obs_row(
            observed_at=datetime(2026, 6, 12, 9, 0, 0, tzinfo=timezone.utc),
            rx_snr=-8.2, rx_rssi=-92, hops_taken=1, packet_id=1002,
        ),
        _make_obs_row(
            observed_at=datetime(2026, 6, 12, 8, 0, 0, tzinfo=timezone.utc),
            rx_snr=-10.5, rx_rssi=-95, hops_taken=None, packet_id=1003,
        ),
    ]

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session(rows)):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links/relay_to_uplink/!ff0000ab/observations",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_link_observations(
                "!aabbccdd", "relay_to_uplink", "!ff0000ab"
            )
            data = resp.get_json()

    assert data["total"] == 3
    assert len(data["observations"]) == 3
    assert data["observations"][0]["rx_snr"] == -5.0
    assert data["observations"][1]["rx_snr"] == -8.2
    assert data["observations"][2]["rx_snr"] == -10.5


# ---------------------------------------------------------------------------
# Null field handling
# ---------------------------------------------------------------------------

def test_get_obs_null_snr_serialized_as_none(app):
    row = _make_obs_row(rx_snr=None, rx_rssi=None, hops_taken=None, packet_id=None)

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_link_observations(
                "!aabbccdd", "neighbor_report", "!ff0000ab"
            )
            data = resp.get_json()

    obs = data["observations"][0]
    assert obs["rx_snr"] is None
    assert obs["rx_rssi"] is None
    assert obs["hops_taken"] is None
    assert obs["packet_id"] is None


# ---------------------------------------------------------------------------
# Datetime handling
# ---------------------------------------------------------------------------

def test_get_obs_naive_datetime_coerced_to_utc(app):
    """A naive observed_at must be returned with UTC timezone info."""
    row = _make_obs_row(
        observed_at=datetime(2026, 6, 12, 10, 0, 0),  # naive
    )

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_link_observations(
                "!aabbccdd", "neighbor_report", "!ff0000ab"
            )
            data = resp.get_json()

    observed_at = data["observations"][0]["observed_at"]
    assert observed_at.endswith("+00:00") or observed_at.endswith("Z")


# ---------------------------------------------------------------------------
# Edge type enum validation
# ---------------------------------------------------------------------------

def test_get_obs_all_valid_edge_types_accepted(app):
    """Each valid edge type should be accepted without error."""
    valid_types = [
        "neighbor_report", "relay_to_uplink", "from_to_uplink",
        "traceroute_hop", "traceroute_hop_back", "nexthop",
    ]
    for et in valid_types:
        with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([])):
            with app.test_request_context(
                f"/api/nodes/!aabbccdd/links/{et}/!ff0000ab/observations",
                environ_base={"HTTP_ORIGIN": "http://localhost"},
            ):
                resp = api_routes.get_node_link_observations(
                    "!aabbccdd", et, "!ff0000ab"
                )
                assert resp.status_code == 200, f"edge_type={et} should be accepted"


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

def test_get_obs_requires_auth(app):
    """Request without authentication headers should return 401."""
    with app.test_client() as client:
        resp = client.get(
            "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations"
        )
        assert resp.status_code == 401


def test_get_obs_authenticated_allowed(app):
    """Authenticated session should be allowed."""
    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess["authenticated_browser"] = True
        resp = client.get(
            "/api/nodes/!aabbccdd/links/neighbor_report/!ff0000ab/observations",
        )
        assert resp.status_code == 200

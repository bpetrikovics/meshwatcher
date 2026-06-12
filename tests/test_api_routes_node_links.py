import pytest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch, Mock

# Mock database engine creation to avoid any database connections during import
with patch("app.database.create_engine"), patch("app.database.init_db"):
    from app import create_app
    from app.routes import api_routes


def _make_row(
    src_node,
    dst_node,
    edge_type="neighbor_report",
    observation_count=1,
    avg_snr=None,
    min_snr=None,
    max_snr=None,
    avg_rssi=None,
    observed_at=None,
    latest_snr=None,
    latest_rssi=None,
    latest_hops=None,
):
    """Build a mock row object matching the columns returned by the links query."""
    row = Mock()
    row.src_node = src_node
    row.dst_node = dst_node
    row.edge_type = edge_type
    row.observation_count = observation_count
    row.avg_snr = avg_snr
    row.min_snr = min_snr
    row.max_snr = max_snr
    row.avg_rssi = avg_rssi
    row.observed_at = observed_at or datetime(2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc)
    row.latest_snr = latest_snr
    row.latest_rssi = latest_rssi
    row.latest_hops = latest_hops
    return row


@contextmanager
def _mock_db_session(rows):
    """
    Context manager that returns a session mock whose final .all() yields `rows`.
    All intermediate query-building calls (filter, group_by, having, subquery, join)
    are transparent no-ops so the endpoint can chain them freely.
    """
    session = Mock()
    query = Mock()
    query.filter.return_value = query
    query.group_by.return_value = query
    query.having.return_value = query
    query.join.return_value = query
    query.union_all.return_value = query

    # subquery() returns a stub with a .c attribute (column accessor)
    subq_stub = Mock()
    subq_stub.c = Mock()
    query.subquery.return_value = subq_stub

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

def test_get_node_links_invalid_since_hours(app):
    with app.test_request_context(
        "/api/nodes/!aabbccdd/links?since_hours=notanumber",
        environ_base={"HTTP_ORIGIN": "http://localhost"},
    ):
        resp, status = api_routes.get_node_links("!aabbccdd")
        assert status == 400
        assert "error" in resp.get_json()


def test_get_node_links_invalid_min_observations(app):
    with app.test_request_context(
        "/api/nodes/!aabbccdd/links?min_observations=abc",
        environ_base={"HTTP_ORIGIN": "http://localhost"},
    ):
        resp, status = api_routes.get_node_links("!aabbccdd")
        assert status == 400
        assert "error" in resp.get_json()


def test_get_node_links_clamps_since_hours_above_168(app):
    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links?since_hours=9999",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links("!aabbccdd")
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["since_hours"] == 168.0


def test_get_node_links_clamps_since_hours_below_0(app):
    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links?since_hours=-5",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links("!aabbccdd")
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["since_hours"] == 0.0


def test_get_node_links_min_observations_floored_to_1(app):
    """min_observations=0 should be silently raised to 1 (no error, just clamped)."""
    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links?min_observations=0",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links("!aabbccdd")
            assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Response shape
# ---------------------------------------------------------------------------

def test_get_node_links_empty_result(app):
    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([])):
        with app.test_request_context(
            "/api/nodes/!aabbccdd/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links("!aabbccdd")
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["node_id"] == "!aabbccdd"
            assert data["edges"] == []
            assert data["connected_nodes"] == []
            assert data["total_observations"] == 0


def test_get_node_links_response_shape(app):
    node_id = "!aabbccdd"
    row = _make_row(
        src_node=node_id,
        dst_node="!ff0000ab",
        edge_type="neighbor_report",
        observation_count=12,
        avg_snr=-8.33,
        min_snr=-13.5,
        max_snr=-2.0,
        avg_rssi=-95.0,
        observed_at=datetime(2026, 6, 12, 10, 0, 0, tzinfo=timezone.utc),
        latest_snr=-5.0,
        latest_rssi=-88,
        latest_hops=None,
    )

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            assert resp.status_code == 200
            data = resp.get_json()

    assert data["node_id"] == node_id
    assert data["since_hours"] == 24.0
    assert data["total_observations"] == 12

    assert len(data["edges"]) == 1
    edge = data["edges"][0]
    assert edge["src_node"] == node_id
    assert edge["dst_node"] == "!ff0000ab"
    assert edge["edge_type"] == "neighbor_report"
    assert edge["observation_count"] == 12
    assert edge["avg_snr"] == -8.33
    assert edge["min_snr"] == -13.5
    assert edge["max_snr"] == -2.0
    assert edge["avg_rssi"] == -95

    latest = edge["latest"]
    assert latest["rx_snr"] == -5.0
    assert latest["rx_rssi"] == -88
    assert latest["hops_taken"] is None
    assert latest["observed_at"] == "2026-06-12T10:00:00+00:00"


def test_get_node_links_null_snr_fields_serialized_as_none(app):
    node_id = "!aabbccdd"
    row = _make_row(
        src_node=node_id,
        dst_node="!ff0000ab",
        observation_count=3,
    )

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    edge = data["edges"][0]
    assert edge["avg_snr"] is None
    assert edge["min_snr"] is None
    assert edge["max_snr"] is None
    assert edge["avg_rssi"] is None
    assert edge["latest"]["rx_snr"] is None
    assert edge["latest"]["rx_rssi"] is None


# ---------------------------------------------------------------------------
# connected_nodes and total_observations
# ---------------------------------------------------------------------------

def test_get_node_links_connected_nodes_collected(app):
    """Both src and dst peers (excluding the requested node) appear in connected_nodes."""
    node_id = "!aabbccdd"
    rows = [
        _make_row(src_node=node_id, dst_node="!ff0000ab", observation_count=5),
        _make_row(src_node="!11223344", dst_node=node_id, observation_count=3),
        _make_row(src_node=node_id, dst_node="!ff0000ab", edge_type="relay_to_uplink", observation_count=2),
    ]

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session(rows)):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    assert sorted(data["connected_nodes"]) == ["!11223344", "!ff0000ab"]


def test_get_node_links_total_observations_sums_all_groups(app):
    node_id = "!aabbccdd"
    rows = [
        _make_row(src_node=node_id, dst_node="!ff0000ab", observation_count=5),
        _make_row(src_node="!11223344", dst_node=node_id, observation_count=3),
    ]

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session(rows)):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    assert data["total_observations"] == 8


def test_get_node_links_unresolved_src_node_excluded_from_connected_nodes(app):
    """A row with src_node=None (unresolved) should not crash; it's excluded from connected_nodes."""
    node_id = "!aabbccdd"
    row = _make_row(src_node=None, dst_node=node_id, observation_count=2)

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    assert data["connected_nodes"] == []
    assert len(data["edges"]) == 1
    assert data["edges"][0]["src_node"] is None


def test_get_node_links_node_itself_not_in_connected_nodes(app):
    """Edges where both endpoints are the same node shouldn't pollute connected_nodes."""
    node_id = "!aabbccdd"
    row = _make_row(src_node=node_id, dst_node=node_id, observation_count=1)

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    assert data["connected_nodes"] == []


def test_get_node_links_observed_at_naive_datetime_coerced_to_utc(app):
    """A naive observed_at datetime must be returned with UTC timezone info."""
    node_id = "!aabbccdd"
    row = _make_row(
        src_node=node_id,
        dst_node="!ff0000ab",
        observed_at=datetime(2026, 6, 12, 10, 0, 0),  # naive
    )

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session([row])):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    observed_at = data["edges"][0]["latest"]["observed_at"]
    assert observed_at.endswith("+00:00") or observed_at.endswith("Z")


def test_get_node_links_multiple_edge_types_returned(app):
    node_id = "!aabbccdd"
    rows = [
        _make_row(src_node=node_id, dst_node="!ff0000ab", edge_type="neighbor_report", observation_count=4),
        _make_row(src_node=node_id, dst_node="!ff0000ab", edge_type="relay_to_uplink", observation_count=7),
        _make_row(src_node="!11223344", dst_node=node_id, edge_type="traceroute_hop", observation_count=2),
    ]

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session(rows)):
        with app.test_request_context(
            f"/api/nodes/{node_id}/links",
            environ_base={"HTTP_ORIGIN": "http://localhost"},
        ):
            resp = api_routes.get_node_links(node_id)
            data = resp.get_json()

    assert len(data["edges"]) == 3
    edge_types = {e["edge_type"] for e in data["edges"]}
    assert edge_types == {"neighbor_report", "relay_to_uplink", "traceroute_hop"}

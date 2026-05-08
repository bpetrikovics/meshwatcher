import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

# Mock database engine creation to avoid any database connections during import
with patch('app.database.create_engine'), \
     patch('app.database.init_db'):
    
    from app.models import NodeInfo, Position
    from app import create_app


@pytest.fixture
def app():
    # create_app() calls app.init_db; keep it mocked in tests to avoid real DB access.
    with patch("app.init_db"):
        app = create_app()
    app.config.update({"TESTING": True})
    return app


@pytest.fixture
def mock_positions():
    base_time = datetime.now(timezone.utc) - timedelta(hours=2)
    positions = []
    for i in range(5):
        pos = Position(
            node_id="!test",
            latitude_i=int((40.0 + i * 0.001) * 1e7),
            longitude_i=int((-75.0 + i * 0.001) * 1e7),
            altitude=100 + i * 10,
            ground_speed=i * 5,
            ground_track=int(i * 45 * 1e5),
            created_at=base_time + timedelta(minutes=i * 30),
        )
        positions.append(pos)
    return positions


def _mock_db_session_with_query_results(results):
    """Returns a context manager-like object to patch db_session()."""

    class _Ctx:
        def __enter__(self):
            session = Mock()
            query = Mock()
            state = {"limit": None}

            def _limit(n):
                state["limit"] = n
                return query

            def _all():
                if state["limit"] is None:
                    return results
                return results[: state["limit"]]

            query.filter.return_value = query
            query.order_by.return_value = query
            query.limit.side_effect = _limit
            query.all.side_effect = _all
            session.query.return_value = query
            return session

        def __exit__(self, exc_type, exc, tb):
            return False

    return _Ctx()


def test_get_node_positions_success_ordering(app, mock_positions):
    from app.routes import api_routes

    # Route queries newest-first and then reverses; mock query.all() to return newest-first
    newest_first = list(reversed(mock_positions))

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results(newest_first)):
        with app.test_request_context("/api/nodes/!test/positions?since_hours=24&max_points=2000", environ_base={"HTTP_ORIGIN": "http://localhost"}):
            resp = api_routes.get_node_positions("!test")

    assert resp.status_code == 200
    data = resp.get_json()
    assert "positions" in data
    result_positions = data["positions"]
    assert len(result_positions) == 5

    times = [p["created_at"] for p in result_positions]
    assert times == sorted(times)


def test_get_node_positions_empty(app):
    from app.routes import api_routes

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results([])):
        with app.test_request_context("/api/nodes/!empty/positions", environ_base={"HTTP_ORIGIN": "http://localhost"}):
            resp = api_routes.get_node_positions("!empty")

    assert resp.status_code == 200
    data = resp.get_json()
    assert data["positions"] == []


def test_get_node_positions_not_found_is_empty(app):
    from app.routes import api_routes

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results([])):
        with app.test_request_context("/api/nodes/!nonexistent/positions", environ_base={"HTTP_ORIGIN": "http://localhost"}):
            resp = api_routes.get_node_positions("!nonexistent")

    assert resp.status_code == 200
    data = resp.get_json()
    assert data["positions"] == []


def test_get_node_positions_legacy_limit_param_alias(app, mock_positions):
    from app.routes import api_routes

    newest_first = list(reversed(mock_positions))

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results(newest_first)):
        with app.test_request_context("/api/nodes/!test/positions?since_hours=24&limit=3", environ_base={"HTTP_ORIGIN": "http://localhost"}):
            resp = api_routes.get_node_positions("!test")

    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data["positions"]) == 3


def test_get_node_positions_caps_since_hours_to_7_days(app, mock_positions):
    from app.routes import api_routes

    newest_first = list(reversed(mock_positions))

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results(newest_first)):
        with app.test_request_context("/api/nodes/!test/positions?since_hours=999&max_points=5000", environ_base={"HTTP_ORIGIN": "http://localhost"}):
            resp = api_routes.get_node_positions("!test")

    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data["positions"]) == 5


def test_get_node_positions_invalid_params_return_400(app):
    from app.routes import api_routes

    with app.test_request_context("/api/nodes/!test/positions?since_hours=nope", environ_base={"HTTP_ORIGIN": "http://localhost"}):
        resp, status = api_routes.get_node_positions("!test")
        assert status == 400
        data = resp.get_json()
        assert "error" in data

    with app.test_request_context("/api/nodes/!test/positions?since_hours=24&max_points=nope", environ_base={"HTTP_ORIGIN": "http://localhost"}):
        resp, status = api_routes.get_node_positions("!test")
        assert status == 400
        data = resp.get_json()
        assert "error" in data


def test_get_node_positions_field_formats(app, mock_positions):
    from app.routes import api_routes

    newest_first = list(reversed(mock_positions[:1]))

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results(newest_first)):
        with app.test_request_context("/api/nodes/!test/positions?since_hours=24&max_points=1", environ_base={"HTTP_ORIGIN": "http://localhost"}):
            resp = api_routes.get_node_positions("!test")

    assert resp.status_code == 200
    data = resp.get_json()
    pos = data["positions"][0]

    assert isinstance(pos["latitude"], float)
    assert isinstance(pos["longitude"], float)
    assert isinstance(pos["radius"], float)
    assert pos["created_at"].endswith("Z") or "T" in pos["created_at"]

    assert pos["heading"] is not None
    assert isinstance(pos["heading"], (float, type(None)))
    assert pos["ground_speed_kmph"] is not None


def test_get_node_positions_authenticated_session_allowed(app, mock_positions):
    from app.routes import api_routes
    from flask import session

    newest_first = list(reversed(mock_positions[:1]))

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_query_results(newest_first)):
        # No Origin, no API key — only a browser session cookie
        with app.test_request_context("/api/nodes/!test/positions?since_hours=24&max_points=1"):
            session['authenticated_browser'] = True
            resp = api_routes.get_node_positions("!test")

    assert resp.status_code == 200


def test_get_node_positions_no_auth_returns_401(app):
    from app.routes import api_routes

    # No Origin, no session, no API key
    with app.test_request_context("/api/nodes/!test/positions"):
        resp, status = api_routes.get_node_positions("!test")
        assert status == 401
        assert resp.get_json()["error"] == "Unauthorized"

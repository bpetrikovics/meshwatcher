import pytest
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch, Mock


# Mock database engine creation to avoid any database connections during import
with patch("app.database.create_engine"), patch("app.database.init_db"):
    from app import create_app
    from app.routes import api_routes


@contextmanager
def _mock_db_session_with_results(results):
    session = Mock()

    query = Mock()
    query.filter.return_value = query
    query.order_by.return_value = query
    query.all.return_value = results

    session.query.return_value = query

    yield session


@pytest.fixture
def app():
    app = create_app()
    app.config.update({"TESTING": True})
    return app


def test_metrics_series_requires_params(app):
    with app.test_request_context("/api/nodes/!abc/metrics/series"):
        resp, status = api_routes.get_node_metrics_series("!abc")
        assert status == 400
        data = resp.get_json()
        assert "error" in data


def test_metrics_series_invalid_params(app):
    with app.test_request_context(
        "/api/nodes/!abc/metrics/series?metric_type=t&metric=m&since_hours=nope&max_points=10"
    ):
        resp, status = api_routes.get_node_metrics_series("!abc")
        assert status == 400
        data = resp.get_json()
        assert "error" in data


def test_metrics_series_enforces_max_points_contract(app):
    node_id = "!abc"

    # 101 points is the key edge case: old logic could compute step=101//100=1
    # and thus return 101 points, violating max_points.
    results = [(i, float(i)) for i in range(101)]

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_results(results)):
        with app.test_request_context(
            f"/api/nodes/{node_id}/metrics/series?metric_type=deviceMetrics&metric=batteryLevel&since_hours=24&max_points=100"
        ):
            resp = api_routes.get_node_metrics_series(node_id)
            assert resp.status_code == 200
            data = resp.get_json()

            assert data["node_id"] == node_id
            assert data["metric_type"] == "deviceMetrics"
            assert data["metric"] == "batteryLevel"
            assert data["since_hours"] == 24.0

            assert data["points"] <= 100
            assert len(data["series"]) == data["points"]


def test_metrics_series_caps_since_hours_to_7_days(app):
    node_id = "!abc"
    results = [(1, 1.0)]

    with patch("app.routes.api_routes.db_session", side_effect=lambda: _mock_db_session_with_results(results)):
        with app.test_request_context(
            f"/api/nodes/{node_id}/metrics/series?metric_type=deviceMetrics&metric=batteryLevel&since_hours=999&max_points=10"
        ):
            resp = api_routes.get_node_metrics_series(node_id)
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["since_hours"] == 168.0

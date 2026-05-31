from contextlib import contextmanager
from unittest.mock import Mock, patch


with patch("app.database.create_engine"), patch("app.database.init_db"):
    from app import create_app
    from app.config import settings
    from app.extensions import socketio


@contextmanager
def _mock_db_session_empty_nodes():
    session = Mock()
    query = Mock()

    query.count.return_value = 0
    query.scalar.return_value = 0
    query.offset.return_value = query
    query.limit.return_value = query
    query.all.return_value = []
    session.query.return_value = query

    yield session


def _create_test_app(origins: str):
    with patch.object(settings, "cors_allowed_origins", origins), patch("app.init_db"):
        app = create_app()

    app.config.update({"TESTING": True})
    return app


def test_api_preflight_allows_configured_origin():
    app = _create_test_app("https://allowed.example")
    client = app.test_client()

    response = client.options(
        "/api/nodes",
        headers={
            "Origin": "https://allowed.example",
            "Access-Control-Request-Method": "GET",
        },
    )

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "https://allowed.example"
    assert "GET" in response.headers["Access-Control-Allow-Methods"]


def test_api_get_includes_cors_header_for_allowed_origin():
    app = _create_test_app("https://allowed.example")
    client = app.test_client()

    with patch("app.routes.api_routes.db_session", new=_mock_db_session_empty_nodes):
        response = client.get("/api/nodes", headers={"Origin": "https://allowed.example"})

    assert response.status_code == 200
    assert response.headers["Access-Control-Allow-Origin"] == "https://allowed.example"


def test_api_get_omits_cors_header_for_disallowed_origin():
    app = _create_test_app("https://allowed.example")
    client = app.test_client()

    with patch("app.routes.api_routes.db_session", new=_mock_db_session_empty_nodes):
        response = client.get("/api/nodes", headers={"Origin": "https://blocked.example"})

    assert response.status_code == 200
    assert "Access-Control-Allow-Origin" not in response.headers


def test_socketio_uses_same_parsed_cors_origins():
    _create_test_app("https://allowed.example, https://other.example")

    assert socketio.server.eio.cors_allowed_origins == [
        "https://allowed.example",
        "https://other.example",
    ]
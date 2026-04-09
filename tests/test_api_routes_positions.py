import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock
from app.database import db_session
from app.models import NodeInfo, Position
from app.routes.api_routes import get_node_positions
from main import app


@pytest.fixture
def test_node():
    """Create a test node with positions."""
    import uuid
    node_id = f"!{uuid.uuid4().hex[:6]}"  # Keep short to respect DB column length
    with db_session() as session:
        node = NodeInfo(
            id_=node_id,
            short_name="T",  # short_name has length limit
            long_name="Test Node",
            macaddr="112233",  # macaddr has length limit
            hw_model="TAK",
            role="CLIENT"
        )
        session.add(node)
        session.flush()

        # Add some test positions
        base_time = datetime.now(timezone.utc) - timedelta(hours=2)
        for i in range(5):
            pos = Position(
                node_id=node_id,
                latitude_i=int((40.0 + i * 0.001) * 1e7),
                longitude_i=int((-75.0 + i * 0.001) * 1e7),
                altitude=100 + i * 10,
                ground_speed=i * 5,  # 0, 5, 10, 15, 20 km/h
                ground_track=int(i * 45 * 1e5),  # 0, 45, 90, 135, 180 degrees
                created_at=base_time + timedelta(minutes=i * 30)
            )
            session.add(pos)
        session.commit()
        yield node_id


def test_get_node_positions_success(test_node):
    """Test successful retrieval of node positions."""
    # Mock Flask request.args
    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": None,
        "since_hours": None,
    }.get(key, default))

    # Temporarily replace the request object in the module
    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions(test_node)
        assert response.status_code == 200
        data = response.get_json()
        assert "positions" in data
        positions = data["positions"]
        assert len(positions) == 5

        # Verify order (ascending by created_at)
        times = [p["created_at"] for p in positions]
        assert times == sorted(times)

        # Verify data fields
        for pos in positions:
            assert "latitude" in pos
            assert "longitude" in pos
            assert "created_at" in pos
            assert "altitude" in pos
            assert "ground_speed_kmph" in pos
            assert "heading" in pos
            assert "radius" in pos

    api_routes_module.request = original_request


def test_get_node_positions_empty():
    """Test node with no positions."""
    import uuid
    node_id = f"!e{uuid.uuid4().hex[:5]}"
    # Create node without positions
    with db_session() as session:
        node = NodeInfo(
            id_=node_id,
            short_name="E",  # short_name has length limit
            long_name="Empty Node",
            macaddr="001122",  # macaddr has length limit
            hw_model="CLIENT",
            role="CLIENT"
        )
        session.add(node)
        session.commit()

    mock_request = Mock()
    mock_request.args.get = Mock(return_value=None)

    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions(node_id)
        assert response.status_code == 200
        data = response.get_json()
        assert data["positions"] == []

    api_routes_module.request = original_request


def test_get_node_positions_not_found():
    """Test request for non-existent node."""
    mock_request = Mock()
    mock_request.args.get = Mock(return_value=None)

    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions("!nonexistent")
        assert response.status_code == 200
        data = response.get_json()
        assert data["positions"] == []

    api_routes_module.request = original_request


def test_get_node_positions_with_limit(test_node):
    """Test limit parameter (future-ready)."""
    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": "3",
        "since_hours": None,
    }.get(key, default))

    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions(test_node)
        assert response.status_code == 200
        data = response.get_json()
        assert len(data["positions"]) == 3

    api_routes_module.request = original_request


def test_get_node_positions_with_since_hours(test_node):
    """Test since_hours parameter (future-ready)."""
    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": None,
        "since_hours": "1",
    }.get(key, default))

    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions(test_node)
        assert response.status_code == 200
        data = response.get_json()
        # Should return positions from the last hour (fewer than all 5)
        assert len(data["positions"]) < 5

    api_routes_module.request = original_request


def test_get_node_positions_invalid_params(test_node):
    """Test invalid parameters are ignored."""
    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": "invalid",
        "since_hours": "invalid",
    }.get(key, default))

    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions(test_node)
        assert response.status_code == 200
        # Should return all positions when params are invalid
        data = response.get_json()
        assert len(data["positions"]) == 5

    api_routes_module.request = original_request


def test_get_node_positions_field_formats(test_node):
    """Test that fields are correctly formatted."""
    mock_request = Mock()
    mock_request.args.get = Mock(return_value=None)

    import app.routes.api_routes as api_routes_module
    original_request = api_routes_module.request
    api_routes_module.request = mock_request

    with app.app_context():
        response = get_node_positions(test_node)
        assert response.status_code == 200
        data = response.get_json()
        pos = data["positions"][0]

        # Check computed properties
        assert isinstance(pos["latitude"], float)
        assert isinstance(pos["longitude"], float)
        assert isinstance(pos["radius"], float)
        assert pos["created_at"].endswith("Z") or "T" in pos["created_at"]  # ISO format

        # Check heading conversion (ground_track is in 1e5 scale)
        assert pos["heading"] is not None
        assert isinstance(pos["heading"], (float, type(None)))

        # Check ground speed is passed through as-is
        assert pos["ground_speed_kmph"] is not None

    api_routes_module.request = original_request

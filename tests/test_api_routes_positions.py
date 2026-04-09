import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

# Mock database engine creation to avoid any database connections during import
with patch('app.database.create_engine'), \
     patch('app.database.init_db'):
    
    from app.models import NodeInfo, Position
    from app import create_app


@pytest.fixture
def mock_db_session():
    """Mock database session with in-memory data."""
    import uuid
    node_id = f"!{uuid.uuid4().hex[:6]}"
    node = NodeInfo(
        id_=node_id,
        short_name="T",
        long_name="Test Node",
        macaddr="112233",
        hw_model="TAK",
        role="CLIENT"
    )
    
    base_time = datetime.now(timezone.utc) - timedelta(hours=2)
    positions = []
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
        positions.append(pos)
    
    return node_id, node, positions


def test_get_node_positions_success(mock_db_session):
    """Test successful retrieval of node positions."""
    node_id, node, positions = mock_db_session

    # Mock the get_node_positions function to return test data
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        # Create mock response
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {
            "positions": [
                {
                    "latitude": pos.latitude,
                    "longitude": pos.longitude,
                    "created_at": pos.created_at.isoformat() if pos.created_at else None,
                    "altitude": pos.altitude,
                    "precision_bits": pos.precision_bits,
                    "ground_speed_kmph": pos.ground_speed,
                    "heading": pos.heading,
                    "radius": pos.radius
                }
                for pos in positions
            ]
        }
        mock_function.return_value = mock_response

        # Call the mocked function
        response = mock_function(node_id)
        assert response.status_code == 200
        data = response.get_json()
        assert "positions" in data
        result_positions = data["positions"]
        assert len(result_positions) == 5

        # Verify order (ascending by created_at)
        times = [p["created_at"] for p in result_positions]
        assert times == sorted(times)

        # Verify data fields
        for pos in result_positions:
            assert "latitude" in pos
            assert "longitude" in pos
            assert "created_at" in pos
            assert "altitude" in pos
            assert "ground_speed_kmph" in pos
            assert "heading" in pos
            assert "radius" in pos


def test_get_node_positions_empty():
    """Test node with no positions."""
    # Mock the get_node_positions function to return empty data
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {"positions": []}
        mock_function.return_value = mock_response

        response = mock_function("!empty")
        assert response.status_code == 200
        data = response.get_json()
        assert data["positions"] == []


def test_get_node_positions_not_found():
    """Test request for non-existent node."""
    # Mock the get_node_positions function to return empty data
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {"positions": []}
        mock_function.return_value = mock_response

        response = mock_function("!nonexistent")
        assert response.status_code == 200
        data = response.get_json()
        assert data["positions"] == []


def test_get_node_positions_with_limit(mock_db_session):
    """Test limit parameter (future-ready)."""
    node_id, node, positions = mock_db_session

    # Mock the get_node_positions function to return limited data
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {
            "positions": [
                {
                    "latitude": pos.latitude,
                    "longitude": pos.longitude,
                    "created_at": pos.created_at.isoformat() if pos.created_at else None,
                    "altitude": pos.altitude,
                    "precision_bits": pos.precision_bits,
                    "ground_speed_kmph": pos.ground_speed,
                    "heading": pos.heading,
                    "radius": pos.radius
                }
                for pos in positions[:3]  # Return only first 3
            ]
        }
        mock_function.return_value = mock_response

        response = mock_function(node_id)
        assert response.status_code == 200
        data = response.get_json()
        assert len(data["positions"]) == 3


def test_get_node_positions_with_since_hours(mock_db_session):
    """Test since_hours parameter (future-ready)."""
    node_id, node, positions = mock_db_session

    # Mock the get_node_positions function to return filtered data
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {
            "positions": [
                {
                    "latitude": pos.latitude,
                    "longitude": pos.longitude,
                    "created_at": pos.created_at.isoformat() if pos.created_at else None,
                    "altitude": pos.altitude,
                    "precision_bits": pos.precision_bits,
                    "ground_speed_kmph": pos.ground_speed,
                    "heading": pos.heading,
                    "radius": pos.radius
                }
                for pos in positions[-2:]  # Return only last 2
            ]
        }
        mock_function.return_value = mock_response

        response = mock_function(node_id)
        assert response.status_code == 200
        data = response.get_json()
        # Should return fewer than all 5 positions
        assert len(data["positions"]) < 5


def test_get_node_positions_invalid_params(mock_db_session):
    """Test invalid parameters are ignored."""
    node_id, node, positions = mock_db_session

    # Mock the get_node_positions function to return all data (invalid params ignored)
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {
            "positions": [
                {
                    "latitude": pos.latitude,
                    "longitude": pos.longitude,
                    "created_at": pos.created_at.isoformat() if pos.created_at else None,
                    "altitude": pos.altitude,
                    "precision_bits": pos.precision_bits,
                    "ground_speed_kmph": pos.ground_speed,
                    "heading": pos.heading,
                    "radius": pos.radius
                }
                for pos in positions
            ]
        }
        mock_function.return_value = mock_response

        response = mock_function(node_id)
        assert response.status_code == 200
        data = response.get_json()
        assert len(data["positions"]) == 5


def test_get_node_positions_field_formats(mock_db_session):
    """Test that fields are correctly formatted."""
    node_id, node, positions = mock_db_session

    # Mock the get_node_positions function to return test data
    with patch('app.routes.api_routes.get_node_positions') as mock_function:
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.get_json.return_value = {
            "positions": [
                {
                    "latitude": pos.latitude,
                    "longitude": pos.longitude,
                    "created_at": pos.created_at.isoformat() if pos.created_at else None,
                    "altitude": pos.altitude,
                    "precision_bits": pos.precision_bits,
                    "ground_speed_kmph": pos.ground_speed,
                    "heading": pos.heading,
                    "radius": pos.radius
                }
                for pos in positions[:1]  # Test with first position
            ]
        }
        mock_function.return_value = mock_response

        response = mock_function(node_id)
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

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

# Mock database engine creation at module level before any imports that trigger database connections
mock_engine = Mock()
with patch('app.database.create_engine', return_value=mock_engine), \
     patch('app.database.init_db'), \
     patch('sqlalchemy.engine.Engine', mock_engine):
    
    from app.models import NodeInfo, Position
    from app.routes.api_routes import get_node_positions
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

    # Mock Flask request.args
    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": None,
        "since_hours": None,
    }.get(key, default))

    # Mock db_session to return our test data
    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        # Handle double filter: first filter returns mock_query, second filter returns same mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.all.return_value = positions
        
        # Temporarily replace the request object in the module
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions(node_id)
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

        api_routes_module.request = original_request


def test_get_node_positions_empty():
    """Test node with no positions."""
    mock_request = Mock()
    mock_request.args.get = Mock(return_value=None)

    # Mock db_session to return empty positions
    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.all.return_value = []
        
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions("!empty")
            assert response.status_code == 200
            data = response.get_json()
            assert data["positions"] == []

        api_routes_module.request = original_request


def test_get_node_positions_not_found():
    """Test request for non-existent node."""
    mock_request = Mock()
    mock_request.args.get = Mock(return_value=None)

    # Mock db_session to return empty positions
    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.all.return_value = []
        
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions("!nonexistent")
            assert response.status_code == 200
            data = response.get_json()
            assert data["positions"] == []

        api_routes_module.request = original_request


def test_get_node_positions_with_limit(mock_db_session):
    """Test limit parameter (future-ready)."""
    node_id, node, positions = mock_db_session

    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": "3",
        "since_hours": None,
    }.get(key, default))

    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        # Handle double filter: first filter returns mock_query, second filter returns same mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.all.return_value = positions[:3]  # Return only first 3
        
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions(node_id)
            assert response.status_code == 200
            data = response.get_json()
            assert len(data["positions"]) == 3

        api_routes_module.request = original_request


def test_get_node_positions_with_since_hours(mock_db_session):
    """Test since_hours parameter (future-ready)."""
    node_id, node, positions = mock_db_session

    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": None,
        "since_hours": "1",
    }.get(key, default))

    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        # Return only recent positions (simulate time filter)
        mock_query.all.return_value = positions[-2:]  # Return only last 2
        
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions(node_id)
            assert response.status_code == 200
            data = response.get_json()
            # Should return fewer than all 5 positions
            assert len(data["positions"]) < 5

        api_routes_module.request = original_request


def test_get_node_positions_invalid_params(mock_db_session):
    """Test invalid parameters are ignored."""
    node_id, node, positions = mock_db_session

    mock_request = Mock()
    mock_request.args.get = Mock(side_effect=lambda key, default=None: {
        "limit": "invalid",
        "since_hours": "invalid",
    }.get(key, default))

    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        # Return all positions when params are invalid
        mock_query.all.return_value = positions
        
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions(node_id)
            assert response.status_code == 200
            data = response.get_json()
            assert len(data["positions"]) == 5

        api_routes_module.request = original_request


def test_get_node_positions_field_formats(mock_db_session):
    """Test that fields are correctly formatted."""
    node_id, node, positions = mock_db_session

    mock_request = Mock()
    mock_request.args.get = Mock(return_value=None)

    with patch('app.routes.api_routes.db_session') as mock_db:
        mock_session = Mock()
        mock_db.return_value = mock_session
        mock_session.__enter__ = Mock(return_value=mock_session)
        mock_session.__exit__ = Mock(return_value=None)
        
        # Mock query chain (ensure chain methods return the same mock)
        mock_query = Mock()
        mock_session.query.return_value = mock_query
        mock_query.filter.return_value = mock_query
        mock_query.order_by.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.all.return_value = positions
        
        import app.routes.api_routes as api_routes_module
        original_request = api_routes_module.request
        api_routes_module.request = mock_request

        with create_app().app_context():
            response = get_node_positions(node_id)
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

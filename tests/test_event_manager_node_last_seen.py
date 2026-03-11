import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch

from app.event_manager import EventManager
from app.models import NodeInfo


class TestUpdateNodeLastSeen:
    """Test cases for _update_node_last_seen helper function"""

    def setup_method(self):
        """Set up test fixtures before each test method"""
        # Mock the required dependencies for EventManager
        self.mock_mqtt_client = Mock()
        self.mock_db_factory = Mock()
        self.mock_presenter = Mock()
        
        # Configure the presenter mock to have the required __qualname__ attribute
        self.mock_presenter.raw_packet_callback.__qualname__ = "mock_raw_packet_callback"
        
        # Create event manager instance with mocked dependencies
        self.event_manager = EventManager(
            mqtt_client=self.mock_mqtt_client,
            db_factory=self.mock_db_factory,
            presenter=self.mock_presenter
        )

    @patch('app.event_manager.datetime')
    def test_update_existing_node_timestamp(self, mock_datetime):
        """Test that existing node's updated timestamp is modified"""
        # Mock current time for consistent testing
        current_time = datetime(2024, 3, 9, 22, 45, 0, tzinfo=timezone.utc)
        mock_datetime.now.return_value = current_time
        
        # Create mock database session
        mock_db = Mock()
        
        # Create existing node with old timestamp
        old_time = datetime(2024, 3, 9, 21, 45, 0, tzinfo=timezone.utc)  # 1 hour earlier
        existing_node = NodeInfo(id_="!abcdef01", updated=old_time)
        
        # Mock db.get() to return existing node
        mock_db.get.return_value = existing_node
        
        # Call the function
        result = self.event_manager._update_node_last_seen("!abcdef01", mock_db)
        
        # Verify the existing node was returned
        assert result is existing_node
        
        # Verify timestamp was updated to current time
        assert result.updated > old_time
        assert result.updated == current_time
        
        # Verify db.get was called with correct parameters
        mock_db.get.assert_called_once_with(NodeInfo, "!abcdef01")
        
        # Verify db.add was NOT called (since node existed)
        mock_db.add.assert_not_called()
        
        # Verify db.flush was NOT called (since node existed)
        mock_db.flush.assert_not_called()

    @patch('app.event_manager.datetime')
    def test_create_new_placeholder_node(self, mock_datetime):
        """Test that placeholder node is created when node doesn't exist"""
        # Mock current time for consistent testing
        current_time = datetime(2024, 3, 9, 22, 45, 0, tzinfo=timezone.utc)
        mock_datetime.now.return_value = current_time
        
        # Create mock database session
        mock_db = Mock()
        
        # Mock db.get() to return None (node doesn't exist)
        mock_db.get.return_value = None
        
        # Call the function
        result = self.event_manager._update_node_last_seen("!newnode01", mock_db)
        
        # Verify a new node was created and returned
        assert result is not None
        assert result.id_ == "!newnode01"
        assert isinstance(result.updated, datetime)
        assert result.updated.tzinfo == timezone.utc
        
        # Verify timestamp matches mocked time exactly
        assert result.updated == current_time
        
        # Verify db operations
        mock_db.get.assert_called_once_with(NodeInfo, "!newnode01")
        mock_db.add.assert_called_once_with(result)
        mock_db.flush.assert_called_once()

    def test_placeholder_node_has_required_fields(self):
        """Test that placeholder node has all required fields properly set"""
        mock_db = Mock()
        mock_db.get.return_value = None
        
        node_id = "!test1234"
        result = self.event_manager._update_node_last_seen(node_id, mock_db)
        
        # Verify required fields
        assert result.id_ == node_id
        assert result.updated is not None
        assert isinstance(result.updated, datetime)
        assert result.updated.tzinfo == timezone.utc
        
        # Verify optional fields are None/default
        assert result.short_name is None
        assert result.long_name is None
        assert result.hw_model is None
        assert result.role == "CLIENT"

    @patch('app.event_manager.datetime')
    def test_timestamp_precision(self, mock_datetime):
        """Test that timestamp uses UTC timezone with proper precision"""
        # Mock current time
        fixed_time = datetime(2024, 3, 9, 22, 45, 0, tzinfo=timezone.utc)
        mock_datetime.now.return_value = fixed_time
        
        mock_db = Mock()
        mock_db.get.return_value = None
        
        result = self.event_manager._update_node_last_seen("!timeTest", mock_db)
        
        # Verify exact timestamp
        assert result.updated == fixed_time
        assert result.updated.tzinfo == timezone.utc

    def test_database_error_handling_get(self):
        """Test error handling when db.get() fails"""
        mock_db = Mock()
        mock_db.get.side_effect = Exception("Database connection failed")
        
        # Should propagate the database error
        with pytest.raises(Exception, match="Database connection failed"):
            self.event_manager._update_node_last_seen("!errorTest", mock_db)

    def test_database_error_handling_flush(self):
        """Test error handling when db.flush() fails"""
        mock_db = Mock()
        mock_db.get.return_value = None
        mock_db.flush.side_effect = Exception("Flush failed")
        
        # Should propagate the flush error
        with pytest.raises(Exception, match="Flush failed"):
            self.event_manager._update_node_last_seen("!flushTest", mock_db)
        
        # Verify node was still added before flush failure
        mock_db.add.assert_called_once()

    @patch('app.event_manager.datetime')
    def test_multiple_calls_same_node(self, mock_datetime):
        """Test multiple calls to same node update timestamp correctly"""
        # Mock time to avoid race conditions
        initial_time = datetime(2024, 3, 9, 22, 45, 0, tzinfo=timezone.utc)
        second_time = datetime(2024, 3, 9, 22, 45, 10, tzinfo=timezone.utc)  # 10 seconds later
        
        mock_datetime.now.return_value = initial_time
        
        mock_db = Mock()
        
        # Create node with initial timestamp
        existing_node = NodeInfo(id_="!multicall", updated=initial_time)
        mock_db.get.return_value = existing_node
        
        # First call
        result1 = self.event_manager._update_node_last_seen("!multicall", mock_db)
        first_update_time = result1.updated
        
        # Update mock to return different time for second call
        mock_datetime.now.return_value = second_time
        
        # Reset mock to track new calls
        mock_db.reset_mock()
        mock_db.get.return_value = result1  # Return the updated node
        
        # Second call
        result2 = self.event_manager._update_node_last_seen("!multicall", mock_db)
        
        # Verify same object is returned
        assert result1 is result2
        
        # Verify timestamp was updated again
        assert result2.updated > first_update_time
        assert result2.updated == second_time
        
        # Verify only db.get was called (no add or flush since node existed)
        mock_db.get.assert_called_once_with(NodeInfo, "!multicall")
        mock_db.add.assert_not_called()
        mock_db.flush.assert_not_called()

    def test_different_node_ids(self):
        """Test function works with various node ID formats"""
        mock_db = Mock()
        mock_db.get.return_value = None  # All nodes are new
        
        test_node_ids = [
            "!abcdef01",
            "!12345678", 
            "!00000001",
            "!ffffffff",
            "!node1234"
        ]
        
        for node_id in test_node_ids:
            # Reset mock for each call
            mock_db.reset_mock()
            
            result = self.event_manager._update_node_last_seen(node_id, mock_db)
            
            # Verify node was created with correct ID
            assert result.id_ == node_id
            assert isinstance(result.updated, datetime)
            
            # Verify database operations
            mock_db.get.assert_called_once_with(NodeInfo, node_id)
            mock_db.add.assert_called_once()
            mock_db.flush.assert_called_once()

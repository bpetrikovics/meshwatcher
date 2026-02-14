from .connection_handlers import register_connection_handlers


def register_socketio_handlers() -> None:
    """Register all Socket.IO event handlers."""
    register_connection_handlers()

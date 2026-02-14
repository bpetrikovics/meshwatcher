import logging

from flask import Flask
from flask_socketio import SocketIO

logger = logging.getLogger(__name__)

socketio = SocketIO(cors_allowed_origins="*")


def init_socketio(app: Flask) -> None:
    """Initialize Socket.IO extension with the Flask app."""
    try:
        if not app.config.get('SECRET_KEY'):
            raise ValueError("SECRET_KEY must be set for Socket.IO")
        
        socketio.init_app(app)
        logger.info("Socket.IO initialized successfully")
    except Exception as e:
        logger.error("Failed to initialize Socket.IO: %s", e)
        raise

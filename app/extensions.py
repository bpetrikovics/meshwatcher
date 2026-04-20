import logging

from flask import Flask
from flask_socketio import SocketIO

from app.config import settings

logger = logging.getLogger(__name__)

socketio = SocketIO(async_mode='threading')


def init_socketio(app: Flask) -> None:
    """Initialize Socket.IO extension with the Flask app."""
    try:
        if not app.config.get('SECRET_KEY'):
            raise ValueError("SECRET_KEY must be set for Socket.IO")
        
        socketio.init_app(
            app,
            cors_allowed_origins=settings.parsed_cors_allowed_origins,
        )
        logger.info("Socket.IO initialized successfully")
    except Exception as e:
        logger.error("Failed to initialize Socket.IO: %s", e)
        raise

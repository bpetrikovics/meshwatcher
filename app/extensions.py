import logging

from flask import Flask, request
from flask_socketio import SocketIO
from flask_limiter import Limiter

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


def _rate_limit_key() -> str:
    """Key on API key identity when present, otherwise client IP.

    API key clients get their own counter so provisioned tools are not throttled
    by the same bucket as browser sessions or unauthenticated probes.
    Reads X-Forwarded-For first so the real IP is used when sitting behind nginx.
    """
    api_key = request.headers.get("X-API-Key")
    if api_key:
        return f"key:{api_key}"
    forwarded = request.headers.get("X-Forwarded-For", "")
    ip = forwarded.split(",")[0].strip() if forwarded else request.remote_addr
    return f"ip:{ip}"


limiter = Limiter(key_func=_rate_limit_key)


def init_limiter(app: Flask) -> None:
    """Initialize Flask-Limiter. Disabled by default; set RATE_LIMIT_BACKEND to enable."""
    enabled = settings.rate_limit_backend != "disabled"
    app.config["RATELIMIT_ENABLED"] = enabled
    # Use memory:// as placeholder when disabled so init_app doesn't complain
    app.config["RATELIMIT_STORAGE_URI"] = settings.rate_limit_backend if enabled else "memory://"
    limiter.init_app(app)
    if enabled:
        logger.info("Rate limiting enabled (backend=%s)", settings.rate_limit_backend)
    else:
        logger.debug("Rate limiting disabled")

import logging

from flask import request

from app.config import settings
from app.extensions import socketio

logger = logging.getLogger(__name__)


def _handle_connect_default() -> None:
    """Handle default namespace connection."""
    pass


def _handle_disconnect_default() -> None:
    """Handle default namespace disconnection."""
    pass


def _handle_connect_packets() -> None:
    """Handle packets namespace connection."""
    sid = request.sid
    logger.info("Client connected with sid %s", sid)


def _handle_disconnect_packets() -> None:
    """Handle packets namespace disconnection."""
    sid = request.sid
    logger.info("Disconnection from sid %s", sid)


def _handle_connect_events() -> None:
    """Handle events namespace connection."""
    sid = request.sid
    logger.info("Client connected to events with sid %s", sid)

    # Emit version information for frontend comparison
    socketio.emit("event", {
        "type": "version",
        "payload": {"git_commit": settings.git_commit}
    }, namespace=settings.namespace_events)


def _handle_disconnect_events() -> None:
    """Handle events namespace disconnection."""
    sid = request.sid
    logger.info("Events disconnection from sid %s", sid)


def register_connection_handlers() -> None:
    """Register connection and disconnection handlers for all namespaces."""
    socketio.on_event("connect", _handle_connect_default)
    socketio.on_event("disconnect", _handle_disconnect_default)

    socketio.on_event("connect", _handle_connect_packets, namespace=settings.namespace_packets)
    socketio.on_event("disconnect", _handle_disconnect_packets, namespace=settings.namespace_packets)

    socketio.on_event("connect", _handle_connect_events, namespace=settings.namespace_events)
    socketio.on_event("disconnect", _handle_disconnect_events, namespace=settings.namespace_events)

import logging
from flask_socketio import SocketIO

from app.config import settings
from .models import MeshtasticPacket

class Presenter:
    def __init__(self, socketio: SocketIO):
        self.logger = logging.getLogger(__name__)
        self.socketio = socketio

    def raw_packet_callback(self, packet: MeshtasticPacket):
        self.logger.info("Raw callback got data: %s", packet)
        self.socketio.emit('rawlog', packet.model_dump_json(), namespace=settings.namespace_rawdata)

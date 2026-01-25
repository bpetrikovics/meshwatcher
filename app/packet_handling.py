import logging
import json

from typing import Any, Callable

from pydantic import ValidationError

from .config import settings
from .models import MeshtasticPacket
from .statistics import PacketStat
from .database import db_session

logger = logging.getLogger(__name__)


class RawPacketHandler:
    def __init__(self):
        self.stats = PacketStat()
        self.callbacks = {}

    def register_callback(self, cb_type: str, callback: Callable):
        logger.info("Registering '%s' callback: %s", cb_type, callback.__qualname__)
        if cb_type not in self.callbacks:
            self.callbacks[cb_type] = []

        self.callbacks[cb_type].append(callback)

    def validate_packet(self, method):
        """
        Multipurpose handler decorator for mqtt callback functions.

        - Log raw incoming data
        - Validate packets against schema
        - Perform packet level logging, statistics and deduplication
        - Calls any low packet level callbacks
        - Passes the packet on to the wrapper callback

            At the end, MQTT callback functions should receive deduplicated packets only.
        """
        def wrapper(target_self, json_data: Any) -> MeshtasticPacket:
            if settings.packet_json_log:
                logger.info("Raw packet: %s", json_data)

            packet = None
            try:
                packet = MeshtasticPacket.model_validate_json(json.dumps(json_data))
            except ValidationError as exc:
                logger.exception(exc)
                logger.error("Validation failed for packet, skipping: %s", json_data)
                return

            if settings.packet_sql_log:
                logger.info("Saving packet to database: %s", packet)
                with db_session() as db:
                    db.add(packet)
                    # create a detached copy of the packet that can be passed on to callbacks
                    db.flush()
                    db.refresh(packet)
                    db.expunge(packet)

            # Invoke any callbacks that require raw data
            for callback in self.callbacks.get('raw', []):
                callback(packet)

            if self.stats.analyze(packet):
                logger.info(packet)
            else:
                # For duplicates or errors, stop processing here and return
                return

            # Only unique and valid packets remaining here

            # Proceed and pass on packet to event manager callback
            return method(target_self, packet)
        return wrapper


raw_handler = RawPacketHandler()

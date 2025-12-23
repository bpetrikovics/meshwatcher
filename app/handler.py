import logging
import json

from typing import Any

from pydantic import ValidationError

from .config import settings
from .models import MeshtasticPacket
from .statistics import PacketStat
from .database import get_db

logger = logging.getLogger(__name__)

# This module will have its own DB session
db = get_db()
stats = PacketStat()

def callback_handler(method):
    """
    Multipurpose handler decorator for mqtt callback functions.

    - Log raw incoming data
    - Validate packets against schema
    - Perform packet level logging, statistics and deduplication
    - Calls any low packet level callbacks
    - Passes the packet on to the wrapper callback

        At the end, MQTT callback functions should receive deduplicated packets only.
    """
    def wrapper(self, json_data: Any) -> MeshtasticPacket:
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
            try:
                db.add(packet)
                db.commit()
            except Exception as exc:
                logger.exception("Packet save transaction failed and was rolled back: %s", exc)
                db.rollback()

        if stats.analyze(packet):
            logger.info(packet)
        else:
            # For duplicates or errors, stop processing here and return
            return

        # Proceed and pass on packet to event manager callback
        return method(self, packet)
    return wrapper


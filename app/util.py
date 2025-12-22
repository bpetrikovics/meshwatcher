import logging
import json

from functools import wraps
from typing import Type, Any

from pydantic import ValidationError

from .config import settings
from .models import MeshtasticPacket
from .statistics import PacketStat
from .database import get_db

logger = logging.getLogger(__name__)
stats = PacketStat()
db = get_db()


def callback_handler(method):
    """
    Multipurpose handler decorator for mqtt callback functions.
    - Log raw incoming data
    - Validate packets against schema
    - Perform packet level logging, statistics and deduplication
    - Extracts and validates app-specific payload and passes it on to the
      wrapped handler method.
    """
    def wrapper(self, json_data: Any) -> MeshtasticPacket:
        if settings.packet_json_log:
            logger.info("Processing raw packet: %s", json_data)

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

        stats.add_packet(packet)

        # Won't log all - we should do stat, dedup and ONLY THEN
        logger.info(packet)

        # Call original callback with DataObject instead of raw json_data
        return method(self, packet)
    return wrapper


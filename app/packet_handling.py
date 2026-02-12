import logging
import json
from decimal import Decimal

from typing import Any, Callable, Optional

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

    def validate_packet(self, method: Optional[Callable] = None, *, dedup: bool = True):
        """
        Multipurpose handler decorator for mqtt callback functions.

        - Log raw incoming data
        - Validate packets against schema
        - Perform packet level logging, statistics and deduplication
        - Calls any low packet level callbacks
        - Passes the packet on to the wrapper callback
        """
        def decorator(method: Callable):
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

                # Always check for duplicates to mark the packet, but only filter if dedup was requested
                is_duplicate = not self.stats.analyze(packet)
                packet._is_duplicate = is_duplicate

                if settings.packet_sql_log:
                    logger.debug("Saving packet to database: %s", packet)
                    with db_session() as db:
                        db.add(packet)
                        # create a detached copy of the packet that can be passed on to callbacks
                        db.flush()
                        db.refresh(packet)
                        if packet.rx_snr is not None and not isinstance(packet.rx_snr, Decimal):
                            packet.rx_snr = Decimal(str(packet.rx_snr))
                        db.expunge(packet)
                        # Ensure _is_duplicate survives the database operations
                        packet._is_duplicate = is_duplicate

                # Invoke any callbacks that require raw data
                for callback in self.callbacks.get('raw', []):
                    callback(packet)
                
                if dedup and is_duplicate:
                    logger.debug("Packet %s is a duplicate, skipping", packet.id_)
                    return

                logger.info(packet)

                # Proceed and pass on packet to event manager callback
                return method(target_self, packet)
            return wrapper

        if method is not None:
            return decorator(method)
        return decorator


raw_handler = RawPacketHandler()

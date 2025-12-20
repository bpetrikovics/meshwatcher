import logging

from .config import settings

logger = logging.getLogger(__name__)

def skip_dups(method):
    def wrapper(self, json_data, *args, **kwargs):
        if self.check_dup(json_data):
            return
        return method(self, json_data, *args, **kwargs)
    return wrapper

def json_log(method):
    def wrapper(self, json_data, *args, **kwargs):
        if settings.packet_json_log:
            logger.info("Packet log: %s", json_data)
        return method(self, json_data, *args, **kwargs)
    return wrapper

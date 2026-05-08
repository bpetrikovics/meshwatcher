import logging
import os
from typing import Optional

import yaml

from app.config import settings

logger = logging.getLogger(__name__)

# key value -> client name
_keys: dict[str, str] = {}


def load_api_keys() -> None:
    """Load API keys from YAML file indicated by API_KEYS_FILE env var.

    Warns and continues with no valid keys if the env var is absent,
    the file is missing, or the YAML is malformed.
    """
    global _keys
    _keys = {}

    path = os.environ.get("API_KEYS_FILE")
    if not path:
        logger.warning("API_KEYS_FILE not set — no API keys loaded, non-browser access will be rejected")
        return

    try:
        with open(path, "r") as f:
            data = yaml.safe_load(f)
    except FileNotFoundError:
        logger.warning("API_KEYS_FILE '%s' not found — no API keys loaded", path)
        return
    except yaml.YAMLError as exc:
        logger.warning("Failed to parse API keys file '%s': %s — no API keys loaded", path, exc)
        return

    if not isinstance(data, list):
        logger.warning("API keys file '%s' must be a YAML list — no API keys loaded", path)
        return

    loaded = 0
    for entry in data:
        key = entry.get("key") if isinstance(entry, dict) else None
        name = entry.get("name") if isinstance(entry, dict) else None
        if key and name:
            _keys[str(key)] = str(name)
            loaded += 1
        else:
            logger.warning("Skipping invalid API key entry (missing key or name): %s", entry)

    logger.info("Loaded %d API key(s) from '%s'", loaded, path)


def validate_key(key: str) -> Optional[str]:
    """Return the client name for a valid key, or None if invalid."""
    return _keys.get(key)


def is_origin_allowed(origin: Optional[str]) -> bool:
    """Return True if the given origin is trusted per CORS configuration."""
    if not origin:
        return False
    allowed = settings.parsed_cors_allowed_origins
    if allowed == "*":
        return True
    if isinstance(allowed, list):
        return origin in allowed
    return False



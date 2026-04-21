from typing import Union

from pydantic import ConfigDict
from pydantic_settings import BaseSettings

class Settings(BaseSettings):

    # Application
    url_base: str = "/"
    git_commit: str = "(unknown version)"
    flask_secret_key: str = "meshtastic!"

    # Database
    mysql_user: str = "meshwatcher"
    mysql_password: str = "put your password here"
    mysql_host: str = "127.0.0.1"
    mysql_port: int = 3306
    mysql_db: str = "meshwatcher"

    # MQTT
    mqtt_server: str = "mqtt.creativo.hu"
    mqtt_port: int = 1883
    mqtt_username: str = "meshdev"
    mqtt_password: str = "large4cats"
    mqtt_root_topic: str = "msh/EU_868/HU/2/e/"
    mqtt_channels: dict = {'MediumFast': {'key': 'AQ=='}}

    # Data retention (days)
    node_retention_days: int = 14
    packet_retention_days: int = 7
    metrics_retention_days: int = 7
    message_retention_days: int = 7
    telemetry_retention_days: int = 7
    db_cleanup_period_minutes: int = 30

    # Performance
    cache_cleanup_interval: int = 60  # Cache cleanup interval (minutes)
    duplicate_detection_window: int = 30  # Duplicate packet detection (seconds)
    node_cache_ttl_seconds: int = 1800  # Node cache TTL

    # Logging
    packet_json_log: bool = False  # Log packets to stdout as JSON
    packet_sql_log: bool = False  # Store raw packets in database
    raw_telemetry_log: bool = False  # Store raw telemetry packets

    # Operations
    readonly_mode: bool = False  # Disable database writes

    # UI status thresholds (hours)
    status_currently_active_hours: int = 24
    status_recently_active_hours: int = 72

    # WebSocket
    namespace_packets: str = "/packets"
    namespace_events: str = "/events"
    event_flash_ms: int = 3000
    cors_allowed_origins: str = "*"
    
    # Map clustering (pixels) - sensible default can be 5
    clustering_radius: int = 0  # 0 = spiderfying only, >0 = clustering radius

    # Features
    event_animations_enabled: bool = True  # Future: event-driven animations

    model_config = ConfigDict(
        env_file=".env",
        extra="ignore",
    )

    @property
    def parsed_cors_allowed_origins(self) -> Union[str, list[str]]:
        """Normalize configured origins for Flask-CORS and Socket.IO."""
        if self.cors_allowed_origins.strip() == "*":
            return "*"

        origins = [
            origin.strip()
            for origin in self.cors_allowed_origins.split(",")
            if origin.strip()
        ]
        return origins or "*"

# Create a single instance of settings to be used application-wide
settings = Settings()

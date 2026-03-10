from pydantic import ConfigDict
from pydantic_settings import BaseSettings

class Settings(BaseSettings):

    url_base: str = "/"

    git_commit: str = "(unknown version)"
    flask_secret_key: str = "meshtastic!"

    mysql_user: str = "meshwatcher"
    mysql_password: str = "put your password here"
    mysql_host: str = "127.0.0.1"
    mysql_port: int = 3306
    mysql_db: str = "meshwatcher"

    mqtt_server: str = "mqtt.creativo.hu"
    mqtt_port: int = 1883
    mqtt_username: str = "meshdev"
    mqtt_password: str = "large4cats"
    mqtt_root_topic: str = "msh/EU_868/HU/2/e/"
    mqtt_channels: dict = {'MediumFast': {'key': 'AQ=='}}

    node_retention_days: int = 14
    packet_retention_days: int = 7
    metrics_retention_days: int = 7
    message_retention_days: int = 7
    telemetry_retention_days: int = 7
    db_cleanup_period_minutes: int = 30

    cache_cleanup_interval: int = 60 # Clean up cache every N minutes
    duplicate_detection_window: int = 30 # Detect duplicate packets within N seconds

    packet_json_log: bool  = False # Log packets to stdout in JSON format
    packet_sql_log: bool = False # Log raw packets to database (e.g. not just processed data)
    raw_telemetry_log: bool = False # Log raw telemetry packets to database (e.g. not just extracted metrics)

    readonly_mode: bool = False # Disable write operations to the database

    # Status thresholds in hours (following existing pattern)
    status_currently_active_hours: int = 24  # Hours threshold for currently active nodes
    status_recently_active_hours: int = 72  # Hours threshold for recently active nodes

    namespace_packets: str = "/packets"

    node_cache_ttl_seconds: int = 1800

    # Clustering configuration
    clustering_enabled: bool = True  # Enable/disable node clustering
    clustering_max_zoom: int = 12  # Zoom level where clustering stops (earlier than before)
    clustering_min_zoom: int = 0  # Zoom level where clustering starts
    clustering_max_distance_meters: int = 300  # Max distance in meters for clustering
    clustering_min_cluster_size: int = 2  # Minimum nodes to form a cluster
    clustering_adaptive_density: bool = True  # Adjust clustering based on node density
    clustering_chunked_loading: bool = False  # Load all nodes at once for simplicity
    clustering_spiderfy_on_max_zoom: bool = True  # Auto-expand at max zoom
    clustering_handle_overlapping: bool = True  # Auto-spread overlapping nodes when clustering stops

    clustering_min_radius_pixels: int = 10
    clustering_max_radius_pixels: int = 100
    clustering_density_scale: float = 0.5
    clustering_boundary_delay_ms: int = 100
    clustering_boundary_detection: bool = True

    model_config = ConfigDict(
        env_file=".env",  # Optional: loads environment variables from a .env file
        extra="ignore",   # Ignore env variables we're unaware of
    )

# Create a single instance of settings to be used application-wide
settings = Settings()

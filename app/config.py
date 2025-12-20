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
    mqtt_username: str = "meshdev"
    mqtt_password: str = "large4cats"
    mqtt_root_topic: str = "msh/EU_868/HU/2/e/"
    mqtt_channels: dict = {'MediumFast': {'key': 'AQ=='}}

    node_cleanup_days: int = 3
    dup_cleanup_period: int = 60
    dup_cleanup_max_age: int = 120

    packet_json_log: bool  = True
    readonly_mode: bool = False

    class Config:
        env_file = ".env"  # Optional: loads environment variables from a .env file
        extra = "ignore"   # Ignore env variables we're unaware of

# Create a single instance of settings to be used application-wide
settings = Settings()

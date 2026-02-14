import atexit
import logging

from meshtastic_mqtt_json import MeshtasticMQTT

from app import create_app
from app.config import settings
from app.database import db_session, get_cleanup_manager
from app.event_manager import EventManager
from app.presenter import Presenter
from app.extensions import socketio


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("main")

app = create_app()

cleanup_manager = get_cleanup_manager()  # Starts background thread automatically
atexit.register(cleanup_manager.stop) # Stop background thread on exit

meshtastic_mqtt = MeshtasticMQTT()
meshtastic_mqtt.connect(
    broker=settings.mqtt_server,
    port=settings.mqtt_port,
    root=settings.mqtt_root_topic,
    channels=settings.mqtt_channels,
    username=settings.mqtt_username,
    password=settings.mqtt_password,
)
presenter = Presenter(socketio=socketio, db_factory=db_session)

# Main app and all MQTT callbacks will share their separate DB session
app.manager = EventManager(
    mqtt_client=meshtastic_mqtt, db_factory=db_session, presenter=presenter
)

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=8080)

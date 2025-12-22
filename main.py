import logging

from flask import render_template
from flask_socketio import SocketIO

from meshtastic_mqtt_json import MeshtasticMQTT

from app import create_app
from app.config import settings
from app.database import get_db
from app.tracker import Tracker

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("main")

app = create_app()

meshtastic_mqtt = MeshtasticMQTT()
db_session = get_db()

meshtastic_mqtt.connect(
    broker=settings.mqtt_server,
    port=settings.mqtt_port,
    root=settings.mqtt_root_topic,
    channels=settings.mqtt_channels,
    username=settings.mqtt_username,
    password=settings.mqtt_password,
)

socketio = SocketIO(app)

app.tracker = Tracker(mqtt_client=meshtastic_mqtt, db_session=db_session)


@app.route('/')
def index():
    return render_template('index.html', version=settings.git_commit)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=8080)

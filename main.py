import logging

from flask import render_template, request
from flask_socketio import SocketIO, emit

from meshtastic_mqtt_json import MeshtasticMQTT

from app import create_app
from app.config import settings
from app.database import get_db, get_cleanup_manager
from app.event_manager import EventManager
from app.presenter import Presenter


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
logger = logging.getLogger("main")

app = create_app()

db_session = get_db()
cleanup_manager = get_cleanup_manager()  # Starts background thread automatically

meshtastic_mqtt = MeshtasticMQTT()
meshtastic_mqtt.connect(
    broker=settings.mqtt_server,
    port=settings.mqtt_port,
    root=settings.mqtt_root_topic,
    channels=settings.mqtt_channels,
    username=settings.mqtt_username,
    password=settings.mqtt_password,
)

socketio = SocketIO(app, cors_allowed_origins="*")
presenter = Presenter(socketio)

# Main app and all MQTT callbacks will share their separate DB session
app.manager = EventManager(
    mqtt_client=meshtastic_mqtt, db_session=db_session, presenter=presenter
)

# SHould this move into Presenter e.g. socketio.on_event('connect, my_function, namespace=...)

@socketio.on('connect')
def handle_connect_default():
    # store the sid so we can later send session specific content
    sid = request.sid

@socketio.on('disconnect')
def handle_disconnect_default():
    pass

@socketio.on('connect', settings.namespace_rawdata)
def handle_connect_rawdata():
    # store the sid so we can later send session specific content
    sid = request.sid
    logger.info("Client connected with sid %s", sid)

@socketio.on('disconnect', settings.namespace_rawdata)
def handle_disconnect_rawdata():
    sid = request.sid
    logger.info("Disconnection from sid %s", sid)

@app.route('/')
def index():
    return render_template('index.html', version=settings.git_commit)

@app.route(settings.namespace_rawdata)
def log():
    return render_template('log.html', settings=settings)

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=8080)

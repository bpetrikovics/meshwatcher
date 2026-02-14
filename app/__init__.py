from flask import Flask

from .database import init_db
from .config import settings
from .extensions import init_socketio
from .routes import register_blueprints
from .websockets import register_socketio_handlers


def create_app() -> Flask:
    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config['SECRET_KEY'] = settings.flask_secret_key

    # Init DB after config - create tables if needed
    with app.app_context():
        init_db()

    init_socketio(app)
    register_blueprints(app)
    register_socketio_handlers()

    return app

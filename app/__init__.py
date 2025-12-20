from flask import Flask

from .database import init_db
from .config import settings

def create_app():
    app = Flask(__name__, template_folder="../templates", static_folder="../static")
    app.config['SECRET_KEY'] = settings.flask_secret_key

    # Init DB after config - create tables if needed
    with app.app_context():
        init_db()

    return app

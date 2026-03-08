from flask import Flask

from .main_routes import bp as main_bp
from .api_routes import bp as api_bp


def register_blueprints(app: Flask) -> None:
    """Register all Flask blueprints with the app."""
    app.register_blueprint(main_bp)
    app.register_blueprint(api_bp)

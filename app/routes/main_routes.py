from flask import Blueprint, render_template, redirect

from app.config import settings

bp = Blueprint("main", __name__)


@bp.route("/")
def index():
    return render_template("index.html", settings=settings)


@bp.route("/healthz")
def healthz():
    return "ok", 200


@bp.route(settings.namespace_packets)
def packets():
    return render_template("packets.html", settings=settings)


@bp.route("/rawlog")
def rawlog():
    return redirect(settings.namespace_packets)

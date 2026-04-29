FROM python:3.13-slim

# Set Python optimization and disable buffering
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN groupadd -r appuser && \
    useradd -r -g appuser -m -d /home/appuser appuser


RUN apt-get update && \
    apt-get -y --no-install-recommends install git curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /meshwatcher

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py gunicorn_config.py ./
COPY templates/ ./templates/
COPY app/ ./app/
COPY static/ ./static/

RUN chown -R appuser:appuser /meshwatcher

USER appuser

EXPOSE 8080

ARG GIT_COMMIT
ENV GIT_COMMIT=${GIT_COMMIT:-unknown}

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS http://localhost:8080/healthz || exit 1

CMD ["gunicorn", "-c", "gunicorn_config.py", "main:app"]

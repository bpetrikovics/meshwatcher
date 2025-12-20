FROM python:3.13-slim

RUN groupadd -r appuser && \
    useradd -r -g appuser appuser

RUN apt-get update && \
    apt-get -y --no-install-recommends install git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /meshtracker

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py gunicorn_config.py ./
COPY templates/ ./templates/
COPY app/ ./app/
COPY static/ ./static/

RUN chown -R appuser:appuser /meshtracker

USER appuser

EXPOSE 8080

ARG GIT_COMMIT
ENV GIT_COMMIT=$GIT_COMMIT

CMD ["gunicorn", "-c", "gunicorn_config.py", "main:app"]

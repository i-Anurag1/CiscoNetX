FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1     PYTHONUNBUFFERED=1     PYTHONPATH=/app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip     && pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY integrations ./integrations
COPY alembic ./alembic
COPY alembic.ini .
COPY pytest.ini .
COPY start.sh .

RUN useradd --create-home --shell /bin/bash appuser     && chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=10   CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"

CMD ["sh", "start.sh"]

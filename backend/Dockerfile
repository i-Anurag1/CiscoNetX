FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY tests ./tests
COPY pytest.ini .
COPY alembic ./alembic
COPY alembic.ini .
COPY start.sh .
ENV PYTHONPATH=/app
EXPOSE 8000
CMD ["sh","start.sh"]

FROM python:3.13-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY tests ./tests
COPY pytest.ini .
ENV PYTHONPATH=/app
EXPOSE 8000
COPY start.sh .\nRUN chmod +x start.sh\nCMD ["./start.sh"]

# Deployment

Local full stack:

`docker compose up --build`

Frontend: `http://localhost:5173`
Backend: `http://localhost:8000`
Health: `http://localhost:8000/health`

For production, replace development database credentials with secrets, set CORS to the deployed frontend origin, terminate TLS at the hosting layer, use managed PostgreSQL, run migrations as a release step, and configure WebSocket support. Never commit `.env` files or credentials.

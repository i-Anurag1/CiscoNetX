# Testing Strategy

Unit tests cover algorithms and protocol primitives. API tests cover routing, labs, simulations and security. Deterministic simulations use fixed seeds. CI builds backend and frontend on every push and pull request.

Recommended release gate:

1. `PYTHONPATH=backend pytest -q`
2. `cd frontend && npm install && npm run build`
3. `docker compose config`
4. `docker compose build`
5. `docker compose up -d`
6. Verify `/health`
7. Run the full-stack demo scenario.

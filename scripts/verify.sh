#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf backend/.pytest_cache backend/__pycache__ backend/app/**/__pycache__ backend/integrations/**/__pycache__ backend/cisconetx.db
PYTHONPATH=backend python -m compileall -q backend/app backend/integrations backend/alembic
PYTHONPATH=backend pytest -q
(cd backend && PYTHONPATH=. alembic upgrade head)
if command -v npm >/dev/null 2>&1; then (cd frontend && npm install --no-audit --no-fund && npm run typecheck && npm run build); fi
if command -v docker >/dev/null 2>&1; then docker compose config >/dev/null; fi
rm -rf backend/.pytest_cache backend/__pycache__ backend/app/**/__pycache__ backend/integrations/**/__pycache__ backend/cisconetx.db
printf 'CiscoNetX clean verification completed.\n'

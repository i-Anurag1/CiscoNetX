#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PYTHONPATH="$ROOT/backend"
export APP_ENV=development
export SECRET_KEY="${SECRET_KEY:-verify-secret-key-012345678901234567890123}"

python -m compileall -q backend/app backend/integrations backend/alembic
pytest -q backend
DATABASE_URL="sqlite:///$ROOT/backend/verify.db" alembic -c backend/alembic.ini upgrade head

if command -v npm >/dev/null 2>&1; then
  (cd frontend && npm ci --no-audit --no-fund && npm run typecheck && npm run build)
fi

if command -v docker >/dev/null 2>&1; then
  docker compose config >/dev/null
fi

rm -f backend/verify.db
rm -rf backend/.pytest_cache backend/**/__pycache__ frontend/dist

printf 'CiscoNetX verification passed.\n'

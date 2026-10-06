#!/bin/sh
set -eu

if [ "${APP_ENV:-development}" = "production" ]; then
  if [ -z "${SECRET_KEY:-}" ] || [ "${#SECRET_KEY}" -lt 32 ]; then
    echo "SECRET_KEY must contain at least 32 characters in production" >&2
    exit 1
  fi
fi

alembic upgrade head
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --proxy-headers --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-*}"

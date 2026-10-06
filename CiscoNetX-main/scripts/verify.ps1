$ErrorActionPreference='Stop'
$Root=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$env:PYTHONPATH="$Root\backend"
$env:APP_ENV='development'
if (-not $env:SECRET_KEY) { $env:SECRET_KEY='verify-secret-key-012345678901234567890123' }

python -m compileall -q backend/app backend/integrations backend/alembic
pytest -q backend
$env:DATABASE_URL="sqlite:///$Root\backend\verify.db"
alembic -c backend/alembic.ini upgrade head

if (Get-Command npm -ErrorAction SilentlyContinue) {
  Set-Location frontend
  npm ci --no-audit --no-fund
  npm run typecheck
  npm run build
  Set-Location ..
}

if (Get-Command docker -ErrorAction SilentlyContinue) {
  docker compose config | Out-Null
}

Remove-Item -Force -ErrorAction SilentlyContinue backend\verify.db
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue backend\__pycache__,frontend\dist

Write-Host 'CiscoNetX verification passed.'

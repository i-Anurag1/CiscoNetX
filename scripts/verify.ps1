$ErrorActionPreference='Stop'
$Root=Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue backend/.pytest_cache,backend/__pycache__,backend/app/__pycache__,backend/integrations/__pycache__,backend/cisconetx.db
$env:PYTHONPATH='backend'
python -m compileall -q backend/app backend/integrations backend/alembic
pytest -q
Set-Location backend
$env:PYTHONPATH='.'
alembic upgrade head
Set-Location ../frontend
if (Get-Command npm -ErrorAction SilentlyContinue) { npm install --no-audit --no-fund; npm run typecheck; npm run build }
Set-Location ..
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue backend/.pytest_cache,backend/__pycache__,backend/app/__pycache__,backend/integrations/__pycache__,backend/cisconetx.db
Write-Host 'CiscoNetX clean verification completed.'

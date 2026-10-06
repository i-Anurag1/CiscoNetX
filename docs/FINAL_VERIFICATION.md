# Final verification procedure

Run from a clean checkout.

## Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
rm -f cisconetx.db
alembic upgrade head
python -m compileall -q app integrations
pytest -q
```

Windows PowerShell uses `.venv\\Scripts\\Activate.ps1` and `Remove-Item cisconetx.db -ErrorAction SilentlyContinue`.

## Frontend

```bash
cd frontend
npm ci
npm run typecheck
npm run build
```

If no lockfile exists, use `npm install` once, then commit the generated lockfile before CI enforcement.

## Docker

```bash
docker compose config

docker compose build

docker compose up -d
curl http://localhost:8000/health
curl http://localhost:8080
```

## Linux emulation

On a Linux host with the required privileges and packages:

```bash
which mn ovs-vsctl vtysh tcpdump
python -c "import scapy.all; print('scapy ok')"
```

Then call `/api/v1/emulation/capabilities` and use the dry-run plan before enabling any privileged topology actions.

## Release gate

A release is accepted only when backend tests, frontend typecheck/build, Docker build/startup, database migration, API smoke tests, and Linux emulation checks pass on the target environment. Do not convert an unavailable external dependency into a false pass.

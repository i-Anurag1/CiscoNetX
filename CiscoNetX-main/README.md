# CiscoNetX

CiscoNetX is an integrated Computer Networks engineering laboratory and NOC simulator. It combines topology modeling, routing, packet forwarding, data-link protocols, transport behavior, security analytics, telemetry, ML experiments, reporting, and optional Linux network emulation.

## Stack

Backend: FastAPI, Pydantic, SQLAlchemy, Alembic, PostgreSQL or SQLite development fallback.

Frontend: React, TypeScript, Vite, Nginx.

Ops: Docker Compose, GitHub Actions, deterministic seeded simulations, health checks, migration-on-start.

## Features

- Interactive NOC dashboard and topology workspace
- Dijkstra, Distance Vector, RIP and OSPF-style routing
- Failover and route convergence simulation
- Packet tracing and traffic engineering
- Ethernet, VLAN, ARP and NAT/PAT labs
- IPv4/IPv6 validation and header inspection
- CRC, checksum and Hamming code labs
- Stop-and-Wait, Go-Back-N and Selective Repeat
- ALOHA, Slotted ALOHA, CSMA/CD and CSMA/CA models
- TCP handshake and congestion-window simulation
- DNS, HTTP, HTTPS, FTP, SMTP and SNMP flows
- ACL and firewall evaluation
- DDoS, port-scan and ARP-spoof detection
- Telemetry summaries and threshold alerts
- Deterministic ML anomaly training and evaluation
- SDN-style path and flow rule simulation
- Experiments, replay validation and engineering reports
- CSV and PDF project reports
- Safe dry-run support for Mininet, OVS, FRRouting and tcpdump environments

## Local development

Backend:

```text
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Linux/macOS:
source .venv/bin/activate

pip install -r requirements.txt
$env:PYTHONPATH='.'  # PowerShell
# Linux/macOS: export PYTHONPATH=.
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Frontend:

```text
cd frontend
npm ci
npm run typecheck
npm run build
npm run dev
```

Open `http://localhost:5173`.

## Docker

```text
copy backend/.env.example .env
docker compose up --build
```

For a real deployment, provide a unique `SECRET_KEY` with at least 32 characters, a strong PostgreSQL password, and explicit `CORS_ORIGINS`.

Production mode:

```text
APP_ENV=production
DATABASE_URL=postgresql+psycopg://...
SECRET_KEY=<32+ character random secret>
CORS_ORIGINS=https://your-console.example
```

The backend refuses production startup with a short secret or SQLite.

## Verification

Linux/macOS:

```text
./scripts/verify.sh
```

Windows PowerShell:

```text
.\scripts\verify.ps1
```

The verification flow compiles Python, runs the backend test suite, applies a fresh Alembic migration, then runs frontend typecheck/build when npm dependencies are available.

## API

Development OpenAPI UI:

`http://localhost:8000/docs`

Health:

`http://localhost:8000/health`

The API is versioned under `/api/v1`.

## Security model

Passwords use PBKDF2-HMAC-SHA256 with a per-user random salt.

Bearer tokens are HMAC-SHA256 signed and expire after one hour.

Project read APIs require authentication. Project mutation APIs require engineer or admin role.

Production CORS uses an explicit origin allow-list and the frontend container emits baseline browser security headers.

Simulator and emulation features are designed around synthetic or dry-run network state. The application does not automate attacks against external systems.

## CI

GitHub Actions runs Python compilation, the backend test suite, a fresh Alembic migration, frontend `npm ci`, TypeScript typecheck, and Vite production build.


## Student Lab Mode

CiscoNetX now includes an AI Lab Coach for Computer Networks practicals.

Open `AI LAB COACH`, paste the teacher's question, and the assistant returns:

- detected CN topic
- lab objective
- step-by-step procedure
- Cisco-style CLI commands where relevant
- expected result
- hints
- viva questions
- a starter topology when the lab is supported

Use `LOAD THIS LAB INTO TOPOLOGY` to move from the question directly into the simulator.

The Topology workspace also provides a Packet Tracer-style student workflow with device creation, cable/connect controls, Simulation/Realtime modes, link failure controls, topology analysis and a simulation event log.

See `docs/AI_LAB_COACH.md` for the full workflow and optional LLM configuration.

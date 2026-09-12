# CiscoNetX

CiscoNetX is an integrated Computer Networks engineering laboratory and NOC simulator. It connects a deterministic network simulator, routing and switching laboratories, packet tracing, traffic engineering, defensive security analytics, ML telemetry analysis, SDN-style flow control, experiments and operational reporting through one application.

## What is implemented

- React + TypeScript + Vite NOC console
- Interactive topology editor with device inspection and link failure controls
- Deterministic packet tracing and route-failure comparison
- Ethernet-style MAC learning, VLAN forwarding and ARP resolution APIs
- IPv4/IPv6 header inspection, CIDR/subnetting and NAT/PAT
- Dijkstra, Distance Vector, RIP-style and OSPF-style routing engines
- SDN-style flow rules and traffic engineering
- CRC, checksum, Hamming Code and ARQ laboratories
- ALOHA, Slotted ALOHA, CSMA/CD and CSMA/CA simulations
- TCP handshake/state machine and congestion-window behavior
- UDP and DNS/HTTP/HTTPS/FTP/SMTP/SNMP protocol flows
- Packet/event inspection APIs
- Firewall, ACL, DDoS, port-scan and ARP-spoof detection
- Synthetic telemetry, baseline scoring and reproducible Logistic Regression evaluation
- Grounded network assistant based on supplied simulator evidence
- Network policy evaluation, experiments, replay determinism checks and reports
- PostgreSQL schema with Alembic migrations and SQLite development fallback
- Authentication, audit events and security incident persistence
- WebSocket operational channel
- Docker Compose, Nginx and GitHub Actions CI
- Optional Linux emulation capability detection and safe dry-run planning for Mininet, Open vSwitch, FRRouting and tcpdump

## Run

Backend:

```text
cd backend
python -m venv .venv
# Windows: .venv\\Scripts\\activate
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt
set PYTHONPATH=.  # Windows PowerShell: $env:PYTHONPATH='.'
alembic upgrade head
uvicorn app.main:app --reload --port 8000
```

Frontend:

```text
cd frontend
npm install
npm run typecheck
npm run build
npm run dev
```

Full stack:

```text
docker compose up --build
```

## Verification

Run `scripts/verify.sh` on Linux/macOS or `scripts/verify.ps1` on Windows. The verification script resets generated state, compiles Python, runs tests, applies a fresh migration, performs frontend checks when npm is available, and validates Docker Compose when Docker is installed.

The build environment used to prepare this source package did not provide Docker or a working npm registry connection. Backend and migration verification were executed locally in the preparation environment. External Linux emulation and production hosting require their corresponding host privileges and services.

## Primary demonstration

Create the enterprise topology, generate traffic, record the baseline route, fail R2, recompute the path through R3, compare recovery and performance metrics, inspect packet traces, trigger defensive detection, evaluate telemetry, ask the grounded assistant why the route changed, and export a report.

## Security boundary

Attack-like behavior is synthetic and confined to the simulator. The project does not automate attacks against external systems. Replace all development secrets and database passwords before deployment.

## Presentation-ready UI

CiscoNetX 4.0 includes a redesigned enterprise console with a light professional operations workspace, topology canvas, route visualization, packet timeline, protocol stack, security signals, telemetry charts, ML visualization, experiment/replay views, and engineering report preview.

### Windows one-click startup

Double-click `RUN-CiscoNetX.bat`. It creates the Python environment when needed, installs missing dependencies, then opens the backend and frontend in separate terminals.

Open `http://localhost:5173` for the console and `http://localhost:8000/health` for the API health check.

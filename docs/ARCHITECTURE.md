# Architecture

CiscoNetX uses a layered architecture.

Frontend: React + TypeScript + Vite. The UI provides NOC, topology, routing, packet, laboratory, protocol, security, ML, experiment, replay and report workspaces.

API: FastAPI exposes versioned REST endpoints and a WebSocket event channel. Pydantic models validate network input at the boundary.

Domain: deterministic simulation engines model routing, switching, packets, ARQ, medium access, TCP, application protocols, security and traffic engineering.

Persistence: SQLAlchemy maps projects, simulations, incidents, audit events, experiments, policies and ML model versions. PostgreSQL is the production target. SQLite remains available for portable development.

Operations: Docker Compose, health checks, Nginx and GitHub Actions provide repeatable deployment and CI paths.

Emulation: optional Linux adapters expose Mininet, Open vSwitch, FRRouting, tcpdump and Scapy capability detection without making privileged access a prerequisite for the educational simulator.

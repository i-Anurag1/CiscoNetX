# CiscoNetX engineering status

CiscoNetX is a deterministic educational and network-operations simulator. Core simulations run locally without privileged networking. Linux integrations such as Mininet, Open vSwitch and FRRouting are optional extension points and are not represented as active integrations unless detected and configured.

## Implemented core

- Enterprise topology and failure simulation
- Dijkstra, Distance Vector, RIP-style and OSPF-style route views
- Packet tracing with reproducible seeds
- Ethernet/MAC/VLAN/ARP/NAT laboratory endpoints
- IPv4/IPv6 header inspection and CIDR subnetting
- CRC, Checksum and Hamming Code
- Stop-and-Wait, Go-Back-N and Selective Repeat simulations
- ALOHA, Slotted ALOHA, CSMA/CD and CSMA/CA statistical simulations
- TCP handshake and congestion-state simulation
- DNS and HTTP flow demonstrations
- ACL/firewall evaluation and defensive anomaly detection
- Synthetic telemetry and deterministic ML baseline scoring/evaluation
- Grounded network assistant using project state
- PostgreSQL-compatible SQLAlchemy persistence with SQLite local fallback
- WebSocket endpoint, audit trail and simulation history
- React/TypeScript NOC console
- Docker and GitHub Actions configuration

## Verification

Backend compilation and automated tests are required before release. The CI workflow runs backend tests and the frontend production build in a clean GitHub Actions environment. Docker deployment requires a Docker-capable host.

## Scope boundary

This project models protocol behavior for learning and engineering analysis. It is not a replacement for Cisco IOS, NX-OS, IOS XR, production routing stacks, or a packet-forwarding appliance.

# CiscoNetX master prompt compliance matrix

The repository implements the requested integrated workflow rather than a collection of static screens.

| Requirement | Implementation | Verification |
|---|---|---|
| OSI/TCP-IP | encapsulation API and protocol catalog | automated API test |
| Switching | topology, MAC/VLAN decision models | backend tests |
| Error control | CRC, checksum, Hamming | backend tests |
| ARQ | Stop-and-Wait, GBN, SR | deterministic tests |
| Medium access | ALOHA, slotted ALOHA, CSMA/CD, CSMA/CA | deterministic tests |
| IP | IPv4/IPv6, CIDR, subnetting, headers | API tests |
| ARP/NAT | resolution and PAT tables | API tests |
| Routing | Dijkstra, DV, RIP, OSPF-style link-state calculation, convergence | routing tests |
| SDN | controller/flow abstraction | API tests |
| Traffic engineering | bottleneck, utilization, reroute metrics | API tests |
| TCP/UDP | handshake, state, congestion model | API tests |
| Application protocols | DNS, HTTP, HTTPS, FTP, SMTP, SNMP | API tests |
| Packet analysis | packet creation, encapsulation, tracing | packet tests |
| Security | ACL, firewall, DDoS, scan, ARP-spoof analytics | security tests |
| ML | synthetic telemetry, baseline, Logistic Regression, multi-task training | ML tests |
| Grounded assistant | state/evidence based explanations | API contract |
| Automation | threshold policy evaluation | API contract |
| Persistence | SQLAlchemy, PostgreSQL, Alembic, SQLite fallback | migration test |
| Observability | health, telemetry, WebSocket channel, audit | API tests |
| Reports | PDF and CSV | service/API contract |
| Emulation | Mininet/OVS/FRR/tcpdump capability detection and safe planning | capability endpoint |
| Deployment | Docker, Nginx, CI | configuration validation |
| UI/UX | responsive React/TypeScript NOC, topology and engineering workspaces | typecheck/build in CI |
| Determinism | seeded simulation and replay identity checks | regression tests |

The pure simulator is portable. Privileged Linux emulation is intentionally separated behind capability detection and a safe dry-run plan. This keeps the core application runnable on Windows while providing a path to Mininet/Open vSwitch/FRRouting on Linux.

# AI Solver Agent and Network Doctor

Type a networking lab question and the agent builds the whole solution on the canvas: devices placed, cables connected, IOS configuration typed, everything verified with real pings, HTTP requests and route checks, then written up as a solution sheet. It runs entirely in the browser, with no backend and no API key.

Open it from the blue **AI Solver** button in the toolbar, or the **AI Agent** menu. It also opens by itself on an empty workspace.

## What it solves

Switched LANs and hubs, static routing, RIP v2, OSPF, EIGRP, serial and Ethernet WAN links, router rings, chains and stars, VLANs with router-on-a-stick or layer 3 switch SVIs, VLAN isolation, VLSM, NAT overload with an ISP and outside web server, DHCP on the router or on a server with `ip helper-address`, DNS and HTTP servers, standard and extended ACLs, and link-failure tests.

Example: *Three routers with OSPF, NAT to ISP, DHCP server on LAN 1 with helper address and an ACL blocking LAN 3 from the web server.*

## Pipeline

| Phase | File | What happens |
| --- | --- | --- |
| Understand | `agent/nlu.ts` | The question becomes a validated `LabSpec` (`agent/spec.ts`). Assumptions and warnings are listed. |
| Plan | `agent/planner.ts`, `routed.ts`, `vlanlab.ts`, `lanlab.ts` | Topology, VLSM addressing (`ipam.ts`), IOS configs, checks, show commands, viva questions. ACL logic is in `aclrules.ts`. |
| Build | `agent/executor.ts` | Adds devices and cables on the canvas with animation, sets hosts and servers, types every config through the real CLI, acquires DHCP leases. |
| Verify | `agent/verify.ts` | Warm-up plus four measured pings, HTTP, DHCP and routing-table checks. Expected failures (for ACLs and isolation) count as passes. |
| Self-heal | `agent/doctor.ts` | If any check fails the doctor diagnoses and repairs, then checks run again. |
| Failover | `agent/verify.ts` | Takes an active link down, confirms traffic reroutes (or stops when there is no alternative), restores it. |
| Report | `agent/report.ts` | Subnet table, address table, every configuration, results, `show` evidence, viva questions. Download as Markdown. |

`agent/agent.ts` runs the phases and reports progress to the window in `ui/Agent.tsx`.

## Network Doctor

Works on any topology on the canvas, not only agent-built ones. It lists each problem with a plain explanation and the exact commands that fix it, and can apply one fix or all of them. It detects powered-off devices, shut interfaces, missing serial clock rates, wrong cable types, mismatched link subnets, missing VLANs, wrong access VLANs, trunk problems, wrong host gateway, mask or duplicate address, missing DHCP leases, missing routing `network` statements, passive interfaces on router links, unreachable static routes and missing default routes. When the agent built the lab, the doctor also compares against the plan.

**Break it** injects a random or chosen fault (`agent/faults.ts`) so the doctor can be demonstrated or practised against.

## Tests

`npm test` in `frontend/` runs the engine tests and `tests/agent.test.ts`, which solves every example question to 100 percent, checks understanding and VLSM, and injects every fault kind then confirms the doctor repairs it.

During development the planner was fuzzed with 4,000 random normalised specs (100 percent each, including failover) and the doctor with 1,800 random labs carrying about 3,100 injected faults (all repaired).

## Limits

Understanding is rule based, so very unusual phrasing may be reported as not understood with a hint rather than guessed. Limits are set in `LIMITS` in `agent/spec.ts` (routers, LANs, hosts per LAN, VLANs). Anything the agent had to assume is shown in the Summary tab.

# CiscoNetX AI Lab Coach

AI Lab Coach turns a teacher's Computer Networks lab question into an executable student workflow.

## Student workflow

1. Open CiscoNetX.
2. Click `AI LAB COACH`.
3. Paste the teacher's question.
4. Click `SOLVE LAB QUESTION`.
5. Read the detected topic, objective, steps, commands, expected result and viva questions.
6. Click `LOAD THIS LAB INTO TOPOLOGY` when a starter topology is available.
7. Configure the devices in `Topology`.
8. Use `RUN ANALYSIS` to generate simulation evidence.
9. Record setup, observation, result and conclusion for the lab sheet.

## Supported guided labs

- RIP / Distance Vector
- OSPF / Link State
- Routing / Dijkstra
- IPv4 / Subnetting
- TCP / Transport
- VLAN / Switching
- ARQ / Sliding Window
- Error detection and correction
- MAC access protocols
- Application protocols
- Network security

## Offline mode

CiscoNetX works without an external AI service. The built-in curriculum engine produces deterministic guidance and starter topologies.

## Optional LLM mode

Set these backend environment variables:

```text
AI_BASE_URL=https://your-openai-compatible-provider/v1
AI_MODEL=your-model
AI_API_KEY=your-key
AI_TIMEOUT_SECONDS=12
```

The external model is used only for the teacher-style explanation. CiscoNetX still keeps the local curriculum fallback and starter topology.

## Faculty demonstration

Use a question such as:

`Configure RIP between two routers and verify route convergence after a link failure.`

The assistant produces the topology, steps and CLI commands. Load the topology, take the inter-router link down, run the routing analysis, and show the before and after path.

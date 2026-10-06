from __future__ import annotations

import ipaddress


def validate_topology(t: dict) -> dict:
    nodes = t.get("nodes", [])
    links = t.get("links", [])
    errors: list[str] = []
    node_ids = [n.get("id") for n in nodes]
    ids = set(node_ids)

    if len(ids) != len(node_ids):
        errors.append("Duplicate node id")
    if len(nodes) > 1000:
        errors.append("Too many nodes")
    if len(links) > 5000:
        errors.append("Too many links")

    for node in nodes:
        node_id = node.get("id")
        if not node_id:
            errors.append("Node id is required")
        ip = node.get("ip")
        if ip:
            try:
                ipaddress.ip_address(ip)
            except ValueError:
                errors.append(f"Invalid IP address on node {node_id}")

    link_ids: set[str] = set()
    for link in links:
        link_id = link.get("id")
        if not link_id:
            errors.append("Link id is required")
        elif link_id in link_ids:
            errors.append(f"Duplicate link id {link_id}")
        link_ids.add(link_id)
        source = link.get("source")
        target = link.get("target")
        if source not in ids or target not in ids:
            errors.append(f"Invalid link {link_id}")
        if source == target:
            errors.append(f"Self-link not allowed on {link_id}")
        try:
            if float(link.get("bandwidth_mbps", 1)) <= 0:
                errors.append(f"Invalid bandwidth on {link_id}")
        except (TypeError, ValueError):
            errors.append(f"Invalid bandwidth on {link_id}")

    return {"valid": not errors, "errors": sorted(set(errors))}


def subnet(network: str, prefix: int) -> dict:
    n = ipaddress.ip_network(f"{network}/{prefix}", strict=False)
    hosts = list(n.hosts()) if n.num_addresses < 100_000 else []
    return {
        "network": str(n.network_address),
        "broadcast": str(n.broadcast_address),
        "prefix": n.prefixlen,
        "netmask": str(n.netmask),
        "wildcard": str(n.hostmask),
        "first_host": str(hosts[0]) if hosts else None,
        "last_host": str(hosts[-1]) if hosts else None,
        "hosts": max(0, n.num_addresses - 2) if n.version == 4 and n.prefixlen < 31 else n.num_addresses,
        "version": n.version,
    }

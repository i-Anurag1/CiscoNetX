import type { LabSpec } from './spec.ts';
import type { Viva } from './plan.ts';

const GENERAL: Viva[] = [
  {
    question: 'Why does the first ping of a new path often time out?',
    answer: 'The sender does not yet know the destination MAC address, so it sends an ARP request first. The echo request that triggered ARP is dropped, and later pings succeed once the ARP cache is filled.',
  },
  {
    question: 'What does the TTL value in a ping reply tell you?',
    answer: 'TTL starts at 128 on a PC and is decreased by one at every router. A reply with TTL 126 from a PC means the packet crossed two routers on the way back.',
  },
  {
    question: 'What is the difference between a switch and a router?',
    answer: 'A switch forwards frames inside one broadcast domain using MAC addresses. A router forwards packets between networks using IP addresses and separates broadcast domains.',
  },
];

const ROUTING: Viva[] = [
  {
    question: 'What is the difference between static and dynamic routing?',
    answer: 'Static routes are typed by an administrator and never change by themselves. Dynamic protocols such as RIP, OSPF and EIGRP exchange information and recompute paths when the topology changes.',
  },
  {
    question: 'What is a default gateway and why does a PC need one?',
    answer: 'It is the router interface a host sends traffic to when the destination is outside its own subnet. Without it the host can only talk to its own LAN.',
  },
  {
    question: 'Why is a /30 used on the links between routers?',
    answer: 'A /30 has exactly two usable addresses, one for each router interface, so no addresses are wasted on point-to-point links.',
  },
];

const OSPF: Viva[] = [
  {
    question: 'Why does OSPF use wildcard masks in the network command?',
    answer: 'The wildcard mask tells the router which bits of the address must match. It is the inverse of the subnet mask, so 0.0.0.255 matches a /24.',
  },
  {
    question: 'What is the OSPF router ID and how is it chosen?',
    answer: 'It is a 32-bit identifier. It is the manually configured router-id, otherwise the highest loopback address, otherwise the highest active interface address.',
  },
  {
    question: 'Why are LAN interfaces made passive?',
    answer: 'A passive interface still advertises its network but sends no hello packets, so no neighbour can form there and routing updates are not leaked to end hosts.',
  },
  {
    question: 'What metric does OSPF use?',
    answer: 'Cost, derived from interface bandwidth (reference bandwidth divided by interface bandwidth). The path with the lowest total cost is selected.',
  },
];

const RIP: Viva[] = [
  {
    question: 'What is the maximum hop count in RIP?',
    answer: 'Fifteen. A route with a metric of 16 is considered unreachable.',
  },
  {
    question: 'Why was version 2 and no auto-summary used?',
    answer: 'RIPv2 carries subnet masks and supports VLSM. Disabling auto-summary stops the router summarising subnets at classful boundaries, which would break discontiguous networks.',
  },
  {
    question: 'How often does RIP send updates?',
    answer: 'Every 30 seconds it sends its full routing table to its neighbours. It uses split horizon to avoid loops.',
  },
];

const EIGRP: Viva[] = [
  {
    question: 'What is the EIGRP autonomous system number?',
    answer: 'It identifies one EIGRP domain. Routers only become neighbours when their AS numbers match.',
  },
  {
    question: 'What metric components does EIGRP use by default?',
    answer: 'Bandwidth and delay (the minimum bandwidth along the path and the sum of delays). It uses the DUAL algorithm to pick loop-free paths.',
  },
];

const FAILOVER: Viva[] = [
  {
    question: 'What happened to the path when the link failed?',
    answer: 'The routing protocol detected that the neighbour was gone, recomputed the best path over the remaining links, and traffic continued through the redundant route.',
  },
  {
    question: 'Why can static routes not recover from a link failure?',
    answer: 'A static route does not know whether its next hop is alive beyond the local interface state. Without a floating static route or a dynamic protocol, traffic keeps using the dead path.',
  },
];

const VLAN: Viva[] = [
  {
    question: 'What is a VLAN?',
    answer: 'A VLAN is a logical broadcast domain created on a switch. Hosts in different VLANs cannot talk at Layer 2 even when they share the same switch.',
  },
  {
    question: 'What does a trunk port do?',
    answer: 'A trunk carries traffic for several VLANs over one link by adding an 802.1Q tag that holds the VLAN ID. The native VLAN is sent untagged.',
  },
  {
    question: 'Why can hosts in different VLANs not ping each other without a router?',
    answer: 'They are in different broadcast domains and different subnets. A Layer 3 device must route between them.',
  },
];

const ROAS: Viva[] = [
  {
    question: 'How does router-on-a-stick work?',
    answer: 'One physical router interface is split into sub-interfaces, one per VLAN. Each uses encapsulation dot1Q with its VLAN ID and its own IP address, which becomes the default gateway of that VLAN.',
  },
];

const SVI: Viva[] = [
  {
    question: 'What is an SVI?',
    answer: 'A switched virtual interface is a Layer 3 interface for a VLAN on a multilayer switch. With ip routing enabled the switch routes between its SVIs without an external router.',
  },
];

const NAT: Viva[] = [
  {
    question: 'What is the difference between NAT and PAT?',
    answer: 'NAT maps one private address to one public address. PAT (overload) maps many private hosts to a single public address by using different source port numbers.',
  },
  {
    question: 'What are inside local and inside global addresses?',
    answer: 'The inside local address is the private address of the host. The inside global address is the public address that represents it on the outside network.',
  },
  {
    question: 'Why can the ISP router not reach the private hosts directly?',
    answer: 'Private addresses are not routed on the public side, and the ISP has no route to them. Only replies to translated sessions can return through the NAT table.',
  },
];

const ACL: Viva[] = [
  {
    question: 'Where should standard and extended ACLs be placed?',
    answer: 'A standard ACL filters on source address only, so it is placed close to the destination. An extended ACL can match source, destination and port, so it is placed close to the source.',
  },
  {
    question: 'What is the implicit deny at the end of an ACL?',
    answer: 'Every ACL ends with an invisible deny any, so a permit statement is needed for the traffic that should still pass.',
  },
];

const DHCP: Viva[] = [
  {
    question: 'What are the four steps of DHCP?',
    answer: 'Discover, Offer, Request and Acknowledge (DORA). The client broadcasts a discover, a server offers an address, the client requests it and the server acknowledges it.',
  },
  {
    question: 'What does ip helper-address do?',
    answer: 'It makes a router forward DHCP broadcasts as unicasts to a DHCP server on another network, because broadcasts normally stop at the router.',
  },
];

const DNS: Viva[] = [
  {
    question: 'What does a DNS A record contain?',
    answer: 'It maps a host name to an IPv4 address, for example www.lab.local to the web server address.',
  },
];

const VLSM: Viva[] = [
  {
    question: 'What is VLSM and why use it?',
    answer: 'Variable Length Subnet Masking gives each subnet a mask that fits its host count. Allocating the largest subnet first keeps blocks aligned and wastes fewer addresses.',
  },
  {
    question: 'How many usable hosts does a /26 give?',
    answer: 'A /26 has 64 addresses, minus the network and broadcast addresses, so 62 usable hosts.',
  },
];

export function vivaFor(spec: LabSpec): Viva[] {
  const bank: Viva[] = [];
  if (spec.family === 'vlan') {
    bank.push(...VLAN);
    if (spec.interVlan === 'roas') {
      bank.push(...ROAS);
    }
    if (spec.interVlan === 'svi') {
      bank.push(...SVI);
    }
  }
  if (spec.family === 'routed') {
    bank.push(...ROUTING);
    if (spec.routing === 'ospf') {
      bank.push(...OSPF);
    }
    if (spec.routing === 'rip') {
      bank.push(...RIP);
    }
    if (spec.routing === 'eigrp') {
      bank.push(...EIGRP);
    }
  }
  if (spec.hostRequirements.length > 0) {
    bank.push(...VLSM);
  }
  if (spec.failover) {
    bank.push(...FAILOVER);
  }
  if (spec.nat) {
    bank.push(...NAT);
  }
  if (spec.acl) {
    bank.push(...ACL);
  }
  if (spec.dhcp !== 'none') {
    bank.push(...DHCP);
  }
  if (spec.dns) {
    bank.push(...DNS);
  }
  bank.push(...GENERAL);
  const seen = new Set<string>();
  const unique = bank.filter(item => {
    if (seen.has(item.question)) {
      return false;
    }
    seen.add(item.question);
    return true;
  });
  return unique.slice(0, 10);
}

export interface Example {
  label: string;
  question: string;
}

export const EXAMPLES: Example[] = [
  {
    label: 'OSPF triangle + link failure',
    question: 'Three routers in a triangle running OSPF, one LAN behind each router, and test what happens when a link fails',
  },
  {
    label: 'Router-on-a-stick',
    question: 'Create VLAN 10 Sales and VLAN 20 Engineering on one switch with router-on-a-stick inter-VLAN routing',
  },
  {
    label: 'NAT overload to ISP',
    question: 'One router, one LAN with 3 PCs, NAT overload to an ISP and a web server on the internet',
  },
  {
    label: 'VLSM + OSPF',
    question: 'VLSM: split 192.168.10.0/24 for 100, 50, 25 and 10 hosts across routers using OSPF',
  },
  {
    label: 'DHCP + DNS + web',
    question: 'Configure DHCP on the router for 2 LANs and DNS and a web server www.example.com',
  },
  {
    label: 'Extended ACL',
    question: 'Two LANs with an extended ACL that blocks LAN 2 from pinging LAN 1',
  },
  {
    label: 'L3 switch SVIs',
    question: 'Configure VLANs 10, 20 and 30 on two switches with a layer 3 switch doing inter-VLAN routing',
  },
  {
    label: 'EIGRP over serial',
    question: 'Configure EIGRP on 3 routers, each router has a LAN, using serial links',
  },
  {
    label: 'RIP v2 chain',
    question: 'Configure RIP v2 on 4 routers in a chain with a LAN on each',
  },
  {
    label: 'Everything together',
    question: 'Three routers with OSPF, NAT to ISP, DHCP server on LAN 1 with helper address and an ACL blocking LAN 3 from the web server',
  },
  {
    label: 'Simple switched LAN',
    question: 'Create a LAN with 4 PCs connected to a switch',
  },
  {
    label: 'Static routes',
    question: 'Two LANs connected by two routers using static routes',
  },
];

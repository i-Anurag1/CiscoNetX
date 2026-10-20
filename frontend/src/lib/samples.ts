import type { Dev } from '../model/types.ts';
import type { Net } from '../model/net.ts';
import { Cli } from '../ios/cli.ts';

export interface Sample { id: string; title: string; desc: string; build: (n: Net) => Promise<void> }
async function cmd(n: Net, d: Dev, lines: string[]): Promise<void> { const c = Cli.detached(n, d); for (const l of lines) await c.exec(l); n.touch(); }
function link(n: Net, a: Dev, pa: string, b: Dev, pb: string, type = 'auto'): void { const r = n.connect(type, { dev: a.id, port: pa }, { dev: b.id, port: pb }); if (!r.ok) throw new Error(`${a.name}:${pa} -> ${b.name}:${pb}: ${r.error}`); }
function host(d: Dev, ip: string, mask: string, gw?: string, dns?: string): void { const c = d.cfg.ifs[0]; c.ip = ip; c.mask = mask; d.cfg.hostGw = gw; d.cfg.hostDns = dns; }
const Fa = (i: number) => `FastEthernet0/${i}`; const Gi = (i: number) => `GigabitEthernet0/${i}`;

export const SAMPLES: Sample[] = [
  { id: 'lan', title: 'Basic LAN', desc: 'One switch, three PCs and a server on 192.168.1.0/24.', build: async n => {
    const sw = n.addDevice('2960-24TT', 300, 170); const pcs = [n.addDevice('PC-PT', 120, 300), n.addDevice('PC-PT', 300, 330), n.addDevice('PC-PT', 480, 300)]; const sv = n.addDevice('Server-PT', 300, 40);
    pcs.forEach((p, i) => { link(n, sw, Fa(i + 1), p, 'FastEthernet0'); host(p, `192.168.1.${10 + i}`, '255.255.255.0'); }); link(n, sw, Fa(10), sv, 'FastEthernet0'); host(sv, '192.168.1.100', '255.255.255.0');
  } },
  { id: 'static', title: 'Two LANs with static routes', desc: 'Two routers joined by 10.0.0.0/30, each with a LAN, using static routes.', build: async n => {
    const r1 = n.addDevice('2911', 250, 170), r2 = n.addDevice('2911', 550, 170), s1 = n.addDevice('2960-24TT', 100, 170), s2 = n.addDevice('2960-24TT', 700, 170);
    const p1 = n.addDevice('PC-PT', 40, 300), p2 = n.addDevice('PC-PT', 170, 300), p3 = n.addDevice('PC-PT', 640, 300), p4 = n.addDevice('PC-PT', 770, 300);
    link(n, r1, Gi(0), s1, Fa(24)); link(n, r1, Gi(1), r2, Gi(1)); link(n, r2, Gi(0), s2, Fa(24)); link(n, s1, Fa(1), p1, 'FastEthernet0'); link(n, s1, Fa(2), p2, 'FastEthernet0'); link(n, s2, Fa(1), p3, 'FastEthernet0'); link(n, s2, Fa(2), p4, 'FastEthernet0');
    host(p1, '192.168.1.10', '255.255.255.0', '192.168.1.1'); host(p2, '192.168.1.11', '255.255.255.0', '192.168.1.1'); host(p3, '192.168.2.10', '255.255.255.0', '192.168.2.1'); host(p4, '192.168.2.11', '255.255.255.0', '192.168.2.1');
    await cmd(n, r1, ['hostname R1', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'interface g0/1', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit', 'ip route 192.168.2.0 255.255.255.0 10.0.0.2']);
    await cmd(n, r2, ['hostname R2', 'interface g0/0', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'interface g0/1', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit', 'ip route 192.168.1.0 255.255.255.0 10.0.0.1']);
  } },
  { id: 'vlan', title: 'VLANs + router-on-a-stick', desc: 'Sales (VLAN 10) and Engineering (VLAN 20) routed over a trunk with sub-interfaces.', build: async n => {
    const r = n.addDevice('2911', 300, 40), sw = n.addDevice('2960-24TT', 300, 170); const a = n.addDevice('PC-PT', 130, 310), b = n.addDevice('PC-PT', 250, 340), c = n.addDevice('PC-PT', 370, 340), d = n.addDevice('PC-PT', 490, 310);
    link(n, r, Gi(0), sw, Gi(1)); link(n, sw, Fa(1), a, 'FastEthernet0'); link(n, sw, Fa(2), b, 'FastEthernet0'); link(n, sw, Fa(11), c, 'FastEthernet0'); link(n, sw, Fa(12), d, 'FastEthernet0');
    host(a, '192.168.10.10', '255.255.255.0', '192.168.10.1'); host(b, '192.168.10.11', '255.255.255.0', '192.168.10.1'); host(c, '192.168.20.10', '255.255.255.0', '192.168.20.1'); host(d, '192.168.20.11', '255.255.255.0', '192.168.20.1');
    await cmd(n, sw, ['hostname SW1', 'vlan 10', 'name Sales', 'vlan 20', 'name Engineering', 'interface range fa0/1 - 2', 'switchport access vlan 10', 'interface range fa0/11 - 12', 'switchport access vlan 20', 'interface g0/1', 'switchport mode trunk']);
    await cmd(n, r, ['hostname R1', 'interface g0/0', 'no shutdown', 'interface g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'interface g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0']);
  } },
  { id: 'ospf', title: 'OSPF triangle', desc: 'Three routers in a triangle running OSPF area 0, one LAN behind each.', build: async n => {
    const r1 = n.addDevice('2911', 300, 60), r2 = n.addDevice('2911', 120, 280), r3 = n.addDevice('2911', 480, 280);
    const p1 = n.addDevice('PC-PT', 300, 20), p2 = n.addDevice('PC-PT', 40, 420), p3 = n.addDevice('PC-PT', 560, 420);
    link(n, r1, Gi(0), r2, Gi(0)); link(n, r2, Gi(1), r3, Gi(1)); link(n, r3, Gi(0), r1, Gi(1)); link(n, r1, Gi(2), p1, 'FastEthernet0', 'cross'); link(n, r2, Gi(2), p2, 'FastEthernet0', 'cross'); link(n, r3, Gi(2), p3, 'FastEthernet0', 'cross');
    host(p1, '192.168.1.10', '255.255.255.0', '192.168.1.1'); host(p2, '192.168.2.10', '255.255.255.0', '192.168.2.1'); host(p3, '192.168.3.10', '255.255.255.0', '192.168.3.1');
    const cfg = (d: Dev, nm: string, a: [string, string][], rid: string) => cmd(n, d, [`hostname ${nm}`, ...a.flatMap(([i, ip]) => [`interface ${i}`, `ip address ${ip} ${ip.endsWith('.1') && i.endsWith('/2') ? '255.255.255.0' : '255.255.255.252'}`, 'no shutdown']), 'exit', 'router ospf 1', `router-id ${rid}`, 'network 10.0.0.0 0.0.255.255 area 0', 'network 192.168.0.0 0.0.255.255 area 0', 'passive-interface g0/2']);
    await cfg(r1, 'R1', [['g0/0', '10.0.0.1'], ['g0/1', '10.0.2.2'], ['g0/2', '192.168.1.1']], '1.1.1.1'); await cfg(r2, 'R2', [['g0/0', '10.0.0.2'], ['g0/1', '10.0.1.1'], ['g0/2', '192.168.2.1']], '2.2.2.2'); await cfg(r3, 'R3', [['g0/1', '10.0.1.2'], ['g0/0', '10.0.2.1'], ['g0/2', '192.168.3.1']], '3.3.3.3');
  } },
  { id: 'services', title: 'DHCP + DNS + Web server', desc: 'A server provides DHCP, DNS and HTTP. PCs get addresses automatically and browse www.cisconetx.local.', build: async n => {
    const sw = n.addDevice('2960-24TT', 300, 170), sv = n.addDevice('Server-PT', 300, 40), a = n.addDevice('PC-PT', 130, 310), b = n.addDevice('PC-PT', 300, 340), c = n.addDevice('Laptop-PT', 470, 310);
    link(n, sw, Fa(1), sv, 'FastEthernet0'); link(n, sw, Fa(2), a, 'FastEthernet0'); link(n, sw, Fa(3), b, 'FastEthernet0'); link(n, sw, Fa(4), c, 'FastEthernet0'); host(sv, '192.168.1.2', '255.255.255.0', '192.168.1.1', '192.168.1.2');
    sv.svc!.dhcp.on = true; sv.svc!.dhcp.pools[0] = { name: 'LAN', gw: '192.168.1.1', dns: '192.168.1.2', start: '192.168.1.100', mask: '255.255.255.0', max: 50 };
    sv.svc!.dns.on = true; sv.svc!.dns.records.push({ name: 'www.cisconetx.local', ip: '192.168.1.2' }); for (const d of [a, b, c]) d.cfg.hostDhcp = true;
  } },
  { id: 'nat', title: 'NAT overload + ACL', desc: 'An inside LAN reaches an outside server through PAT; an ACL blocks one inside host from the server.', build: async n => {
    const r = n.addDevice('2911', 330, 170), sw = n.addDevice('2960-24TT', 120, 170), a = n.addDevice('PC-PT', 40, 310), b = n.addDevice('PC-PT', 200, 310), isp = n.addDevice('2911', 540, 170), sv = n.addDevice('Server-PT', 700, 170);
    link(n, sw, Fa(24), r, Gi(0)); link(n, sw, Fa(1), a, 'FastEthernet0'); link(n, sw, Fa(2), b, 'FastEthernet0'); link(n, r, Gi(1), isp, Gi(0)); link(n, isp, Gi(1), sv, 'FastEthernet0', 'cross');
    host(a, '192.168.1.10', '255.255.255.0', '192.168.1.1'); host(b, '192.168.1.11', '255.255.255.0', '192.168.1.1'); host(sv, '203.0.113.10', '255.255.255.0', '203.0.113.1');
    await cmd(n, r, ['hostname EDGE', 'interface g0/0', 'ip address 192.168.1.1 255.255.255.0', 'ip nat inside', 'no shutdown', 'interface g0/1', 'ip address 198.51.100.2 255.255.255.252', 'ip nat outside', 'no shutdown', 'exit', 'access-list 1 permit 192.168.1.0 0.0.0.255', 'ip nat inside source list 1 interface g0/1 overload', 'ip route 0.0.0.0 0.0.0.0 198.51.100.1']);
    await cmd(n, isp, ['hostname ISP', 'interface g0/0', 'ip address 198.51.100.1 255.255.255.252', 'no shutdown', 'interface g0/1', 'ip address 203.0.113.1 255.255.255.0', 'no shutdown']);
  } },
];

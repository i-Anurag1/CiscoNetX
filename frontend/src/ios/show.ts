import type { Dev, IfCfg } from '../model/types.ts';
import type { Net } from '../model/net.ts';
import { isSwitch } from '../model/catalog.ts';
import { fmtIp, lenToMask, classfulLen, inNet, parseIp, netInt, macFrom } from '../lib/ip.ts';
import { isRouting, routingInfo } from '../sim/routing.ts';

export const hashOf = (s: string): string => '$1$mERr$' + [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36).padStart(8, '0').slice(0, 8) + '.';
const fmtAcl = (a: { any: boolean; ip: string; wild: string }): string => a.any ? 'any' : a.wild === '0.0.0.0' ? `host ${a.ip}` : `${a.ip} ${a.wild}`;
const pm = (m?: { op: string; a: number; b?: number }): string => !m ? '' : m.op === 'range' ? ` range ${m.a} ${m.b}` : ` ${m.op} ${m.a}`;

export function ifLine(d: Dev, c: IfCfg, net: Net): { status: string; proto: string } {
  if (c.type === 'lo') return { status: c.adminUp ? 'up' : 'administratively down', proto: c.adminUp ? 'up' : 'down' };
  if (!c.adminUp) return { status: 'administratively down', proto: 'down' };
  if (c.type === 'svi') { const l = net.l3ifs(d).find(i => i.name === c.name); const up = l ? l.up : net.vlanActive(d, Number(c.name.replace(/\D/g, ''))); return { status: up ? 'up' : 'down', proto: up ? 'up' : 'down' }; }
  if (c.type === 'sub') { const l = net.l3ifs(d).find(i => i.name === c.name); const par = d.cfg.ifs.find(i => i.name === c.parent); const pph = c.parent ? net.portPhy(d, c.parent) : null; const up = !!par?.adminUp && !!pph?.up; return { status: up ? 'up' : 'down', proto: up && (!l || l.up) ? 'up' : 'down' }; }
  const ph = net.portPhy(d, c.name); return { status: ph.up ? 'up' : 'down', proto: ph.up && ph.proto ? 'up' : 'down' };
}

export function runningConfig(d: Dev, net: Net, src: Dev['cfg'] = d.cfg): string {
  const c = src; const L: string[] = []; const sw = isSwitch(d.kind);
  L.push('!', 'version 15.1', 'no service timestamps log datetime msec', 'no service timestamps debug datetime msec', 'no service password-encryption', '!', `hostname ${c.hostname}`, '!', '!');
  if (c.secret) L.push(`enable secret 5 ${hashOf(c.secret)}`);
  L.push('!', '!', '!');
  if (!c.domainLookup) L.push('no ip domain-lookup');
  if (isRouting(d) && !sw) L.push('!', 'no ip cef', 'no ipv6 cef'); else if (sw && c.ipRouting) L.push('ip routing');
  for (const x of c.dhcpExcluded) L.push(`ip dhcp excluded-address ${x[0]}${x[1] !== x[0] ? ' ' + x[1] : ''}`);
  for (const p of c.dhcpPools) { L.push(`ip dhcp pool ${p.name}`, ` network ${p.net} ${p.mask}`); if (p.gw) L.push(` default-router ${p.gw}`); if (p.dns) L.push(` dns-server ${p.dns}`); L.push('!'); }
  if (sw) { L.push('!', 'spanning-tree mode pvst'); if (c.stpPrio !== 32768) L.push(`spanning-tree vlan 1 priority ${c.stpPrio}`); L.push('spanning-tree extend system-id'); }
  L.push('!');
  for (const [id, v] of Object.entries(c.vlans)) if (id !== '1') L.push(`vlan ${id}`, ` name ${v.name}`, '!');
  const order = (i: IfCfg) => (i.type === 'phys' ? 0 : i.type === 'lo' ? -1 : i.type === 'sub' ? 1 : 2);
  const ifs = [...c.ifs].sort((a, b) => order(a) - order(b));
  for (const i of ifs) {
    L.push(`interface ${i.name}`);
    if (i.desc) L.push(` description ${i.desc}`);
    if (i.type === 'sub') L.push(` encapsulation dot1Q ${i.vlan}${i.vlanNative ? ' native' : ''}`);
    if (sw && i.type === 'phys') {
      if (i.routed) L.push(' no switchport');
      else if (i.swMode === 'trunk') {
        L.push(' switchport mode trunk'); if (i.nativeVlan !== 1) L.push(` switchport trunk native vlan ${i.nativeVlan}`); if (i.allowed) L.push(` switchport trunk allowed vlan ${i.allowed}`);
      } else if (i.accessVlan !== 1) L.push(` switchport access vlan ${i.accessVlan}`);
      if (i.portfast) L.push(' spanning-tree portfast');
    }
    if (i.ip && i.mask) L.push(` ip address ${i.ip} ${i.mask}`);
    else if (i.dhcp) L.push(' ip address dhcp');
    else if (i.type !== 'phys' || !sw || i.routed) { if (i.type === 'svi' || i.type === 'phys' && !sw || i.type === 'lo') L.push(' no ip address'); }
    for (const h of i.helper) L.push(` ip helper-address ${h}`);
    if (i.aclIn) L.push(` ip access-group ${i.aclIn} in`); if (i.aclOut) L.push(` ip access-group ${i.aclOut} out`);
    if (i.nat) L.push(` ip nat ${i.nat}`);
    if (i.ospfCost !== undefined) L.push(` ip ospf cost ${i.ospfCost}`); if (i.ospfPrio !== undefined) L.push(` ip ospf priority ${i.ospfPrio}`);
    if (i.bandwidth !== undefined) L.push(` bandwidth ${i.bandwidth}`); if (i.delay !== undefined) L.push(` delay ${i.delay}`);
    if (i.clockRate !== undefined) L.push(` clock rate ${i.clockRate}`);
    if (i.type === 'phys' && !i.name.startsWith('Serial')) L.push(' duplex auto', ' speed auto');
    if (i.type !== 'lo' && !i.adminUp && !(i.type === 'svi' && false)) L.push(' shutdown');
    L.push('!');
  }
  for (const p of c.ospf) {
    L.push(`router ospf ${p.pid}`); if (p.rid) L.push(` router-id ${p.rid}`); L.push(' log-adjacency-changes');
    if (p.refBw !== 100) L.push(` auto-cost reference-bandwidth ${p.refBw}`);
    for (const x of p.passive) L.push(` passive-interface ${x}`); for (const n of p.nets) L.push(` network ${n.net} ${n.wild} area ${n.area}`);
    if (p.defOrig) L.push(' default-information originate'); if (p.redistStatic) L.push(' redistribute static'); if (p.redistConn) L.push(' redistribute connected'); L.push('!');
  }
  for (const e of c.eigrp) {
    L.push(`router eigrp ${e.as}`); for (const x of e.passive) L.push(` passive-interface ${x}`);
    for (const n of e.nets) L.push(` network ${n.net}${n.wild ? ' ' + n.wild : ''}`); if (!e.autoSum) L.push(' no auto-summary'); if (e.redistStatic) L.push(' redistribute static'); L.push('!');
  }
  if (c.rip) {
    L.push('router rip', ` version ${c.rip.version}`); for (const x of c.rip.passive) L.push(` passive-interface ${x}`);
    for (const n of c.rip.nets) L.push(` network ${n}`); if (c.rip.defOrig) L.push(' default-information originate'); if (c.rip.redistStatic) L.push(' redistribute static'); L.push(' no auto-summary', '!');
  }
  L.push('ip classless');
  if (c.defaultGw) L.push(`ip default-gateway ${c.defaultGw}`);
  for (const s of c.statics) L.push(`ip route ${s.net} ${s.mask} ${s.nh ?? s.ifn}${s.ad !== 1 ? ' ' + s.ad : ''}`);
  for (const n of c.natPools) L.push(`ip nat pool ${n.name} ${n.start} ${n.end} netmask ${n.mask}`);
  for (const r of c.natRules) L.push(`ip nat inside source list ${r.acl} ${r.pool ? 'pool ' + r.pool : 'interface ' + r.ifn}${r.overload ? ' overload' : ''}`);
  for (const s of c.natStatics) L.push(`ip nat inside source static ${s.local} ${s.global}`);
  L.push('!');
  for (const a of c.acls) {
    const numbered = /^\d+$/.test(a.name);
    if (!numbered) L.push(`ip access-list ${a.ext ? 'extended' : 'standard'} ${a.name}`);
    for (const e of a.entries) {
      const body = a.ext ? `${e.action} ${e.proto} ${fmtAcl(e.src)}${pm(e.sp)} ${fmtAcl(e.dst)}${pm(e.dp)}` : `${e.action} ${fmtAcl(e.src)}`;
      L.push(numbered ? `access-list ${a.name} ${body}` : ` ${body}`);
    }
    if (!numbered) L.push('!');
  }
  L.push('!', '!', '!', '!', 'line con 0'); if (c.conPw) L.push(` password ${c.conPw}`); if (c.conLogin) L.push(' login');
  L.push('!', 'line vty 0 4'); if (c.vtyPw) L.push(` password ${c.vtyPw}`); L.push(c.vtyLogin ? ' login' : ' login'); L.push('!', '!', '!', 'end');
  return L.join('\n');
}

const CODES = `Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP
       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area
       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2
       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP
       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area
       * - candidate default, U - per-user static route, o - ODR
       P - periodic downloaded static route`;
export function showIpRoute(d: Dev, net: Net, filter?: string): string {
  const all = (routingInfo(net).routes.get(d.id) ?? []).filter(r => !filter || (filter === 'static' ? r.code === 'S' : filter === 'connected' ? r.code === 'C' : filter === 'rip' ? r.code === 'R' : filter === 'ospf' ? r.code.startsWith('O') : filter === 'eigrp' ? r.code.startsWith('D') : true));
  const L: string[] = [CODES, ''];
  const def = all.find(r => r.len === 0);
  L.push(def ? `Gateway of last resort is ${def.nh ?? 'not set'} to network 0.0.0.0` : 'Gateway of last resort is not set', '');
  const groups = new Map<number, typeof all>();
  for (const r of all) { if (r.len === 0) continue; const k = netInt(r.net, classfulLen(fmtIp(r.net))); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  const line = (r: typeof all[number]): string => {
    const code = (r.len === 0 && !r.code.includes('*') ? r.code + '*' : r.code).padEnd(8); const p = `${fmtIp(r.net)}/${r.len}`;
    if (r.code === 'C') return `${code}${p} is directly connected, ${r.ifn}`; if (r.code === 'L') return `${code}${p} is directly connected, ${r.ifn}`;
    if (r.code === 'S') return r.nh ? `${code}${p} [${r.ad}/0] via ${r.nh}` : `${code}${p} is directly connected, ${r.ifn}`;
    return `${code}${p} [${r.ad}/${r.metric}] via ${r.nh}, 00:00:${String(10 + (r.metric % 50)).padStart(2, '0')}, ${r.ifn}`;
  };
  for (const [k, rs] of groups) {
    const cl = classfulLen(fmtIp(k)); const masks = new Set(rs.map(r => r.len));
    L.push(`      ${fmtIp(k)}/${cl} is ${masks.size > 1 ? 'variably ' : ''}subnetted, ${rs.length} subnets${masks.size > 1 ? ', ' + masks.size + ' masks' : ''}`);
    for (const r of rs) L.push(line(r));
  }
  if (def) L.push(line(def));
  return L.join('\n');
}
export function showIpIntBrief(d: Dev, net: Net): string {
  const rows = ['Interface              IP-Address      OK? Method Status                Protocol'];
  const list = d.cfg.ifs.filter(i => d.kind !== 'hub').sort((a, b) => (a.type === 'phys' ? 0 : 1) - (b.type === 'phys' ? 0 : 1));
  for (const i of list) {
    const st = ifLine(d, i, net);
    rows.push(`${i.name.padEnd(23)}${(i.ip ?? 'unassigned').padEnd(16)}YES ${(i.ip ? (i.dhcp ? 'DHCP' : 'manual') : 'unset').padEnd(7)}${st.status.padEnd(22)}${st.proto}`);
  }
  return rows.join('\n');
}
export function showInterface(d: Dev, c: IfCfg, net: Net): string {
  const st = ifLine(d, c, net); const p = d.ports.find(x => x.name === c.name);
  const fast = c.name.startsWith('Fast'), ser = c.name.startsWith('Serial');
  const L = [`${c.name} is ${st.status}, line protocol is ${st.proto} (${st.proto === 'up' ? 'connected' : 'disabled'})`, `  Hardware is ${ser ? 'HD64570' : c.type === 'phys' ? (fast ? 'Lance, address is ' : 'CN Gigabit Ethernet, address is ') + (p?.mac ?? '') : 'Virtual interface'}${p ? ' (bia ' + p.mac + ')' : ''}`];
  if (c.desc) L.push(`  Description: ${c.desc}`);
  if (c.ip && c.mask) L.push(`  Internet address is ${c.ip}/${[...c.mask.split('.')].reduce((n, o) => n + Number(o).toString(2).replace(/0/g, '').length, 0)}`);
  L.push(`  MTU 1500 bytes, BW ${c.bandwidth ?? (ser ? 1544 : fast ? 100000 : 1000000)} Kbit, DLY ${c.delay !== undefined ? c.delay * 10 : ser ? 20000 : fast ? 100 : 10} usec,`, '     reliability 255/255, txload 1/255, rxload 1/255', `  Encapsulation ${c.type === 'sub' ? 'dot1Q Virtual LAN, Vlan ID  ' + c.vlan : ser ? 'HDLC' : 'ARPA'}, loopback not set`);
  if (c.type === 'phys' && !ser) L.push('  Full-duplex, 100Mb/s, media type is RJ45');
  L.push('  Last input never, output never, output hang never', '  Queueing strategy: fifo', '  0 packets input, 0 bytes, 0 no buffer', '  0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored', '  0 packets output, 0 bytes, 0 underruns');
  return L.join('\n');
}
export function showVlanBrief(d: Dev): string {
  const L = ['VLAN Name                             Status    Ports', '---- -------------------------------- --------- -------------------------------'];
  for (const [id, v] of Object.entries(d.cfg.vlans).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const ports = d.cfg.ifs.filter(i => i.type === 'phys' && !i.routed && i.swMode === 'access' && i.accessVlan === Number(id)).map(i => i.name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig'));
    let first = true; const chunks: string[] = []; for (let k = 0; k < ports.length; k += 4) chunks.push(ports.slice(k, k + 4).join(', '));
    if (!chunks.length) chunks.push('');
    for (const ch of chunks) { L.push(first ? `${id.padEnd(5)}${v.name.padEnd(33)}active    ${ch}` : `${' '.repeat(47)}${ch}`); first = false; }
  }
  L.push('1002 fddi-default                     act/unsup', '1003 token-ring-default               act/unsup', '1004 fddinet-default                  act/unsup', '1005 trnet-default                    act/unsup');
  return L.join('\n');
}
export function showMac(d: Dev): string {
  const L = ['          Mac Address Table', '-------------------------------------------', '', 'Vlan    Mac Address       Type        Ports', '----    -----------       --------    -----'];
  for (const m of d.rt.macTable) L.push(`${String(m.vlan).padEnd(8)}${m.mac.toLowerCase().padEnd(18)}DYNAMIC     ${m.port.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gi')}`);
  L.push(`Total Mac Addresses for this criterion: ${d.rt.macTable.length}`); return L.join('\n');
}
export function showCdp(d: Dev, net: Net): string {
  const L = ['Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge', '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone', 'Device ID        Local Intrfce     Holdtme    Capability       Platform  Port ID'];
  for (const p of d.ports) {
    const pe = net.peerOf(d.id, p.name); if (!pe || pe.cable.type === 'console' || !net.portPhy(d, p.name).up) continue;
    if (!pe.dev.cfg.cdp || pe.dev.kind === 'hub' || pe.dev.kind === 'pc' || pe.dev.kind === 'laptop' || pe.dev.kind === 'server') continue;
    const cap = pe.dev.kind === 'router' ? 'R' : 'S'; const short = (n: string) => n.replace('FastEthernet', 'Fas ').replace('GigabitEthernet', 'Gig ').replace('Serial', 'Ser ');
    L.push(`${pe.dev.cfg.hostname.padEnd(17)}${short(p.name).padEnd(18)}${'150'.padEnd(11)}${cap.padEnd(17)}${pe.dev.model.padEnd(10)}${short(pe.port)}`);
  }
  return L.join('\n');
}
export function showArp(d: Dev): string {
  const L = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  for (const [ip, e] of Object.entries(d.rt.arp)) L.push(`Internet  ${ip.padEnd(17)}${'0'.padEnd(11)}${e.mac.toLowerCase().padEnd(16)}ARPA   ${e.ifn}`);
  return L.join('\n');
}
export function showNat(d: Dev): string {
  const L = ['Pro Inside global      Inside local       Outside local      Outside global'];
  for (const s of d.cfg.natStatics) L.push(`---  ${s.global.padEnd(18)}${s.local.padEnd(19)}---                ---`);
  for (const n of d.rt.nat) { const f = (ip: string, p: number) => n.proto === 'icmp' ? `${ip}:${p}` : `${ip}:${p}`; L.push(`${n.proto.padEnd(4)}${f(n.inGlobal, n.gp).padEnd(19)}${f(n.inLocal, n.lp).padEnd(19)}${n.outLocal.padEnd(19)}${n.outGlobal}`); }
  return L.join('\n');
}
export function showAcls(d: Dev): string {
  const L: string[] = [];
  for (const a of d.cfg.acls) {
    L.push(`${a.ext ? 'Extended' : 'Standard'} IP access list ${a.name}`);
    a.entries.forEach((e, i) => L.push(`    ${(i + 1) * 10} ${a.ext ? `${e.action} ${e.proto} ${fmtAcl(e.src)}${pm(e.sp)} ${fmtAcl(e.dst)}${pm(e.dp)}` : `${e.action} ${fmtAcl(e.src)}`}${e.hits ? ` (${e.hits} match(es))` : ''}`));
  }
  return L.join('\n');
}
export function showProtocols(d: Dev, net: Net): string {
  const L: string[] = []; const info = routingInfo(net);
  if (d.cfg.rip) { L.push('Routing Protocol is "rip"', '  Sending updates every 30 seconds, next due in 12 seconds', `  Default version control: send version ${d.cfg.rip.version}, receive version ${d.cfg.rip.version}`, '  Routing for Networks:', ...d.cfg.rip.nets.map(n => `    ${n}`), '  Routing Information Sources:', '    Gateway         Distance      Last Update', ...(info.rip.get(d.id) ?? []).map(n => `    ${n.addr.padEnd(16)}120           00:00:10`), '  Distance: (default is 120)', ''); }
  for (const o of d.cfg.ospf) { L.push(`Routing Protocol is "ospf ${o.pid}"`, `  Router ID ${info.rids.get(d.id) ?? '0.0.0.0'}`, '  Routing for Networks:', ...o.nets.map(n => `    ${n.net} ${n.wild} area ${n.area}`), '  Distance: (default is 110)', ''); }
  for (const e of d.cfg.eigrp) { L.push(`Routing Protocol is "eigrp ${e.as}"`, '  Automatic network summarization is ' + (e.autoSum ? 'in effect' : 'not in effect'), '  Routing for Networks:', ...e.nets.map(n => `    ${n.net}`), '  Distance: internal 90 external 170', ''); }
  return L.length ? L.join('\n') : '';
}
export function showOspfNbr(d: Dev, net: Net): string {
  const L = ['Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  for (const n of routingInfo(net).ospf.get(d.id) ?? []) L.push(`${n.rid.padEnd(16)}${String(n.prio).padEnd(6)}${n.state.padEnd(16)}00:00:34    ${n.addr.padEnd(16)}${n.ifn}`);
  return L.join('\n');
}
export function showEigrpNbr(d: Dev, net: Net): string {
  const e = d.cfg.eigrp[0]; const L = [`EIGRP-IPv4 Neighbors for AS(${e?.as ?? 0})`, 'H   Address                 Interface              Hold Uptime   SRTT   RTO  Q  Seq', '                                                   (sec)         (ms)       Cnt Num'];
  (routingInfo(net).eigrp.get(d.id) ?? []).forEach((n, i) => L.push(`${String(i).padEnd(4)}${n.addr.padEnd(24)}${n.ifn.padEnd(23)}13 00:00:30   40   1000  0  ${i + 1}`));
  return L.join('\n');
}
export function showDhcpBinding(d: Dev): string {
  const L = ['IP address       Client-ID/              Lease expiration        Type', '                 Hardware address']; for (const b of d.rt.binds) L.push(`${b.ip.padEnd(17)}${b.mac.toLowerCase().padEnd(24)}--                      Automatic`); return L.join('\n');
}
export function showStp(d: Dev, net: Net): string {
  const prio = d.cfg.stpPrio; const mac = d.ports[0]?.mac ?? '';
  const L = ['VLAN0001', '  Spanning tree enabled protocol ieee', `  Root ID    Priority    ${prio + 1}`, `             Address     ${mac}`, '', `  Bridge ID  Priority    ${prio + 1}  (priority ${prio} sys-id-ext 1)`, `             Address     ${mac}`, '             Aging Time  20', '', 'Interface        Role Sts Cost      Prio.Nbr Type', '---------------- ---- --- --------- -------- --------------------------------'];
  for (const p of d.ports) { const ph = net.portPhy(d, p.name); if (!ph.up || p.kind === 'Console') continue; L.push(`${p.short.padEnd(17)}${(ph.stp === 'blk' ? 'Altn' : 'Desg').padEnd(5)}${(ph.stp === 'fwd' ? 'FWD' : ph.stp === 'blk' ? 'BLK' : 'LRN').padEnd(4)}${(p.kind === 'GigabitEthernet' ? '4' : '19').padEnd(10)}128.${p.name.replace(/\D/g, '').slice(-2) || 1}   P2p`); }
  return L.join('\n');
}
export function showTrunk(d: Dev, net: Net): string {
  const tr = d.cfg.ifs.filter(i => i.type === 'phys' && i.swMode === 'trunk');
  const L = ['Port        Mode         Encapsulation  Status        Native vlan']; for (const i of tr) L.push(`${i.name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig').padEnd(12)}on           802.1q         ${net.portPhy(d, i.name).up ? 'trunking' : 'not-trunking'}      ${i.nativeVlan}`);
  L.push('', 'Port        Vlans allowed on trunk'); for (const i of tr) L.push(`${i.name.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig').padEnd(12)}${i.allowed || '1-4094'}`); return L.join('\n');
}
export function showVersion(d: Dev): string {
  return [`CiscoNetX Simulated IOS Software, ${d.kind === 'router' ? 'C' + d.model : 'C' + d.model} Software (simulated), Version 15.1(4)M4`, 'Technical Support: https://github.com/i-Anurag1/CiscoNetX', '', `ROM: System Bootstrap, Version 15.1(4)M4`, `${d.cfg.hostname} uptime is 1 minute`, `cisco ${d.model} (CiscoNetX) processor with 491520K/32768K bytes of memory.`, `Processor board ID ${d.ports[0]?.mac.replace(/\./g, '')}`, `${d.ports.filter(p => p.kind === 'GigabitEthernet').length} Gigabit Ethernet interfaces`, `${d.ports.filter(p => p.kind === 'FastEthernet').length} FastEthernet interfaces`, `${d.ports.filter(p => p.kind === 'Serial').length} Serial interfaces`, '', 'Configuration register is 0x2102'].join('\n');
}
void inNet; void lenToMask; void parseIp; void macFrom;

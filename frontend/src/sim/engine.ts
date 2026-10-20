import type { Dev, L3If, Acl, AclEntry } from '../model/types.ts';
import type { Net } from '../model/net.ts';
import { allowsVlan } from '../model/net.ts';
import { isHost, isSwitch } from '../model/catalog.ts';
import { BCAST_MAC, bcastOf, inNet, ipCmp, isIp, maskToLen, parseIp, sameNet, wildMatch, fmtIp, netInt } from '../lib/ip.ts';
import { isRouting, lookup, routingInfo } from './routing.ts';

export interface ArpPdu { op: 1 | 2; sha: string; spa: string; tha: string; tpa: string }
export interface Pkt {
  src: string; dst: string; ttl: number; proto: 'icmp' | 'tcp' | 'udp'; id: number; size: number;
  icmp?: { type: number; code: number; id: number; seq: number };
  l4?: { sport: number; dport: number; flags?: string; data?: Record<string, any> };
}
export interface Frame { src: string; dst: string; vlan: number | null; kind: 'arp' | 'ip'; pdu: number; arp?: ArpPdu; ip?: Pkt }
export interface TEv { t: number; seq: number; pdu: number; at: string; from: string | null; atPort?: string; fromPort?: string; type: string; info: string; status: 'ok' | 'drop'; frame: Frame }

const LAN_HOP = 0.00025, SERIAL_HOP = 0.005;
export class Trace {
  events: TEv[] = []; seq = 0; budget = 6000; pduN = 0; ipId = 100; sport = 49152;
  waiters = new Map<string, { t: number; pkt: Pkt } | null>();
  pending = new Map<string, { pkt: Pkt; nh: string; ifn: string }[]>();
  net: Net;
  constructor(net: Net) { this.net = net; }
  newPdu(): number { return ++this.pduN; }
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
export const defTtl = (d: Dev): number => (d.kind === 'pc' || d.kind === 'laptop' || d.kind === 'server') ? 128 : 255;
export function frameType(fr: Frame): string {
  if (fr.kind === 'arp') return 'ARP';
  const p = fr.ip!;
  if (p.proto === 'icmp') return 'ICMP';
  if (p.proto === 'udp') { const d = p.l4!; return d.dport === 53 || d.sport === 53 ? 'DNS' : d.dport === 67 || d.dport === 68 ? 'DHCP' : 'UDP'; }
  return p.l4?.data?.app === 'HTTP' ? 'HTTP' : 'TCP';
}
export function frameInfo(fr: Frame): string {
  if (fr.kind === 'arp') return fr.arp!.op === 1 ? `ARP request: who has ${fr.arp!.tpa}? tell ${fr.arp!.spa}` : `ARP reply: ${fr.arp!.spa} is at ${fr.arp!.sha}`;
  const p = fr.ip!;
  if (p.proto === 'icmp') { const t = p.icmp!.type; return `${t === 8 ? 'ICMP echo request' : t === 0 ? 'ICMP echo reply' : t === 3 ? 'ICMP destination unreachable' : 'ICMP time exceeded'} ${p.src} > ${p.dst}`; }
  const d = p.l4!;
  const k = d.data?.k ? ` ${d.data.k}` : d.flags ? ` [${d.flags}]` : '';
  return `${frameType(fr)}${k} ${p.src}:${d.sport} > ${p.dst}:${d.dport}`;
}
function emit(tr: Trace, dev: Dev, from: string | null, atPort: string | undefined, fromPort: string | undefined, fr: Frame, t: number, status: 'ok' | 'drop', why?: string): void {
  if (tr.events.length > 4000) return;
  tr.events.push({ t, seq: tr.seq++, pdu: fr.pdu, at: dev.id, from, atPort, fromPort, type: frameType(fr), info: why ? `${frameInfo(fr)} — ${why}` : frameInfo(fr), status, frame: clone(fr) });
}
const ifsOf = (net: Net, d: Dev): L3If[] => {
  const l = net.l3ifs(d);
  if (isHost(d.kind) && !l.length) {
    const p = d.ports.find(x => x.kind === 'FastEthernet'); const c = p && net.cfgIf(d, p.name);
    if (p && c) { const ph = net.portPhy(d, p.name); return [{ name: p.name, ip: '0.0.0.0', mask: '0.0.0.0', mac: p.mac, up: d.power && ph.up && ph.proto, port: p.name, tag: null, cfg: c }]; }
  }
  return l;
};
export const nicOf = (net: Net, d: Dev): L3If | undefined => ifsOf(net, d)[0];

// ---------- link layer ----------
export function ethTx(tr: Trace, dev: Dev, port: string, fr: Frame, t: number): void {
  const net = tr.net; const pe = net.peerOf(dev.id, port); if (!pe || pe.cable.type === 'console') return;
  const a = net.portPhy(dev, port), b = net.portPhy(pe.dev, pe.port);
  if (!(a.up && a.proto && b.up && b.proto)) { emit(tr, dev, null, port, undefined, fr, t, 'drop', 'link is down'); return; }
  if (isSwitch(dev.kind) && a.stp !== 'fwd') return;
  if (--tr.budget <= 0) return;
  recv(tr, pe.dev, pe.port, clone(fr), t + (pe.cable.type === 'serial' ? SERIAL_HOP : LAN_HOP), dev.id, port);
}
function txIf(tr: Trace, dev: Dev, ifc: L3If, fr: Frame, t: number): void {
  fr.vlan = ifc.tag ?? null;
  if (ifc.port) ethTx(tr, dev, ifc.port, fr, t); else if (ifc.vlan !== undefined) bridgeOut(tr, dev, ifc.vlan, fr, t, null);
}
function recv(tr: Trace, dev: Dev, port: string, fr: Frame, t: number, fromId: string, fromPort: string): void {
  if (!dev.power) return;
  if (dev.kind === 'hub') {
    emit(tr, dev, fromId, port, fromPort, fr, t, 'ok', 'hub repeats the signal');
    for (const p of dev.ports) if (p.name !== port) ethTx(tr, dev, p.name, clone(fr), t);
  } else if (isSwitch(dev.kind)) bridgeIn(tr, dev, port, fr, t, fromId, fromPort);
  else l3Recv(tr, dev, port, fr, t, fromId, fromPort);
}

function bridgeIn(tr: Trace, sw: Dev, port: string, fr: Frame, t: number, fromId: string, fromPort: string): void {
  const net = tr.net; const ic = net.cfgIf(sw, port); const ph = net.portPhy(sw, port);
  if (!ic || ph.stp !== 'fwd') return;
  if (ic.routed) { l3Recv(tr, sw, port, fr, t, fromId, fromPort); return; }
  let vlan: number;
  if (ic.swMode === 'access') { if (fr.vlan !== null) { emit(tr, sw, fromId, port, fromPort, fr, t, 'drop', 'tagged frame on access port'); return; } vlan = ic.accessVlan; }
  else { vlan = fr.vlan ?? ic.nativeVlan; if (!allowsVlan(ic.allowed, vlan)) { emit(tr, sw, fromId, port, fromPort, fr, t, 'drop', `VLAN ${vlan} not allowed on trunk`); return; } }
  emit(tr, sw, fromId, port, fromPort, fr, t, 'ok');
  if (fr.src !== BCAST_MAC) {
    const e = sw.rt.macTable.find(m => m.vlan === vlan && m.mac === fr.src);
    if (e) e.port = port; else if (sw.rt.macTable.length < 2000) sw.rt.macTable.push({ vlan, mac: fr.src, port });
  }
  bridgeOut(tr, sw, vlan, fr, t, port);
}
function bridgeOut(tr: Trace, sw: Dev, vlan: number, fr0: Frame, t: number, ingress: string | null): void {
  const net = tr.net; const fr = clone(fr0); fr.vlan = null;
  const mine = sw.ports[0]?.mac; const bc = fr.dst === BCAST_MAC;
  const svi = net.l3ifs(sw).find(i => i.vlan === vlan && i.up);
  if ((fr.dst === mine || bc) && svi && ingress !== null) l3Input(tr, sw, svi, fr, t, null, undefined, undefined, true);
  if (fr.dst === mine) return;
  const out = (p: string) => {
    const oc = net.cfgIf(sw, p); const op = net.portPhy(sw, p); if (!oc || oc.routed || op.stp !== 'fwd' || p === ingress) return;
    const f = clone(fr);
    if (oc.swMode === 'access') { if (oc.accessVlan !== vlan) return; f.vlan = null; }
    else { if (!allowsVlan(oc.allowed, vlan)) return; f.vlan = vlan === oc.nativeVlan ? null : vlan; }
    ethTx(tr, sw, p, f, t);
  };
  if (!bc) {
    const e = sw.rt.macTable.find(m => m.vlan === vlan && m.mac === fr.dst);
    if (e) { if (e.port !== ingress) out(e.port); return; }
  }
  for (const p of sw.ports) out(p.name);
}

// ---------- network layer ----------
function l3Recv(tr: Trace, dev: Dev, port: string, fr: Frame, t: number, fromId: string, fromPort: string): void {
  const ifcs = ifsOf(tr.net, dev);
  const ifc = ifcs.find(i => i.port === port && (i.tag ?? null) === (fr.vlan ?? null) && i.cfg.type !== 'lo');
  if (!ifc || !ifc.up) { if (isHost(dev.kind) || dev.kind === 'router') emit(tr, dev, fromId, port, fromPort, fr, t, 'drop', 'interface has no IP configuration'); return; }
  if (fr.dst !== ifc.mac && fr.dst !== BCAST_MAC) { emit(tr, dev, fromId, port, fromPort, fr, t, 'drop', 'frame is not addressed to this device'); return; }
  l3Input(tr, dev, ifc, fr, t, fromId, port, fromPort, false);
}
function l3Input(tr: Trace, dev: Dev, ifc: L3If, fr: Frame, t: number, fromId: string | null, atPort: string | undefined, fromPort: string | undefined, quiet: boolean): void {
  const net = tr.net;
  if (fr.kind === 'arp') {
    const a = fr.arp!;
    if (a.tpa !== ifc.ip || ifc.ip === '0.0.0.0') { if (!quiet) emit(tr, dev, fromId, atPort, fromPort, fr, t, 'drop', 'ARP target is not this device'); return; }
    if (!quiet) emit(tr, dev, fromId, atPort, fromPort, fr, t, 'ok');
    dev.rt.arp[a.spa] = { mac: a.sha, ifn: ifc.name };
    if (a.op === 1) {
      const rep: Frame = { src: ifc.mac, dst: a.sha, vlan: null, kind: 'arp', pdu: tr.newPdu(), arp: { op: 2, sha: ifc.mac, spa: ifc.ip, tha: a.sha, tpa: a.spa } };
      emit(tr, dev, null, undefined, undefined, rep, t + 0.0001, 'ok'); txIf(tr, dev, ifc, rep, t + 0.0001);
    } else flush(tr, dev, a.spa, t);
    return;
  }
  const p0 = fr.ip!; const p = clone(p0);
  if (!quiet) emit(tr, dev, fromId, atPort, fromPort, fr, t, 'ok');
  const dhcpClient = p.proto === 'udp' && p.l4!.dport === 68;
  if (ifc.ip === '0.0.0.0' && !dhcpClient) return;
  const acl = ifc.cfg.aclIn ? dev.cfg.acls.find(a => a.name === ifc.cfg.aclIn) : undefined;
  if (acl && aclEval(acl, p) === 'deny') { emit(tr, dev, null, undefined, undefined, fr, t, 'drop', `denied by access-list ${acl.name}`); icmpError(tr, dev, ifc, p, 3, 13, t); return; }
  if (isRouting(dev) && ifc.cfg.nat === 'outside') natIn(dev, p);
  const bc = p.dst === '255.255.255.255' || (ifc.ip !== '0.0.0.0' && p.dst === bcastOf(ifc.ip, ifc.mask));
  const mine = bc || ifsOf(net, dev).some(i => i.up && i.ip === p.dst);
  if (mine) { local(tr, dev, ifc, p, t); return; }
  if (isRouting(dev)) { forward(tr, dev, ifc, p, t); return; }
  emit(tr, dev, null, undefined, undefined, fr, t, 'drop', 'destination IP is not this host');
}
function icmpError(tr: Trace, dev: Dev, inIf: L3If, orig: Pkt, type: number, code: number, t: number): void {
  if (orig.proto === 'icmp' && orig.icmp!.type !== 8 && orig.icmp!.type !== 0) return;
  const pkt: Pkt = { src: inIf.ip, dst: orig.src, ttl: defTtl(dev), proto: 'icmp', id: tr.ipId++, size: 56, icmp: { type, code, id: orig.icmp?.id ?? 0, seq: orig.icmp?.seq ?? 0 } };
  originate(tr, dev, pkt, t + 0.0002, { hold: true, quiet: false });
}
function forward(tr: Trace, dev: Dev, inIf: L3If, p: Pkt, t: number): void {
  if (p.ttl <= 1) { icmpError(tr, dev, inIf, p, 11, 0, t); return; }
  p.ttl--;
  const info = routingInfo(tr.net); const rt = lookup(info.routes.get(dev.id) ?? [], p.dst);
  if (!rt || rt.code === 'L') { icmpError(tr, dev, inIf, p, 3, 0, t); return; }
  const out = ifsOf(tr.net, dev).find(i => i.name === rt.ifn);
  if (!out || !out.up) { icmpError(tr, dev, inIf, p, 3, 1, t); return; }
  if (inIf.cfg.nat === 'inside' && out.cfg.nat === 'outside') natOut(dev, p, out);
  const acl = out.cfg.aclOut ? dev.cfg.acls.find(a => a.name === out.cfg.aclOut) : undefined;
  if (acl && aclEval(acl, p) === 'deny') { icmpError(tr, dev, inIf, p, 3, 13, t); return; }
  sendVia(tr, dev, out, rt.nh ?? p.dst, p, t + 0.0001, true, p.id * 0 + 0, false);
}
function flush(tr: Trace, dev: Dev, ip: string, t: number): void {
  const q = tr.pending.get(dev.id); if (!q) return;
  const rest = q.filter(x => x.nh !== ip); const go = q.filter(x => x.nh === ip);
  tr.pending.set(dev.id, rest);
  for (const g of go) { const out = ifsOf(tr.net, dev).find(i => i.name === g.ifn); if (out) sendVia(tr, dev, out, g.nh, g.pkt, t + 0.0001, true, 0, false); }
}
type Res = 'sent' | 'arp' | 'noroute' | 'down';
function sendVia(tr: Trace, dev: Dev, out: L3If, nh: string, pkt: Pkt, t: number, hold: boolean, _unused: number, _q: boolean): Res {
  void _unused; void _q;
  const hit = dev.rt.arp[nh];
  if (hit && hit.ifn === out.name) {
    const fr: Frame = { src: out.mac, dst: hit.mac, vlan: null, kind: 'ip', pdu: pkt.id, ip: clone(pkt) }; txIf(tr, dev, out, fr, t); return 'sent';
  }
  const req: Frame = { src: out.mac, dst: BCAST_MAC, vlan: null, kind: 'arp', pdu: tr.newPdu(), arp: { op: 1, sha: out.mac, spa: out.ip, tha: '0000.0000.0000', tpa: nh } };
  if (hold) { const q = tr.pending.get(dev.id) ?? []; q.push({ pkt: clone(pkt), nh, ifn: out.name }); tr.pending.set(dev.id, q); }
  emit(tr, dev, null, undefined, undefined, req, t, 'ok'); txIf(tr, dev, out, req, t);
  if (!hold) emit(tr, dev, null, undefined, undefined, { src: out.mac, dst: BCAST_MAC, vlan: null, kind: 'ip', pdu: pkt.id, ip: clone(pkt) }, t, 'drop', 'ARP resolution pending; packet dropped');
  return 'arp';
}
export function originate(tr: Trace, dev: Dev, pkt: Pkt, t: number, o: { hold: boolean; quiet: boolean; srcIp?: string }): Res {
  const net = tr.net; const ifcs = ifsOf(net, dev).filter(i => i.up);
  let out: L3If | undefined; let nh = pkt.dst;
  if (isRouting(dev)) {
    const rt = lookup(routingInfo(net).routes.get(dev.id) ?? [], pkt.dst);
    if (!rt) return 'noroute';
    if (rt.code === 'L') { out = ifcs.find(i => i.name === rt.ifn); if (!out) return 'down'; local(tr, dev, out, clone(pkt), t); return 'sent'; }
    out = ifcs.find(i => i.name === rt.ifn); nh = rt.nh ?? pkt.dst;
  } else {
    out = ifcs.find(i => i.ip !== '0.0.0.0' && sameNet(i.ip, pkt.dst, i.mask));
    if (!out) {
      const gw = isHost(dev.kind) ? dev.cfg.hostGw : dev.cfg.defaultGw;
      if (!gw || !isIp(gw)) return ifcs.length ? 'noroute' : 'down';
      out = ifcs.find(i => i.ip !== '0.0.0.0' && sameNet(i.ip, gw, i.mask)); nh = gw;
      if (!out) return 'noroute';
    }
    if (out.ip === pkt.dst) { local(tr, dev, out, clone(pkt), t); return 'sent'; }
  }
  if (!out || !out.up) return 'down';
  if (!pkt.src || o.srcIp) pkt.src = o.srcIp || out.ip;
  if (!o.quiet) emit(tr, dev, null, undefined, undefined, { src: out.mac, dst: '', vlan: null, kind: 'ip', pdu: pkt.id, ip: clone(pkt) }, t, 'ok');
  if (isRouting(dev) && out.cfg.nat === 'outside') void 0;
  return sendVia(tr, dev, out, nh, pkt, t, o.hold, 0, false);
}
function txBroadcast(tr: Trace, dev: Dev, ifc: L3If, pkt: Pkt, dstMac: string, t: number): void {
  const fr: Frame = { src: ifc.mac, dst: dstMac, vlan: null, kind: 'ip', pdu: tr.newPdu(), ip: pkt };
  emit(tr, dev, null, undefined, undefined, fr, t, 'ok'); txIf(tr, dev, ifc, fr, t);
}

// ---------- ACL / NAT ----------
function pmatch(m: { op: string; a: number; b?: number } | undefined, port: number): boolean {
  if (!m) return true;
  switch (m.op) { case 'eq': return port === m.a; case 'neq': return port !== m.a; case 'gt': return port > m.a; case 'lt': return port < m.a; default: return port >= m.a && port <= (m.b ?? m.a); }
}
export function aclEval(acl: Acl, p: Pkt): 'permit' | 'deny' {
  for (const e of acl.entries as AclEntry[]) {
    if (e.proto !== 'ip' && e.proto !== p.proto) continue;
    if (!e.src.any && !wildMatch(p.src, e.src.ip, e.src.wild)) continue;
    if (acl.ext) {
      if (!e.dst.any && !wildMatch(p.dst, e.dst.ip, e.dst.wild)) continue;
      if (p.l4 && (p.proto === 'tcp' || p.proto === 'udp') && (!pmatch(e.sp, p.l4.sport) || !pmatch(e.dp, p.l4.dport))) continue;
    }
    e.hits++; return e.action;
  }
  return 'deny';
}
function natIn(dev: Dev, p: Pkt): void {
  const st = dev.cfg.natStatics.find(s => s.global === p.dst); if (st) { p.dst = st.local; return; }
  const k = p.proto === 'icmp' ? p.icmp!.id : p.l4!.dport;
  const t = dev.rt.nat.find(n => n.proto === p.proto && n.inGlobal === p.dst && n.gp === k && (p.proto === 'icmp' || true));
  if (t) { p.dst = t.inLocal; if (p.proto === 'icmp') p.icmp!.id = t.lp; else p.l4!.dport = t.lp; }
}
function natOut(dev: Dev, p: Pkt, out: L3If): void {
  const st = dev.cfg.natStatics.find(s => s.local === p.src); if (st) { p.src = st.global; return; }
  const lp = p.proto === 'icmp' ? p.icmp!.id : p.l4!.sport;
  const ex = dev.rt.nat.find(n => n.proto === p.proto && n.inLocal === p.src && n.lp === lp); if (ex) { p.src = ex.inGlobal; if (p.proto === 'icmp') p.icmp!.id = ex.gp; else p.l4!.sport = ex.gp; return; }
  for (const r of dev.cfg.natRules) {
    const acl = dev.cfg.acls.find(a => a.name === r.acl); if (!acl || aclEval(acl, p) !== 'permit') continue;
    let g = '';
    if (r.ifn) g = out.name === r.ifn || true ? (ifsOfName(dev, r.ifn) ?? out.ip) : out.ip;
    else if (r.pool) {
      const pool = dev.cfg.natPools.find(x => x.name === r.pool); if (!pool) continue;
      for (let a = parseIp(pool.start)!; a <= parseIp(pool.end)!; a++) { const ip = fmtIp(a); if (r.overload || !dev.rt.nat.some(n => n.inGlobal === ip)) { g = ip; break; } }
    }
    if (!g) continue;
    const gp = r.overload || p.proto === 'icmp' ? 1024 + dev.rt.nat.length + 1 : lp;
    dev.rt.nat.push({ proto: p.proto, inLocal: p.src, inGlobal: g, outLocal: p.dst, outGlobal: p.dst, lp, gp });
    p.src = g; if (p.proto === 'icmp') p.icmp!.id = gp; else p.l4!.sport = gp; return;
  }
}
function ifsOfName(dev: Dev, name: string): string | undefined { return dev.cfg.ifs.find(i => i.name === name)?.ip; }

// ---------- local delivery / applications ----------
const wkey = (d: Dev, ...k: (string | number)[]) => d.id + '|' + k.join('|');
function setWaiter(tr: Trace, key: string, t: number, pkt: Pkt): void { if (tr.waiters.has(key) && !tr.waiters.get(key)) tr.waiters.set(key, { t, pkt }); }
function local(tr: Trace, dev: Dev, ifc: L3If, p: Pkt, t: number): void {
  if (p.proto === 'icmp') {
    const ic = p.icmp!;
    if (ic.type === 8) {
      const rep: Pkt = { src: p.dst, dst: p.src, ttl: defTtl(dev), proto: 'icmp', id: tr.newPdu() + 1000, size: p.size, icmp: { type: 0, code: 0, id: ic.id, seq: ic.seq } };
      originate(tr, dev, rep, t + 0.0002, { hold: true, quiet: false }); return;
    }
    setWaiter(tr, wkey(dev, 'icmp', ic.id, ic.seq), t, p); return;
  }
  const l4 = p.l4!; const d = l4.data ?? {};
  if (p.proto === 'udp') {
    if (l4.dport === 67) return dhcpServer(tr, dev, ifc, p, t);
    if (l4.dport === 68) return setWaiter(tr, wkey(dev, 'dhcp', d.xid, d.op), t, p);
    if (l4.dport === 53) return dnsServer(tr, dev, ifc, p, t);
    if (l4.sport === 53) return setWaiter(tr, wkey(dev, 'dns', d.txid), t, p);
    return setWaiter(tr, wkey(dev, 'udp', l4.dport), t, p);
  }
  if (l4.dport === 80 && dev.svc) return httpServer(tr, dev, p, t);
  setWaiter(tr, wkey(dev, 'tcp', l4.dport, d.k ?? ''), t, p);
}
function reply(tr: Trace, dev: Dev, req: Pkt, l4: Pkt['l4'], t: number): void {
  const pkt: Pkt = { src: req.dst, dst: req.src, ttl: defTtl(dev), proto: req.proto, id: tr.newPdu() + 1000, size: 64, l4 };
  originate(tr, dev, pkt, t + 0.0003, { hold: true, quiet: false });
}
function httpServer(tr: Trace, dev: Dev, p: Pkt, t: number): void {
  const d = p.l4!.data ?? {}; const on = dev.svc!.http.on; const base = { sport: 80, dport: p.l4!.sport };
  if (d.k === 'syn') return reply(tr, dev, p, { ...base, flags: on ? 'SYN,ACK' : 'RST', data: { k: on ? 'synack' : 'rst', app: 'TCP' } }, t);
  if (!on) return;
  if (d.k === 'get') return reply(tr, dev, p, { ...base, flags: 'PSH,ACK', data: { k: 'resp', app: 'HTTP', status: 200, body: dev.svc!.http.html } }, t);
  if (d.k === 'fin') return reply(tr, dev, p, { ...base, flags: 'FIN,ACK', data: { k: 'finack', app: 'TCP' } }, t);
}
function dnsServer(tr: Trace, dev: Dev, _ifc: L3If, p: Pkt, t: number): void {
  if (!dev.svc?.dns.on) return; const q = String(p.l4!.data?.name ?? '').toLowerCase();
  const rec = dev.svc.dns.records.find(r => r.name.toLowerCase() === q);
  reply(tr, dev, p, { sport: 53, dport: p.l4!.sport, data: { k: 'answer', txid: p.l4!.data?.txid, name: q, ip: rec?.ip ?? null, app: 'DNS' } }, t);
}
function nextLease(dev: Dev, pool: { start: number; end: number; net?: string; mask?: string }, chaddr: string, own: string[], excl: [string, string][]): string | null {
  const b = dev.rt.binds.find(x => x.mac === chaddr); if (b) return b.ip;
  for (let a = pool.start; a <= pool.end; a++) {
    const ip = fmtIp(a);
    if (own.includes(ip) || dev.rt.binds.some(x => x.ip === ip)) continue;
    if (excl.some(([lo, hi]) => ipCmp(ip, lo) >= 0 && ipCmp(ip, hi) <= 0)) continue;
    return ip;
  }
  return null;
}
function dhcpServer(tr: Trace, dev: Dev, ifc: L3If, p: Pkt, t: number): void {
  const d = p.l4!.data ?? {}; const net = tr.net;
  if ((d.op === 'offer' || d.op === 'ack') && d.giaddr) {      // relay agent: send back to the client's segment
    const cif = ifsOf(net, dev).find(i => i.ip === d.giaddr && i.up); if (!cif) return;
    txBroadcast(tr, dev, cif, { src: cif.ip, dst: '255.255.255.255', ttl: 64, proto: 'udp', id: tr.ipId++, size: 300, l4: { sport: 67, dport: 68, data: { ...d } } }, d.chaddr, t + 0.0002); return;
  }
  if (d.op !== 'discover' && d.op !== 'request') return;
  if (!d.giaddr && ifc.cfg.helper.length && isRouting(dev)) {       // relay
    for (const h of ifc.cfg.helper) originate(tr, dev, { src: ifc.ip, dst: h, ttl: 64, proto: 'udp', id: tr.ipId++, size: 300, l4: { sport: 67, dport: 67, data: { ...d, giaddr: ifc.ip } } }, t + 0.0002, { hold: true, quiet: false });
    return;
  }
  const key = d.giaddr ?? ifc.ip; const own = ifsOf(net, dev).map(i => i.ip);
  let lease: string | null = null; let mask = ''; let gw = ''; let dns = ''; let poolName = '';
  if (dev.svc?.dhcp.on) {
    const pool = dev.svc.dhcp.pools.find(x => x.start !== '0.0.0.0' && sameNet(x.start, key, x.mask));
    if (pool) { const s = parseIp(pool.start)!; lease = nextLease(dev, { start: s, end: s + pool.max - 1 }, d.chaddr, own, []); mask = pool.mask; gw = pool.gw; dns = pool.dns; poolName = pool.name; }
  } else if (isRouting(dev)) {
    const pool = dev.cfg.dhcpPools.find(x => sameNet(x.net, key, x.mask));
    if (pool) { const len = maskToLen(pool.mask)!; const n = netInt(parseIp(pool.net)!, len); const bc = n + 2 ** (32 - len) - 1; lease = nextLease(dev, { start: n + 1, end: bc - 1 }, d.chaddr, own, dev.cfg.dhcpExcluded); mask = pool.mask; gw = pool.gw ?? ''; dns = pool.dns ?? ''; poolName = pool.name; }
  }
  if (!lease) return;
  if (d.op === 'request' && !dev.rt.binds.some(b => b.mac === d.chaddr)) dev.rt.binds.push({ ip: lease, mac: d.chaddr, pool: poolName });
  const data = { ...d, op: d.op === 'discover' ? 'offer' : 'ack', yiaddr: lease, mask, gw, dns, server: ifc.ip };
  if (d.giaddr) originate(tr, dev, { src: ifc.ip, dst: d.giaddr, ttl: 64, proto: 'udp', id: tr.ipId++, size: 300, l4: { sport: 67, dport: 67, data } }, t + 0.0003, { hold: true, quiet: false });
  else txBroadcast(tr, dev, ifc, { src: ifc.ip, dst: '255.255.255.255', ttl: 64, proto: 'udp', id: tr.ipId++, size: 300, l4: { sport: 67, dport: 68, data } }, d.chaddr, t + 0.0003);
}

// ---------- high-level operations ----------
export function finalize(tr: Trace): Trace {
  tr.events.sort((a, b) => a.t - b.t || a.seq - b.seq); tr.events.forEach((e, i) => { e.seq = i; }); return tr;
}
function wait(tr: Trace, key: string): void { tr.waiters.set(key, null); }
export interface PingResult { seq: number; status: 'reply' | 'timeout' | 'unreach' | 'ttl' | 'noroute'; from?: string; ms?: number; ttl?: number; bytes: number }
export function echoOnce(tr: Trace, dev: Dev, dst: string, seq: number, t: number, o: { size?: number; ttl?: number; srcIp?: string; hold?: boolean } = {}): PingResult {
  const size = o.size ?? 32; const id = tr.ipId++ ; const pkt: Pkt = { src: '', dst, ttl: o.ttl ?? defTtl(dev), proto: 'icmp', id: tr.newPdu() + 5000, size: size + 28, icmp: { type: 8, code: 0, id, seq } };
  const key = wkey(dev, 'icmp', id, seq); wait(tr, key);
  const r = originate(tr, dev, pkt, t, { hold: o.hold ?? false, quiet: false, srcIp: o.srcIp });
  const w = tr.waiters.get(key); tr.waiters.delete(key);
  if (r === 'noroute' || r === 'down') return { seq, status: 'noroute', from: nicOf(tr.net, dev)?.ip, bytes: size };
  if (!w) return { seq, status: 'timeout', bytes: size };
  const ic = w.pkt.icmp!; const ms = Math.max(0, Math.round((w.t - t) * 1000));
  if (ic.type === 0) return { seq, status: 'reply', from: w.pkt.src, ms, ttl: w.pkt.ttl, bytes: size };
  return { seq, status: ic.type === 11 ? 'ttl' : 'unreach', from: w.pkt.src, ms, bytes: size };
}
export function ping(net: Net, dev: Dev, dst: string, o: { count?: number; size?: number; ttl?: number; srcIp?: string } = {}): { results: PingResult[]; trace: Trace } {
  const tr = new Trace(net); const out: PingResult[] = [];
  for (let i = 0; i < (o.count ?? 4); i++) out.push(echoOnce(tr, dev, dst, i + 1, i, o));
  return { results: out, trace: finalize(tr) };
}
export interface TraceHop { hop: number; addr?: string; ms: number[]; done: boolean }
export function traceroute(net: Net, dev: Dev, dst: string, max = 30): { hops: TraceHop[]; trace: Trace } {
  const tr = new Trace(net); const hops: TraceHop[] = []; let t = 0;
  for (let ttl = 1; ttl <= max; ttl++) {
    const ms: number[] = []; let addr: string | undefined; let done = false;
    for (let k = 0; k < 3; k++) {
      const r = echoOnce(tr, dev, dst, ttl * 10 + k, t, { ttl, hold: true }); t += 0.2;
      if (r.status === 'ttl' || r.status === 'reply' || r.status === 'unreach') { ms.push(r.ms ?? 0); addr = r.from; if (r.status === 'reply') done = true; if (r.status === 'unreach') done = true; }
    }
    hops.push({ hop: ttl, addr, ms, done }); if (done || (ttl > 3 && !addr && hops.slice(-3).every(h => !h.addr))) break;
  }
  return { hops, trace: finalize(tr) };
}
export interface DhcpResult { ok: boolean; ip?: string; mask?: string; gw?: string; dns?: string; error?: string }
export function dhcpAcquire(net: Net, dev: Dev, tr = new Trace(net), t0 = 0): { result: DhcpResult; trace: Trace } {
  const nic = nicOf(net, dev);
  if (!nic || !nic.up) return { result: { ok: false, error: 'Interface is down' }, trace: finalize(tr) };
  const xid = tr.ipId++; let t = t0;
  const send = (op: string, extra: Record<string, any>): void => {
    const pkt: Pkt = { src: '0.0.0.0', dst: '255.255.255.255', ttl: 64, proto: 'udp', id: tr.ipId++, size: 300, l4: { sport: 68, dport: 67, data: { op, xid, chaddr: nic.mac, ...extra } } };
    txBroadcast(tr, dev, nic, pkt, BCAST_MAC, t);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    wait(tr, wkey(dev, 'dhcp', xid, 'offer')); send('discover', {});
    const o = tr.waiters.get(wkey(dev, 'dhcp', xid, 'offer')); tr.waiters.delete(wkey(dev, 'dhcp', xid, 'offer'));
    if (!o) { t += 1; continue; }
    const od = o.pkt.l4!.data!; t = o.t + 0.001;
    wait(tr, wkey(dev, 'dhcp', xid, 'ack')); send('request', { yiaddr: od.yiaddr, server: od.server });
    const a = tr.waiters.get(wkey(dev, 'dhcp', xid, 'ack')); tr.waiters.delete(wkey(dev, 'dhcp', xid, 'ack'));
    if (!a) { t += 1; continue; }
    const ad = a.pkt.l4!.data!; const c = net.cfgIf(dev, nic.name)!;
    c.ip = ad.yiaddr; c.mask = ad.mask; dev.cfg.hostGw = ad.gw || undefined; dev.cfg.hostDns = ad.dns && ad.dns !== '0.0.0.0' ? ad.dns : undefined; dev.cfg.hostDhcp = true; net.touch();
    return { result: { ok: true, ip: ad.yiaddr, mask: ad.mask, gw: ad.gw, dns: ad.dns }, trace: finalize(tr) };
  }
  return { result: { ok: false, error: 'DHCP request failed: no server responded' }, trace: finalize(tr) };
}
export function dnsResolve(tr: Trace, dev: Dev, name: string, t: number): { ip: string | null; t: number; error?: string } {
  if (isIp(name)) return { ip: name, t };
  const srv = dev.cfg.hostDns; if (!srv || !isIp(srv)) return { ip: null, t, error: 'No DNS server configured' };
  for (let a = 0; a < 3; a++) {
    const txid = tr.ipId++; const key = wkey(dev, 'dns', txid); wait(tr, key);
    originate(tr, dev, { src: '', dst: srv, ttl: 128, proto: 'udp', id: tr.newPdu() + 5000, size: 60, l4: { sport: tr.sport++, dport: 53, data: { k: 'query', txid, name, app: 'DNS' } } }, t, { hold: true, quiet: false });
    const w = tr.waiters.get(key); tr.waiters.delete(key);
    if (w) { const ip = w.pkt.l4!.data!.ip as string | null; return { ip, t: w.t, error: ip ? undefined : 'Host not found' }; }
    t += 1;
  }
  return { ip: null, t, error: 'DNS request timed out' };
}
export interface HttpResult { ok: boolean; status?: number; body?: string; error?: string; ip?: string }
export function httpGet(net: Net, dev: Dev, url: string): { result: HttpResult; trace: Trace } {
  const tr = new Trace(net); const m = /^(?:https?:\/\/)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(url.trim());
  if (!m) return { result: { ok: false, error: 'Invalid URL' }, trace: tr };
  const host = m[1], path = m[2] ?? '/'; let t = 0;
  const dr = dnsResolve(tr, dev, host, t); t = dr.t + 0.001;
  if (!dr.ip) return { result: { ok: false, error: dr.error ?? 'Host not found' }, trace: finalize(tr) };
  const sport = tr.sport++; const flow = (k: string, flags: string, wantK: string): { t: number; pkt: Pkt } | null => {
    for (let a = 0; a < 3; a++) {
      const key = wkey(dev, 'tcp', sport, wantK); if (wantK) wait(tr, key);
      originate(tr, dev, { src: '', dst: dr.ip!, ttl: 128, proto: 'tcp', id: tr.newPdu() + 5000, size: 60, l4: { sport, dport: 80, flags, data: { k, app: k === 'get' ? 'HTTP' : 'TCP', path } } }, t, { hold: true, quiet: false });
      if (!wantK) return { t, pkt: {} as Pkt };
      const w = tr.waiters.get(key); tr.waiters.delete(key); if (w) { t = w.t + 0.001; return w; } t += 1;
    }
    return null;
  };
  const syn = flow('syn', 'SYN', 'synack'); if (!syn) return { result: { ok: false, error: 'Request timed out', ip: dr.ip }, trace: finalize(tr) };
  if (syn.pkt.l4!.data!.k === 'rst') return { result: { ok: false, error: 'Connection refused', ip: dr.ip }, trace: finalize(tr) };
  flow('ack', 'ACK', '');
  const get = flow('get', 'PSH,ACK', 'resp'); if (!get) return { result: { ok: false, error: 'Request timed out', ip: dr.ip }, trace: finalize(tr) };
  flow('fin', 'FIN,ACK', 'finack');
  return { result: { ok: true, status: 200, body: String(get.pkt.l4!.data!.body ?? ''), ip: dr.ip }, trace: finalize(tr) };
}
export function udpSend(net: Net, dev: Dev, dst: string, port: number): { ok: boolean; trace: Trace } {
  const tr = new Trace(net); const r = originate(tr, dev, { src: '', dst, ttl: defTtl(dev), proto: 'udp', id: tr.newPdu() + 5000, size: 60, l4: { sport: tr.sport++, dport: port, data: { k: 'datagram', app: 'UDP' } } }, 0, { hold: true, quiet: false });
  return { ok: r === 'sent' || r === 'arp', trace: finalize(tr) };
}
void inNet;

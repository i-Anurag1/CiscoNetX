import type { Cable, CableType, Dev, DevCfg, End, IfCfg, L3If, Note, PortPhy, Svc } from './types.ts';
import { makePorts, modelOf, isEth, isSwitch, isHost, shortName } from './catalog.ts';
import { macFrom } from '../lib/ip.ts';

export const STP_DELAY = 10;

export function defaultIf(name: string, type: IfCfg['type'], adminUp: boolean): IfCfg {
  return { name, type, adminUp, helper: [], swMode: 'access', accessVlan: 1, nativeVlan: 1, allowed: '', routed: false, portfast: false };
}
export function allowsVlan(allowed: string, vid: number): boolean {
  if (!allowed) return true;
  return allowed.split(',').some(part => {
    const [a, b] = part.split('-').map(Number);
    return b === undefined ? a === vid : vid >= a && vid <= b;
  });
}
const emptyRt = () => ({ arp: {}, macTable: [], nat: [], binds: [], upSince: {} });
export function newCfg(model: string, hostname: string): DevCfg {
  const m = modelOf(model);
  return {
    hostname: m.kind === 'router' ? 'Router' : (m.kind === 'switch' || m.kind === 'l3switch') ? 'Switch' : hostname,
    domainLookup: true, ipRouting: m.kind === 'router', ifs: [], statics: [], ospf: [], eigrp: [], acls: [], natPools: [], natRules: [],
    natStatics: [], dhcpPools: [], dhcpExcluded: [], vlans: isSwitch(m.kind) ? { '1': { name: 'default' } } : {},
    conLogin: false, vtyLogin: false, stpPrio: 32768, cdp: true, hostDhcp: false,
  };
}
export const newSvc = (): Svc => ({
  http: { on: true, html: '<html><body><h1>Welcome to CiscoNetX</h1><p>Opening doors to new opportunities.</p><a href="/helloworld.html">Quick Links</a></body></html>' },
  dns: { on: false, records: [] }, dhcp: { on: false, pools: [{ name: 'serverPool', gw: '0.0.0.0', dns: '0.0.0.0', start: '0.0.0.0', mask: '255.255.255.0', max: 512 }] },
});
const stripCfg = (c: DevCfg): DevCfg => JSON.parse(JSON.stringify(c));

export class Net {
  devices: Dev[] = []; cables: Cable[] = []; notes: Note[] = [];
  clock = 0; rev = 0;
  counters: Record<string, number> = {}; macN = 1; cabN = 1; devN = 1; noteN = 1;
  private subs = new Set<() => void>();
  private phyKey = ''; private phyMap: Map<string, PortPhy> | null = null;
  routeCache: { key: string; data: unknown } | null = null;

  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  touch(): void { this.rev++; this.phyKey = ''; this.routeCache = null; this.subs.forEach(f => f()); }
  advance(sec: number): void { this.clock += sec; this.phyKey = ''; this.routeCache = null; this.subs.forEach(f => f()); }
  dev(id: string): Dev | undefined { return this.devices.find(d => d.id === id); }
  devByName(n: string): Dev | undefined { return this.devices.find(d => d.name.toLowerCase() === n.toLowerCase()); }
  cableAt(devId: string, port: string): Cable | undefined {
    return this.cables.find(c => (c.a.dev === devId && c.a.port === port) || (c.b.dev === devId && c.b.port === port));
  }
  peerOf(devId: string, port: string): { dev: Dev; port: string; cable: Cable } | null {
    const c = this.cableAt(devId, port); if (!c) return null;
    const e = c.a.dev === devId && c.a.port === port ? c.b : c.a;
    const d = this.dev(e.dev); return d ? { dev: d, port: e.port, cable: c } : null;
  }
  cfgIf(d: Dev, name: string): IfCfg | undefined { return d.cfg.ifs.find(i => i.name === name); }
  ensureIf(d: Dev, name: string, type: IfCfg['type']): IfCfg {
    let i = this.cfgIf(d, name);
    if (!i) { i = defaultIf(name, type, type === 'lo' || type === 'svi' ? type === 'lo' : false); d.cfg.ifs.push(i); }
    return i;
  }

  addDevice(model: string, x: number, y: number): Dev {
    const m = modelOf(model); const n = this.counters[m.base] ?? 0; this.counters[m.base] = n + 1;
    const name = `${m.base}${n}`; const modules = Array.from({ length: m.slots }, () => null as string | null);
    const ports = makePorts(model, modules).map(p => ({ ...p, mac: macFrom(this.macN++) }));
    const cfg = newCfg(model, name);
    const adminDefault = m.kind !== 'router';
    for (const p of ports) if (p.kind !== 'Console' && p.kind !== 'RS232' && m.kind !== 'hub') cfg.ifs.push(defaultIf(p.name, 'phys', adminDefault));
    if (m.kind === 'switch' || m.kind === 'l3switch') cfg.ifs.push(defaultIf('Vlan1', 'svi', false));
    const d: Dev = { id: 'd' + this.devN++, name, kind: m.kind, model, x, y, power: true, ports, modules, cfg, startup: null, rt: emptyRt(), svc: m.kind === 'server' ? newSvc() : undefined };
    this.devices.push(d); this.touch(); return d;
  }
  removeDevice(id: string): void {
    this.cables = this.cables.filter(c => c.a.dev !== id && c.b.dev !== id);
    this.devices = this.devices.filter(d => d.id !== id); this.touch();
  }
  disconnect(cableId: string): void { this.cables = this.cables.filter(c => c.id !== cableId); this.touch(); }
  rename(d: Dev, name: string): void { d.name = name.trim() || d.name; this.touch(); }
  setModule(d: Dev, slot: number, mod: string | null): string | null {
    if (d.kind !== 'router') return 'This device has no module slots.';
    if (d.power) return 'Power off the device before changing modules.';
    d.modules[slot] = mod;
    const keep = new Map(d.ports.map(p => [p.name, p.mac] as const));
    const next = makePorts(d.model, d.modules).map(p => ({ ...p, mac: keep.get(p.name) ?? macFrom(this.macN++) }));
    const names = new Set(next.map(p => p.name));
    this.cables = this.cables.filter(c => !((c.a.dev === d.id && !names.has(c.a.port)) || (c.b.dev === d.id && !names.has(c.b.port))));
    d.cfg.ifs = d.cfg.ifs.filter(i => i.type !== 'phys' || names.has(i.name));
    for (const p of next) if (p.kind !== 'Console' && !this.cfgIf(d, p.name)) d.cfg.ifs.push(defaultIf(p.name, 'phys', false));
    d.ports = next; this.touch(); return null;
  }
  setPower(d: Dev, on: boolean): void {
    if (d.power === on) return; d.power = on;
    if (!on) { d.rt.arp = {}; d.rt.macTable = []; d.rt.nat = []; d.rt.upSince = {}; }
    this.touch();
  }
  saveStartup(d: Dev): void { d.startup = stripCfg(d.cfg); }
  powerCycle(d: Dev): void {
    d.rt = { ...emptyRt(), binds: [] };
    if (d.startup) d.cfg = stripCfg(d.startup);
    else {
      const fresh = newCfg(d.model, d.name); const adminDefault = d.kind !== 'router';
      for (const p of d.ports) if (p.kind !== 'Console' && p.kind !== 'RS232' && d.kind !== 'hub') fresh.ifs.push(defaultIf(p.name, 'phys', adminDefault));
      if (isSwitch(d.kind)) fresh.ifs.push(defaultIf('Vlan1', 'svi', false));
      if (isHost(d.kind)) { fresh.hostname = d.cfg.hostname; }
      d.cfg = fresh;
    }
    this.touch();
  }

  autoCable(a: Dev, pa: string, b: Dev, pb: string): { type: CableType; dceA?: boolean } | null {
    const ka = a.ports.find(p => p.name === pa)?.kind, kb = b.ports.find(p => p.name === pb)?.kind;
    if (!ka || !kb) return null;
    if ((ka === 'RS232' && kb === 'Console') || (ka === 'Console' && kb === 'RS232')) return { type: 'console' };
    if (ka === 'Serial' && kb === 'Serial') return { type: 'serial', dceA: true };
    if (isEth(ka) && isEth(kb)) {
      const mdi = (d: Dev) => d.kind === 'router' || isHost(d.kind);
      return { type: mdi(a) === mdi(b) ? 'cross' : 'straight' };
    }
    return null;
  }
  connect(sel: string, a: End, b: End): { ok: boolean; cable?: Cable; error?: string } {
    const da = this.dev(a.dev), db = this.dev(b.dev);
    if (!da || !db) return { ok: false, error: 'Device not found.' };
    if (da.id === db.id) return { ok: false, error: 'Cannot connect a device to itself.' };
    if (this.cableAt(a.dev, a.port) || this.cableAt(b.dev, b.port)) return { ok: false, error: 'That port is already connected.' };
    const ka = da.ports.find(p => p.name === a.port)?.kind, kb = db.ports.find(p => p.name === b.port)?.kind;
    if (!ka || !kb) return { ok: false, error: 'Port not found.' };
    let type: CableType; let dceA: boolean | undefined;
    if (sel === 'auto') {
      const r = this.autoCable(da, a.port, db, b.port);
      if (!r) return { ok: false, error: 'No cable type can connect these two ports.' };
      type = r.type; dceA = r.dceA;
    } else if (sel === 'console') {
      if (!((ka === 'RS232' && kb === 'Console') || (ka === 'Console' && kb === 'RS232'))) return { ok: false, error: 'A console cable connects a Console port to an RS 232 port.' };
      type = 'console';
    } else if (sel === 'serialdce' || sel === 'serialdte') {
      if (ka !== 'Serial' || kb !== 'Serial') return { ok: false, error: 'Serial cables connect two Serial ports.' };
      type = 'serial'; dceA = sel === 'serialdce';
    } else {
      if (!isEth(ka) || !isEth(kb)) return { ok: false, error: 'Copper cables connect two Ethernet ports.' };
      type = sel === 'cross' ? 'cross' : 'straight';
    }
    const cable: Cable = { id: 'c' + this.cabN++, type, a, b, ...(dceA === undefined ? {} : { dceA }) };
    this.cables.push(cable); this.touch(); return { ok: true, cable };
  }
  cableLabel(t: CableType): string {
    return t === 'straight' ? 'Copper Straight-Through' : t === 'cross' ? 'Copper Cross-Over' : t === 'console' ? 'Console' : 'Serial';
  }

  // ---- physical layer ----
  private cableValid(c: Cable): boolean {
    const a = this.dev(c.a.dev), b = this.dev(c.b.dev); if (!a || !b) return false;
    if (c.type === 'serial' || c.type === 'console') return true;
    if (isSwitch(a.kind) || isSwitch(b.kind)) return true;
    const mdix = (d: Dev) => d.kind === 'hub';
    return c.type === 'straight' ? mdix(a) !== mdix(b) : mdix(a) === mdix(b);
  }
  phy(): Map<string, PortPhy> {
    const key = `${this.rev}:${Math.floor(this.clock)}`;
    if (this.phyMap && this.phyKey === key) return this.phyMap;
    const map = new Map<string, PortPhy>(); const k = (d: string, p: string) => d + '|' + p;
    for (const d of this.devices) for (const p of d.ports) map.set(k(d.id, p.name), { conn: false, up: false, proto: false, stp: 'na', color: 'none' });
    const upCables = new Set<string>();
    for (const c of this.cables) {
      const a = this.dev(c.a.dev)!, b = this.dev(c.b.dev)!;
      const pa = map.get(k(a.id, c.a.port)), pb = map.get(k(b.id, c.b.port)); if (!pa || !pb) continue;
      pa.conn = pb.conn = true;
      if (c.type === 'console') { pa.up = pb.up = pa.proto = pb.proto = true; continue; }
      const ia = this.cfgIf(a, c.a.port), ib = this.cfgIf(b, c.b.port);
      const up = a.power && b.power && this.cableValid(c) && (ia?.adminUp ?? true) && (ib?.adminUp ?? true);
      let proto = up;
      if (up && c.type === 'serial') { const dce = c.dceA ? ia : ib; proto = !!dce?.clockRate; }
      pa.up = pb.up = up; pa.proto = pb.proto = proto;
      if (up) upCables.add(c.id);
    }
    const blocked = this.computeStp(upCables);
    for (const d of this.devices) {
      for (const p of d.ports) {
        const ph = map.get(k(d.id, p.name))!; const kk = d.id + '|' + p.name;
        if (!ph.conn || p.kind === 'Console' || p.kind === 'RS232') continue;
        if (!(ph.up && ph.proto)) { ph.color = 'red'; delete d.rt.upSince[p.name]; continue; }
        ph.color = 'green';
        if (isSwitch(d.kind)) {
          if (d.rt.upSince[p.name] === undefined) d.rt.upSince[p.name] = this.clock;
          const ic = this.cfgIf(d, p.name);
          if (blocked.has(kk)) ph.stp = 'blk';
          else if (!ic?.portfast && this.clock - d.rt.upSince[p.name] < STP_DELAY) ph.stp = 'lrn';
          else ph.stp = 'fwd';
          if (ph.stp !== 'fwd') ph.color = 'amber';
        }
      }
    }
    this.phyMap = map; this.phyKey = key; return map;
  }
  portPhy(d: Dev, port: string): PortPhy { return this.phy().get(d.id + '|' + port) ?? { conn: false, up: false, proto: false, stp: 'na', color: 'none' }; }
  private computeStp(upCables: Set<string>): Set<string> {
    const blocked = new Set<string>();
    const sw = this.devices.filter(d => isSwitch(d.kind) && d.power);
    const bid = (d: Dev): [number, string] => [d.cfg.stpPrio, d.ports[0]?.mac ?? ''];
    const less = (a: [number, string], b: [number, string]) => a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
    const edges = this.cables.filter(c => upCables.has(c.id) && c.type !== 'console' && sw.some(s => s.id === c.a.dev) && sw.some(s => s.id === c.b.dev));
    if (!edges.length) return blocked;
    const adj = new Map<string, typeof edges>(); for (const e of edges) { for (const id of [e.a.dev, e.b.dev]) { if (!adj.has(id)) adj.set(id, []); adj.get(id)!.push(e); } }
    const visited = new Set<string>();
    for (const start of sw) {
      if (visited.has(start.id) || !adj.has(start.id)) continue;
      const comp: Dev[] = []; const stack = [start.id]; visited.add(start.id);
      while (stack.length) { const id = stack.pop()!; comp.push(this.dev(id)!); for (const e of adj.get(id) ?? []) { const o = e.a.dev === id ? e.b.dev : e.a.dev; if (!visited.has(o)) { visited.add(o); stack.push(o); } } }
      let root = comp[0]; for (const d of comp) if (less(bid(d), bid(root))) root = d;
      const cost = (e: typeof edges[number]) => { const ka = this.dev(e.a.dev)!.ports.find(p => p.name === e.a.port)?.kind, kb = this.dev(e.b.dev)!.ports.find(p => p.name === e.b.port)?.kind; return ka === 'GigabitEthernet' && kb === 'GigabitEthernet' ? 4 : 19; };
      const dist = new Map<string, number>([[root.id, 0]]); const rootPort = new Map<string, string>(); const done = new Set<string>();
      for (;;) {
        let cur: string | null = null; let best = Infinity;
        for (const [id, dd] of dist) if (!done.has(id) && dd < best) { best = dd; cur = id; }
        if (cur === null) break; done.add(cur);
        for (const e of adj.get(cur) ?? []) {
          const o = e.a.dev === cur ? e.b : e.a; const mine = e.a.dev === cur ? e.a : e.b; const nd = best + cost(e);
          const od = dist.get(o.dev);
          if (od === undefined || nd < od) { dist.set(o.dev, nd); rootPort.set(o.dev, o.port); }
          void mine;
        }
      }
      for (const e of comp.length > 1 ? edges.filter(x => dist.has(x.a.dev) && dist.has(x.b.dev)) : []) {
        const da = dist.get(e.a.dev)!, db = dist.get(e.b.dev)!;
        const A = this.dev(e.a.dev)!, B = this.dev(e.b.dev)!;
        const aDesignated = da < db || (da === db && less(bid(A), bid(B)));
        const loser = aDesignated ? e.b : e.a;
        const isRootPort = rootPort.get(loser.dev) === loser.port;
        if (!isRootPort) blocked.add(loser.dev + '|' + loser.port);
      }
    }
    return blocked;
  }
  settle(): void { this.clock += 60; for (const d of this.devices) for (const p of d.ports) d.rt.upSince[p.name] = -1e9; this.touch(); }

  // ---- layer 3 view ----
  vlanActive(d: Dev, vid: number): boolean {
    if (!d.cfg.vlans[String(vid)]) return false;
    return d.ports.some(p => {
      const ic = this.cfgIf(d, p.name); if (!ic || ic.type !== 'phys') return false;
      const ph = this.portPhy(d, p.name); if (!(ph.up && ph.proto)) return false;
      return ic.swMode === 'access' ? ic.accessVlan === vid : allowsVlan(ic.allowed, vid);
    });
  }
  l3ifs(d: Dev): L3If[] {
    const out: L3If[] = [];
    for (const c of d.cfg.ifs) {
      if (!c.ip || !c.mask) continue;
      if (c.type === 'phys') {
        if (isSwitch(d.kind) && !c.routed) continue;
        const ph = this.portPhy(d, c.name); const p = d.ports.find(x => x.name === c.name);
        out.push({ name: c.name, ip: c.ip, mask: c.mask, mac: p?.mac ?? '', up: d.power && c.adminUp && ph.up && ph.proto, port: c.name, tag: null, cfg: c });
      } else if (c.type === 'sub') {
        const par = c.parent ? this.cfgIf(d, c.parent) : undefined; const pp = d.ports.find(x => x.name === c.parent);
        const ph = pp ? this.portPhy(d, pp.name) : undefined;
        out.push({ name: c.name, ip: c.ip, mask: c.mask, mac: pp?.mac ?? '', up: d.power && c.adminUp && !!par?.adminUp && !!ph?.up && !!ph.proto, port: c.parent, tag: c.vlanNative ? null : (c.vlan ?? null), cfg: c });
      } else if (c.type === 'svi') {
        const vid = Number(c.name.replace(/\D/g, ''));
        out.push({ name: c.name, ip: c.ip, mask: c.mask, mac: d.ports[0]?.mac ?? '', up: d.power && c.adminUp && this.vlanActive(d, vid), tag: vid, vlan: vid, cfg: c });
      } else out.push({ name: c.name, ip: c.ip, mask: c.mask, mac: '', up: d.power && c.adminUp, cfg: c });
    }
    return out;
  }
  /** Which L3-capable endpoints share a broadcast domain with (dev,port) when frames carry `tag`. */
  l2reach(dev: Dev, port: string, tag: number | null): { dev: Dev; port: string; tag: number | null }[] {
    const phy = this.phy(); const out: { dev: Dev; port: string; tag: number | null }[] = []; const seen = new Set<string>();
    const queue: { dev: Dev; port: string; tag: number | null }[] = [];
    const hop = (d: Dev, p: string, t: number | null) => {
      const pe = this.peerOf(d.id, p); if (!pe || pe.cable.type === 'console') return;
      const ph = phy.get(d.id + '|' + p); if (!ph || !ph.up || !ph.proto) return;
      queue.push({ dev: pe.dev, port: pe.port, tag: t });
    };
    hop(dev, port, tag);
    while (queue.length) {
      const q = queue.shift()!; const key = `${q.dev.id}|${q.port}|${q.tag}`; if (seen.has(key)) continue; seen.add(key);
      if (q.dev.kind === 'hub') { for (const p of q.dev.ports) if (p.name !== q.port) hop(q.dev, p.name, q.tag); continue; }
      if (isSwitch(q.dev.kind) && !(this.cfgIf(q.dev, q.port)?.routed)) {
        const ic = this.cfgIf(q.dev, q.port); const ph = phy.get(q.dev.id + '|' + q.port);
        if (!ic || !ph || ph.stp !== 'fwd') continue;
        let vlan: number;
        if (ic.swMode === 'access') { if (q.tag !== null) continue; vlan = ic.accessVlan; }
        else { vlan = q.tag ?? ic.nativeVlan; if (!allowsVlan(ic.allowed, vlan)) continue; }
        out.push({ dev: q.dev, port: '', tag: vlan });
        for (const p of q.dev.ports) {
          if (p.name === q.port) continue; const oc = this.cfgIf(q.dev, p.name); const op = phy.get(q.dev.id + '|' + p.name);
          if (!oc || !op || op.stp !== 'fwd' || oc.routed) continue;
          if (oc.swMode === 'access' && oc.accessVlan === vlan) hop(q.dev, p.name, null);
          else if (oc.swMode === 'trunk' && allowsVlan(oc.allowed, vlan)) hop(q.dev, p.name, vlan === oc.nativeVlan ? null : vlan);
        }
        continue;
      }
      out.push(q);
    }
    return out;
  }
  settleLinks(): void { this.settle(); }

  // ---- persistence ----
  toJSON(): unknown {
    return { v: 5, devices: this.devices, cables: this.cables, notes: this.notes, counters: this.counters, macN: this.macN, cabN: this.cabN, devN: this.devN, noteN: this.noteN, clock: this.clock };
  }
  load(o: any): void {
    if (!o || typeof o !== 'object' || !Array.isArray(o.devices) || !Array.isArray(o.cables)) throw new Error('Not a CiscoNetX topology file.');
    this.devices = o.devices; this.cables = o.cables; this.notes = Array.isArray(o.notes) ? o.notes : [];
    this.counters = o.counters ?? {}; this.macN = o.macN ?? 1000; this.cabN = o.cabN ?? 1000; this.devN = o.devN ?? 1000; this.noteN = o.noteN ?? 1; this.clock = o.clock ?? 0;
    for (const d of this.devices) {
      if (!d.rt) d.rt = emptyRt(); if (!d.rt.upSince) d.rt.upSince = {};
      for (const p of d.ports) p.short = p.short || shortName(p.name);
    }
    this.touch();
  }
  snapshot(): string { return JSON.stringify(this.toJSON()); }
  restore(s: string): void { this.load(JSON.parse(s)); }
  clear(): void {
    this.devices = []; this.cables = []; this.notes = []; this.counters = {}; this.macN = 1; this.cabN = 1; this.devN = 1; this.clock = 0; this.touch();
  }
}

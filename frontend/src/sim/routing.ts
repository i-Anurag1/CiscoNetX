import type { Dev, L3If } from '../model/types.ts';
import type { Net } from '../model/net.ts';
import { allowsVlan } from '../model/net.ts';
import { classfulLen, inNet, maskToLen, netInt, parseIp, wildMatch } from '../lib/ip.ts';

export interface Route { net: number; len: number; code: string; ad: number; metric: number; nh?: string; ifn: string }
export interface Nbr { rid: string; prio: number; state: string; addr: string; ifn: string; as?: number }
export interface RoutingInfo { routes: Map<string, Route[]>; ospf: Map<string, Nbr[]>; eigrp: Map<string, Nbr[]>; rip: Map<string, Nbr[]>; rids: Map<string, string> }
interface Adj { my: L3If; nbr: Dev; nbrIf: L3If }

export const isRouting = (d: Dev): boolean => d.kind === 'router' || (d.kind === 'l3switch' && d.cfg.ipRouting);
export const netKey = (r: { net: number; len: number }): string => `${r.net}/${r.len}`;
const bwOf = (i: L3If): number => i.cfg.bandwidth ?? (i.name.startsWith('Serial') ? 1544 : i.name.startsWith('Loopback') ? 8000000 : i.name.startsWith('Gigabit') ? 1000000 : 100000);
const dlyOf = (i: L3If): number => i.cfg.delay !== undefined ? i.cfg.delay * 10 : i.name.startsWith('Serial') ? 20000 : i.name.startsWith('Loopback') ? 5000 : i.name.startsWith('Gigabit') ? 10 : 100;

export function routingInfo(net: Net): RoutingInfo {
  const key = `${net.rev}:${Math.floor(net.clock)}`;
  if (net.routeCache && net.routeCache.key === key) return net.routeCache.data as RoutingInfo;
  const info = compute(net); net.routeCache = { key, data: info }; return info;
}

function compute(net: Net): RoutingInfo {
  const info: RoutingInfo = { routes: new Map(), ospf: new Map(), eigrp: new Map(), rip: new Map(), rids: new Map() };
  const rdevs = net.devices.filter(d => d.power && isRouting(d));
  const ifs = new Map<string, L3If[]>(); for (const d of rdevs) ifs.set(d.id, net.l3ifs(d).filter(i => i.up));
  // connected + local
  const table = new Map<string, Route[]>();
  for (const d of rdevs) {
    const rs: Route[] = [];
    for (const i of ifs.get(d.id)!) {
      const len = maskToLen(i.mask)!; const ip = parseIp(i.ip)!;
      rs.push({ net: netInt(ip, len), len, code: 'C', ad: 0, metric: 0, ifn: i.name });
      rs.push({ net: ip, len: 32, code: 'L', ad: 0, metric: 0, ifn: i.name });
    }
    for (const s of d.cfg.statics) {
      const len = maskToLen(s.mask); const n = parseIp(s.net); if (len === null || n === null) continue;
      let ifn = s.ifn; let nh = s.nh;
      if (nh) {
        const c = ifs.get(d.id)!.find(i => !i.ip.includes('x') && inNet(nh!, i.ip, maskToLen(i.mask)!) && i.ip !== nh);
        if (!c) continue; ifn = c.name;
      } else if (ifn) { const c = ifs.get(d.id)!.find(i => i.name === ifn); if (!c) continue; nh = undefined; }
      if (!ifn) continue;
      rs.push({ net: netInt(n, len), len, code: 'S', ad: s.ad, metric: 0, nh, ifn });
    }
    table.set(d.id, rs);
  }
  // adjacency
  const adj = new Map<string, Adj[]>();
  for (const d of rdevs) {
    const list: Adj[] = []; const seen = new Set<string>();
    for (const my of ifs.get(d.id)!) {
      if (my.cfg.type === 'lo') continue;
      let ends: { dev: Dev; port: string; tag: number | null }[] = [];
      if (my.port !== undefined) ends = net.l2reach(d, my.port, my.tag ?? null);
      else for (const p of d.ports) {
        const ic = net.cfgIf(d, p.name); if (!ic || ic.routed || !net.portPhy(d, p.name).up) continue;
        const v = my.vlan!;
        if (ic.swMode === 'access' && ic.accessVlan === v) ends.push(...net.l2reach(d, p.name, null));
        else if (ic.swMode === 'trunk' && allowsVlan(ic.allowed, v)) ends.push(...net.l2reach(d, p.name, v === ic.nativeVlan ? null : v));
      }
      for (const e of ends) {
        if (e.dev.id === d.id || !ifs.has(e.dev.id)) continue;
        const nb = ifs.get(e.dev.id)!.find(x => (e.port === '' ? x.vlan === e.tag && x.port === undefined : x.port === e.port && (x.tag ?? null) === e.tag) && x.cfg.type !== 'lo');
        if (!nb || nb.mask !== my.mask || !inNet(nb.ip, my.ip, maskToLen(my.mask)!) || nb.ip === my.ip) continue;
        const k = `${my.name}|${e.dev.id}|${nb.name}`; if (seen.has(k)) continue; seen.add(k);
        list.push({ my, nbr: e.dev, nbrIf: nb });
      }
    }
    adj.set(d.id, list);
  }
  const best = new Map<string, Route[]>(); for (const d of rdevs) best.set(d.id, []);
  const push = (d: Dev, r: Route) => best.get(d.id)!.push(r);
  const staticOut = (d: Dev) => table.get(d.id)!.filter(r => r.code === 'S');
  const connOut = (d: Dev) => table.get(d.id)!.filter(r => r.code === 'C');

  // ---- RIP ----
  const ripDevs = rdevs.filter(d => d.cfg.rip);
  const ripOn = (d: Dev, i: L3If) => !!d.cfg.rip && d.cfg.rip.nets.some(n => inNet(i.ip, n, classfulLen(n)));
  if (ripDevs.length) {
    type R = { net: number; len: number; metric: number; nh?: string; ifn: string; via: string | null };
    const st = new Map<string, Map<string, R>>();
    for (const d of ripDevs) {
      const m = new Map<string, R>();
      for (const i of ifs.get(d.id)!) if (ripOn(d, i)) { const len = maskToLen(i.mask)!; const r = { net: netInt(parseIp(i.ip)!, len), len, metric: 0, ifn: i.name, via: null }; m.set(netKey(r), r); }
      if (d.cfg.rip!.defOrig) m.set('0/0', { net: 0, len: 0, metric: 0, ifn: '', via: null });
      if (d.cfg.rip!.redistStatic) for (const s of staticOut(d)) m.set(netKey(s), { net: s.net, len: s.len, metric: 1, ifn: '', via: null });
      if (d.cfg.rip!.redistConn) for (const s of connOut(d)) if (!m.has(netKey(s))) m.set(netKey(s), { net: s.net, len: s.len, metric: 1, ifn: '', via: null });
      st.set(d.id, m);
    }
    for (let round = 0; round < 16; round++) {
      let changed = false;
      for (const d of ripDevs) for (const a of adj.get(d.id)!) {
        if (!st.has(a.nbr.id) || !ripOn(d, a.my) || !ripOn(a.nbr, a.nbrIf) || a.nbr.cfg.rip!.passive.includes(a.nbrIf.name)) continue;
        for (const [k, r] of st.get(a.nbr.id)!) {
          if (r.via === d.id) continue; const metric = r.metric + 1; if (metric > 15) continue;
          const mine = st.get(d.id)!; const cur = mine.get(k);
          if (cur && cur.metric <= metric) continue;
          mine.set(k, { net: r.net, len: r.len, metric, nh: a.nbrIf.ip, ifn: a.my.name, via: a.nbr.id }); changed = true;
        }
      }
      if (!changed) break;
    }
    for (const d of ripDevs) {
      const ns: Nbr[] = [];
      for (const [, r] of st.get(d.id)!) if (r.via) push(d, { net: r.net, len: r.len, code: 'R', ad: 120, metric: r.metric, nh: r.nh, ifn: r.ifn });
      for (const a of adj.get(d.id)!) if (ripOn(d, a.my) && st.has(a.nbr.id) && ripOn(a.nbr, a.nbrIf)) ns.push({ rid: a.nbr.name, prio: 0, state: '', addr: a.nbrIf.ip, ifn: a.my.name });
      info.rip.set(d.id, ns);
    }
  }

  // ---- OSPF ----
  const ospfDevs = rdevs.filter(d => d.cfg.ospf.length);
  const ospfArea = (d: Dev, i: L3If): number | null => { const n = d.cfg.ospf[0].nets.find(x => wildMatch(i.ip, x.net, x.wild)); return n ? n.area : null; };
  const ridOf = (d: Dev): string => {
    const c = d.cfg.ospf[0]; if (c?.rid) return c.rid;
    const all = ifs.get(d.id)!; const lo = all.filter(i => i.cfg.type === 'lo').map(i => i.ip).sort((a, b) => (parseIp(b) ?? 0) - (parseIp(a) ?? 0));
    const ph = all.map(i => i.ip).sort((a, b) => (parseIp(b) ?? 0) - (parseIp(a) ?? 0));
    return lo[0] ?? ph[0] ?? '0.0.0.0';
  };
  const costOf = (d: Dev, i: L3If): number => i.cfg.ospfCost ?? Math.max(1, Math.floor(((d.cfg.ospf[0]?.refBw ?? 100) * 1000) / bwOf(i)));
  if (ospfDevs.length) {
    const on = (d: Dev, i: L3If) => ospfArea(d, i) !== null;
    const edges = new Map<string, { to: Dev; my: L3If; nbrIf: L3If }[]>();
    for (const d of ospfDevs) {
      info.rids.set(d.id, ridOf(d)); const list: { to: Dev; my: L3If; nbrIf: L3If }[] = [];
      for (const a of adj.get(d.id)!) {
        const c = a.nbr.cfg.ospf[0]; if (!c || !on(d, a.my) || !on(a.nbr, a.nbrIf)) continue;
        if (ospfArea(d, a.my) !== ospfArea(a.nbr, a.nbrIf)) continue;
        if (d.cfg.ospf[0].passive.includes(a.my.name) || c.passive.includes(a.nbrIf.name)) continue;
        list.push({ to: a.nbr, my: a.my, nbrIf: a.nbrIf });
      }
      edges.set(d.id, list);
    }
    for (const d of ospfDevs) {
      const dist = new Map<string, number>([[d.id, 0]]); const hops = new Map<string, { my: L3If; nbrIf: L3If }[]>(); const done = new Set<string>();
      for (;;) {
        let cur: string | null = null, bd = Infinity;
        for (const [id, v] of dist) if (!done.has(id) && v < bd) { bd = v; cur = id; }
        if (cur === null) break; done.add(cur); const cd = net.dev(cur)!;
        for (const e of edges.get(cur) ?? []) {
          const nd = bd + costOf(cd, e.my); const old = dist.get(e.to.id);
          const fh = cur === d.id ? [{ my: e.my, nbrIf: e.nbrIf }] : hops.get(cur)!;
          if (old === undefined || nd < old) { dist.set(e.to.id, nd); hops.set(e.to.id, fh.slice()); }
          else if (nd === old) { const hs = hops.get(e.to.id)!; for (const h of fh) if (!hs.some(x => x.my.name === h.my.name && x.nbrIf.ip === h.nbrIf.ip)) hs.push(h); }
        }
      }
      const myAreas = new Set(ifs.get(d.id)!.map(i => ospfArea(d, i)).filter((x): x is number => x !== null));
      const cand = new Map<string, { net: number; len: number; metric: number; code: string; hs: { my: L3If; nbrIf: L3If }[] }>();
      const offer = (n: number, len: number, metric: number, code: string, hs: { my: L3If; nbrIf: L3If }[]) => {
        const k = `${n}/${len}`; const cur = cand.get(k);
        if (!cur || metric < cur.metric) cand.set(k, { net: n, len, metric, code, hs: hs.slice() });
        else if (metric === cur.metric) for (const h of hs) if (!cur.hs.some(x => x.my.name === h.my.name && x.nbrIf.ip === h.nbrIf.ip)) cur.hs.push(h);
      };
      for (const [xid, dd] of dist) {
        if (xid === d.id) continue; const x = net.dev(xid)!; const c = x.cfg.ospf[0];
        for (const i of ifs.get(xid)!) {
          const area = ospfArea(x, i); if (area === null) continue; const len = i.cfg.type === 'lo' ? 32 : maskToLen(i.mask)!;
          offer(netInt(parseIp(i.ip)!, len), len, dd + (i.cfg.type === 'lo' ? 1 : costOf(x, i)), myAreas.has(area) ? 'O' : 'O IA', hops.get(xid)!);
        }
        if (c.defOrig) offer(0, 0, dd + 1, 'O*E2', hops.get(xid)!);
        if (c.redistStatic) for (const s of staticOut(x)) offer(s.net, s.len, dd + 20, 'O E2', hops.get(xid)!);
        if (c.redistConn) for (const s of connOut(x)) offer(s.net, s.len, dd + 20, 'O E2', hops.get(xid)!);
      }
      for (const [, r] of cand) {
        if (table.get(d.id)!.some(t => t.code === 'C' && t.net === r.net && t.len === r.len)) continue;
        for (const h of r.hs) push(d, { net: r.net, len: r.len, code: r.code, ad: 110, metric: r.metric, nh: h.nbrIf.ip, ifn: h.my.name });
      }
      // neighbor table with a simple DR election per segment
      const ns: Nbr[] = [];
      for (const e of edges.get(d.id)!) {
        const peers = [{ id: d.id, prio: d.cfg.ospf[0].passive.length >= 0 ? (e.my.cfg.ospfPrio ?? 1) : 1, rid: info.rids.get(d.id)! }, { id: e.to.id, prio: e.nbrIf.cfg.ospfPrio ?? 1, rid: ridOf(e.to) }];
        const p2p = e.my.name.startsWith('Serial');
        const rank = (p: { prio: number; rid: string }) => p.prio * 1e12 + (parseIp(p.rid) ?? 0);
        const sorted = peers.filter(p => p.prio > 0).sort((a, b) => rank(b) - rank(a));
        const role = p2p ? '  -' : sorted[0] && sorted[0].id === e.to.id ? '/DR' : sorted[1] && sorted[1].id === e.to.id ? '/BDR' : '/DROTHER';
        ns.push({ rid: ridOf(e.to), prio: e.nbrIf.cfg.ospfPrio ?? 1, state: p2p ? 'FULL/  -' : 'FULL' + role, addr: e.nbrIf.ip, ifn: e.my.name });
      }
      info.ospf.set(d.id, ns);
    }
  }

  // ---- EIGRP ----
  const eDevs = rdevs.filter(d => d.cfg.eigrp.length);
  const eOn = (d: Dev, i: L3If) => d.cfg.eigrp[0].nets.some(n => n.wild ? wildMatch(i.ip, n.net, n.wild) : inNet(i.ip, n.net, classfulLen(n.net)));
  if (eDevs.length) {
    const metricOf = (bw: number, dly: number) => 256 * (Math.floor(1e7 / bw) + Math.floor(dly / 10));
    const edges = new Map<string, Adj[]>();
    for (const d of eDevs) edges.set(d.id, adj.get(d.id)!.filter(a => a.nbr.cfg.eigrp.length && a.nbr.cfg.eigrp[0].as === d.cfg.eigrp[0].as && eOn(d, a.my) && eOn(a.nbr, a.nbrIf) && !d.cfg.eigrp[0].passive.includes(a.my.name) && !a.nbr.cfg.eigrp[0].passive.includes(a.nbrIf.name)));
    for (const d of eDevs) {
      type S = { bw: number; dly: number; hs: Adj[] };
      const st = new Map<string, S>([[d.id, { bw: Infinity, dly: 0, hs: [] }]]); const done = new Set<string>();
      for (;;) {
        let cur: string | null = null, bm = Infinity;
        for (const [id, s] of st) { if (done.has(id)) continue; const m = s.bw === Infinity ? 0 : metricOf(s.bw, s.dly); if (m < bm) { bm = m; cur = id; } }
        if (cur === null) break; done.add(cur); const cs = st.get(cur)!;
        for (const e of edges.get(cur) ?? []) {
          const bw = Math.min(cs.bw, bwOf(e.my)), dly = cs.dly + dlyOf(e.my); const old = st.get(e.nbr.id);
          const fh = cur === d.id ? [e] : cs.hs; const m = metricOf(bw, dly);
          if (!old || m < metricOf(old.bw, old.dly)) st.set(e.nbr.id, { bw, dly, hs: fh.slice() });
        }
      }
      const cand = new Map<string, { net: number; len: number; metric: number; ex: boolean; hs: Adj[] }>();
      for (const [xid, s] of st) {
        if (xid === d.id) continue; const x = net.dev(xid)!;
        const offer = (n: number, len: number, bw: number, dly: number, ex: boolean) => {
          const m = metricOf(Math.min(s.bw, bw), s.dly + dly); const k = `${n}/${len}`; const cur = cand.get(k);
          if (!cur || m < cur.metric) cand.set(k, { net: n, len, metric: m, ex, hs: s.hs.slice() });
        };
        for (const i of ifs.get(xid)!) if (eOn(x, i)) { const len = i.cfg.type === 'lo' ? 32 : maskToLen(i.mask)!; offer(netInt(parseIp(i.ip)!, len), len, bwOf(i), dlyOf(i), false); }
        if (x.cfg.eigrp[0].redistStatic) for (const r of staticOut(x)) offer(r.net, r.len, 100000, 100, true);
        if (x.cfg.eigrp[0].redistConn) for (const r of connOut(x)) offer(r.net, r.len, 100000, 100, true);
      }
      for (const [, r] of cand) {
        if (table.get(d.id)!.some(t => t.code === 'C' && t.net === r.net && t.len === r.len)) continue;
        for (const h of r.hs.slice(0, 1)) push(d, { net: r.net, len: r.len, code: r.ex ? 'D EX' : 'D', ad: r.ex ? 170 : 90, metric: r.metric, nh: h.nbrIf.ip, ifn: h.my.name });
      }
      info.eigrp.set(d.id, edges.get(d.id)!.map(a => ({ rid: a.nbr.name, prio: 0, state: '', addr: a.nbrIf.ip, ifn: a.my.name, as: d.cfg.eigrp[0].as })));
    }
  }

  // ---- select per prefix ----
  for (const d of rdevs) {
    const all = [...table.get(d.id)!, ...best.get(d.id)!]; const groups = new Map<string, Route[]>();
    for (const r of all) { const k = netKey(r); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
    const out: Route[] = [];
    for (const [, g] of groups) {
      const minAd = Math.min(...g.map(r => r.ad)); const ad = g.filter(r => r.ad === minAd);
      const minM = Math.min(...ad.map(r => r.metric)); out.push(...ad.filter(r => r.metric === minM));
    }
    out.sort((a, b) => a.net - b.net || a.len - b.len); info.routes.set(d.id, out);
  }
  return info;
}

export function lookup(routes: Route[], dst: string): Route | null {
  const d = parseIp(dst); if (d === null) return null; let best: Route | null = null;
  for (const r of routes) {
    if (r.code === 'L' && r.net !== d) continue;
    if (netInt(d, r.len) !== r.net) continue;
    if (!best || r.len > best.len || (r.len === best.len && (r.ad < best.ad || (r.ad === best.ad && r.metric < best.metric)))) best = r;
  }
  return best;
}

import { useSyncExternalStore } from 'react';
import { Net } from '../model/net.ts';
import type { Dev } from '../model/types.ts';
import { Trace, echoOnce, finalize, httpGet, udpSend, type TEv } from '../sim/engine.ts';
import { Cli } from '../ios/cli.ts';

export const net = new Net();
export type Tool = 'select' | 'note' | 'delete' | 'inspect' | 'pdu' | 'cpdu' | 'cable' | 'place';
export interface PduRec { id: number; scenario: number; src: string; dst: string; dstIp: string; type: string; color: string; status: '' | 'Successful' | 'Failed'; time: number; periodic: boolean; num: number; ttl: number; size: number; port: number }
export interface WinState { id: string; kind: string; devId?: string; data?: any; x: number; y: number; z: number; title: string }
export interface Prefs { devLabels: boolean; portLabels: boolean; linkLights: boolean; grid: boolean; animMs: number }
export interface PortMenu { devId: string; x: number; y: number }
export const PDU_COLORS = ['#e53935', '#43a047', '#1e88e5', '#fb8c00', '#8e24aa', '#00acc1', '#f4511e', '#6d4c41', '#3949ab', '#c0ca33'];
const loadPrefs = (): Prefs => { try { const s = localStorage.getItem('cisconetx.prefs'); if (s) return { devLabels: true, portLabels: true, linkLights: true, grid: false, animMs: 500, ...JSON.parse(s) }; } catch { /* ignore */ } return { devLabels: true, portLabels: true, linkLights: true, grid: false, animMs: 500 }; };

export const ui = {
  tool: 'select' as Tool, cableSel: 'auto', placing: null as string | null, selected: [] as string[],
  mode: 'realtime' as 'realtime' | 'simulation', view: 'logical' as 'logical' | 'physical', zoom: 1, panX: 40, panY: 20,
  wins: [] as WinState[], zTop: 10, pdus: [] as PduRec[], pduN: 1, scenarios: [{ id: 0, name: 'Scenario 0' }], scenario: 0, pduWin: true,
  prefs: loadPrefs(), toast: '', pduSrc: null as string | null, cableFrom: null as { dev: string; port: string } | null, portMenu: null as PortMenu | null,
  guiLog: {} as Record<string, string[]>, palCat: 'router', palSel: '', hint: '', clipboard: [] as string[],
};
let ver = 0; const subs = new Set<() => void>();
export const uiTouch = (): void => { ver++; subs.forEach(f => f()); };
const subscribe = (f: () => void): (() => void) => { subs.add(f); const u = net.subscribe(f); return () => { subs.delete(f); u(); }; };
const snap = (): string => `${net.rev}.${Math.floor(net.clock)}.${ver}`;
export function useRev(): string { return useSyncExternalStore(subscribe, snap); }
export const savePrefs = (): void => { try { localStorage.setItem('cisconetx.prefs', JSON.stringify(ui.prefs)); } catch { /* ignore */ } uiTouch(); };
export function toast(msg: string, ms = 3500): void { ui.toast = msg; uiTouch(); setTimeout(() => { if (ui.toast === msg) { ui.toast = ''; uiTouch(); } }, ms); }

// ---- undo / redo / autosave ----
const hist: string[] = []; let hidx = -1;
export function commit(): void {
  const s = net.snapshot(); if (hist[hidx] === s) return; hist.splice(hidx + 1); hist.push(s); if (hist.length > 60) hist.shift(); hidx = hist.length - 1;
  scheduleSave();
}
export function undo(): void { if (hidx > 0) { hidx--; net.restore(hist[hidx]); ui.selected = []; uiTouch(); } }
export function redo(): void { if (hidx < hist.length - 1) { hidx++; net.restore(hist[hidx]); ui.selected = []; uiTouch(); } }
let saveT: number | undefined;
function scheduleSave(): void { clearTimeout(saveT); saveT = window.setTimeout(() => { try { localStorage.setItem('cisconetx.autosave', net.snapshot()); } catch { /* quota */ } }, 600); }
export function loadAutosave(): boolean { try { const s = localStorage.getItem('cisconetx.autosave'); if (s) { net.restore(s); return true; } } catch { /* ignore */ } return false; }
export function resetAll(): void { Cli.resetAll(); net.clear(); ui.pdus = []; ui.selected = []; ui.wins = []; sim.events = []; sim.cursor = 0; sim.last = []; ui.pduN = 1; for (const d of net.devices) Cli.reset(d.id); commit(); uiTouch(); }
export function loadTopology(obj: unknown): void { Cli.resetAll(); net.load(obj); ui.pdus = []; ui.selected = []; ui.wins = []; ui.panX = 40; ui.panY = 20; ui.zoom = 1; sim.events = []; sim.cursor = 0; sim.last = []; commit(); uiTouch(); }

// ---- windows ----
export function openWin(kind: string, title: string, o: { id?: string; devId?: string; data?: any; x?: number; y?: number } = {}): void {
  const id = o.id ?? `${kind}:${o.devId ?? ''}`; const ex = ui.wins.find(w => w.id === id);
  if (ex) { ex.z = ++ui.zTop; uiTouch(); return; }
  const n = ui.wins.length; ui.wins.push({ id, kind, title, devId: o.devId, data: o.data, x: o.x ?? 120 + n * 28, y: o.y ?? 70 + n * 28, z: ++ui.zTop });
  uiTouch();
}
export function closeWin(id: string): void { ui.wins = ui.wins.filter(w => w.id !== id); uiTouch(); }
export function focusWin(id: string): void { const w = ui.wins.find(x => x.id === id); if (w && w.z !== ui.zTop) { w.z = ++ui.zTop; uiTouch(); } }
export function openDevice(d: Dev): void { openWin('device', d.name, { devId: d.id }); }

// ---- simulation player ----
export interface SEv extends TEv { n: number }
export const sim = { events: [] as SEv[], cursor: 0, last: [] as SEv[], playing: false, constantDelay: true, filters: { ARP: true, ICMP: true, TCP: true, UDP: true, DNS: true, DHCP: true, HTTP: true } as Record<string, boolean>, waiters: [] as { upTo: number; resolve: () => void }[], timer: 0 as number | undefined, stamp: 0 };
export function playTrace(tr: Trace): Promise<void> {
  if (ui.mode !== 'simulation' || !tr.events.length) return Promise.resolve();
  const off = sim.events.length ? sim.events[sim.events.length - 1].t + 0.001 : 0;
  for (const e of tr.events) sim.events.push({ ...e, t: e.t + off, n: sim.events.length });
  uiTouch();
  return new Promise<void>(res => { sim.waiters.push({ upTo: sim.events.length, resolve: res }); });
}
function release(): void { const keep: typeof sim.waiters = []; for (const w of sim.waiters) { if (w.upTo <= sim.cursor) w.resolve(); else keep.push(w); } sim.waiters = keep; }
export function stepFwd(): boolean {
  if (sim.cursor >= sim.events.length) { release(); stopPlay(); return false; }
  const t0 = sim.events[sim.cursor].t; let j = sim.cursor; while (j < sim.events.length && Math.abs(sim.events[j].t - t0) < 1e-9) j++;
  sim.last = sim.events.slice(sim.cursor, j); sim.cursor = j; sim.stamp++; release(); uiTouch(); return true;
}
export function stepBack(): void {
  if (sim.cursor <= 0) return; let j = sim.cursor - 1; const t0 = sim.events[j].t; while (j > 0 && Math.abs(sim.events[j - 1].t - t0) < 1e-9) j--;
  sim.cursor = j; let k = j; sim.last = []; if (k > 0) { const t1 = sim.events[k - 1].t; let s = k - 1; while (s > 0 && Math.abs(sim.events[s - 1].t - t1) < 1e-9) s--; sim.last = sim.events.slice(s, k); }
  sim.stamp++; uiTouch();
}
export function stopPlay(): void { sim.playing = false; clearInterval(sim.timer); uiTouch(); }
export function startPlay(): void { if (sim.playing) return; sim.playing = true; sim.timer = window.setInterval(() => { if (!stepFwd()) stopPlay(); }, ui.prefs.animMs + 150); uiTouch(); }
export function finishAll(): void { sim.cursor = sim.events.length; release(); stopPlay(); }
export function resetSim(): void { stopPlay(); sim.events = []; sim.cursor = 0; sim.last = []; for (const w of sim.waiters) w.resolve(); sim.waiters = []; uiTouch(); }
export function setMode(m: 'realtime' | 'simulation'): void { if (m === 'realtime' && ui.mode === 'simulation') { finishAll(); resetSim(); } ui.mode = m; uiTouch(); }
export const visibleEvents = (): SEv[] => sim.events.slice(0, sim.cursor).filter(e => sim.filters[e.type] !== false);

// ---- PDUs ----
export const primaryIp = (d?: Dev): string => { const c = d?.cfg.ifs.find(i => i.ip && i.type !== 'lo') ?? d?.cfg.ifs.find(i => i.ip); return c?.ip ?? ''; };
export async function firePdu(rec: PduRec): Promise<void> {
  const src = net.dev(rec.src); const dst = net.dev(rec.dst); if (!src) return;
  const ip = rec.dstIp || primaryIp(dst);
  if (!ip) { rec.status = 'Failed'; uiTouch(); return; }
  let ok = false; let tr: Trace;
  if (rec.type === 'HTTP') { const r = httpGet(net, src, ip); ok = r.result.ok; tr = r.trace; }
  else if (rec.type === 'UDP') { const r = udpSend(net, src, ip, rec.port); ok = r.ok; tr = r.trace; }
  else { tr = new Trace(net); const res = echoOnce(tr, src, ip, rec.num++, 0, { size: rec.size, ttl: rec.ttl || undefined, hold: false }); finalize(tr); ok = res.status === 'reply'; }
  rec.time = tr.events.length ? Math.round(tr.events[tr.events.length - 1].t * 1000) / 1000 : 0;
  if (ui.mode === 'simulation') { rec.status = ''; uiTouch(); await playTrace(tr); }
  rec.status = ok ? 'Successful' : 'Failed'; uiTouch();
}
export function addPdu(src: string, dst: string, o: Partial<PduRec> = {}): PduRec {
  const rec: PduRec = { id: ui.pduN++, scenario: ui.scenario, src, dst, dstIp: '', type: 'ICMP', color: PDU_COLORS[(ui.pduN - 1) % PDU_COLORS.length], status: '', time: 0, periodic: false, num: 0, ttl: 0, size: 32, port: 5000, ...o };
  ui.pdus.push(rec); uiTouch(); void firePdu(rec); return rec;
}

// ---- GUI → IOS commands ----
export function runGui(d: Dev, cmds: string[]): void {
  const cli = Cli.detached(net, d); const log = ui.guiLog[d.id] ?? (ui.guiLog[d.id] = []);
  const go = async () => { for (const c of cmds) { log.push(`${cli.prompt()}${c}`); const o = await cli.exec(c); if (o) log.push(o); } uiTouch(); };
  void go();
}
export function powerCycleAll(): void { for (const d of net.devices) { net.powerCycle(d); Cli.reset(d.id); } net.settle(); toast('All devices power cycled.'); }
export function fastForward(): void { net.settle(); toast('Time fast-forwarded: links and timers settled.'); }
setInterval(() => { if (ui.mode === 'realtime' && net.devices.length) net.advance(1); }, 1000);

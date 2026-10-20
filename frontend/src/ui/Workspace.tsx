import { useEffect, useRef, useState } from 'react';
import type { Cable, Dev } from '../model/types.ts';
import { modelOf } from '../model/catalog.ts';
import { DevIcon } from './icons.tsx';
import { net, ui, uiTouch, useRev, commit, openDevice, openWin, addPdu, sim, toast } from './store.ts';

const COL = { green: '#2ecc40', amber: '#ffb300', red: '#e53935' } as const;
type DragState =
  | { kind: 'move'; ids: string[]; sx: number; sy: number; orig: Record<string, { x: number; y: number }>; moved: boolean }
  | { kind: 'rubber'; x0: number; y0: number }
  | { kind: 'pan'; sx: number; sy: number; px: number; py: number }
  | { kind: 'note'; id: string; sx: number; sy: number; ox: number; oy: number };

function cablePath(c: Cable, a: Dev, b: Dev): string {
  if (c.type !== 'serial') return `M${a.x} ${a.y} L${b.x} ${b.y}`;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; const dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; const ux = dx / l, uy = dy / l; const px = -uy * 9, py = ux * 9;
  return `M${a.x} ${a.y} L${mx - ux * 14} ${my - uy * 14} L${mx - ux * 4 + px} ${my - uy * 4 + py} L${mx + ux * 4 - px} ${my + uy * 4 - py} L${mx + ux * 14} ${my + uy * 14} L${b.x} ${b.y}`;
}
const along = (a: Dev, b: Dev, d: number) => { const dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; return { x: a.x + (dx / l) * d, y: a.y + (dy / l) * d, nx: -dy / l, ny: dx / l }; };

export function Workspace() {
  useRev();
  const svgRef = useRef<SVGSVGElement>(null); const drag = useRef<DragState | null>(null);
  const [rubber, setRubber] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [tip, setTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [inspect, setInspect] = useState<{ devId: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<number | undefined>(undefined); const lastTap = useRef({ id: '', t: 0 });
  const world = (cx: number, cy: number) => { const r = svgRef.current!.getBoundingClientRect(); return { x: (cx - r.left - ui.panX) / ui.zoom, y: (cy - r.top - ui.panY) / ui.zoom }; };
  const rel = (cx: number, cy: number) => { const r = svgRef.current!.getBoundingClientRect(); return { x: cx - r.left, y: cy - r.top }; };

  useEffect(() => {
    const el = svgRef.current; if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) { const r = el.getBoundingClientRect(); const mx = e.clientX - r.left, my = e.clientY - r.top; const z = Math.min(3, Math.max(0.3, ui.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))); ui.panX = mx - ((mx - ui.panX) / ui.zoom) * z; ui.panY = my - ((my - ui.panY) / ui.zoom) * z; ui.zoom = z; }
      else { ui.panX -= e.shiftKey ? e.deltaY : e.deltaX; ui.panY -= e.shiftKey ? 0 : e.deltaY; }
      uiTouch();
    };
    el.addEventListener('wheel', wheel, { passive: false }); return () => el.removeEventListener('wheel', wheel);
  }, []);

  const devAt = (id: string) => net.dev(id);

  function onBgDown(e: any) {
    if (e.button === 2) return;
    const w = world(e.clientX, e.clientY); setInspect(null);
    if (e.button === 1) { drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, px: ui.panX, py: ui.panY }; svgRef.current!.setPointerCapture(e.pointerId); return; }
    if (ui.tool === 'place' && ui.placing) { const d = net.addDevice(ui.placing, Math.round(w.x), Math.round(w.y)); commit(); ui.selected = [d.id]; if (!e.shiftKey) { ui.placing = null; ui.tool = 'select'; } uiTouch(); return; }
    if (ui.tool === 'note') { net.notes.push({ id: 'n' + net.noteN++, x: w.x, y: w.y, text: '' }); ui.tool = 'select'; net.touch(); commit(); return; }
    if (ui.tool === 'cable' && ui.cableFrom) { ui.cableFrom = null; uiTouch(); return; }
    if (ui.tool === 'select') { if (!e.shiftKey) ui.selected = []; drag.current = { kind: 'rubber', x0: w.x, y0: w.y }; setRubber({ x0: w.x, y0: w.y, x1: w.x, y1: w.y }); svgRef.current!.setPointerCapture(e.pointerId); uiTouch(); }
  }
  function onDevDown(e: any, d: Dev) {
    e.stopPropagation(); if (e.button === 2) return;
    const t = ui.tool; setInspect(null);
    if (t === 'delete') { net.removeDevice(d.id); ui.selected = ui.selected.filter(x => x !== d.id); ui.wins = ui.wins.filter(w => w.devId !== d.id); commit(); uiTouch(); return; }
    if (t === 'inspect') { const p = rel(e.clientX, e.clientY); setInspect({ devId: d.id, x: p.x, y: p.y }); return; }
    if (t === 'pdu') { if (!ui.pduSrc) { ui.pduSrc = d.id; ui.hint = 'Select a destination device for the PDU'; uiTouch(); } else if (ui.pduSrc !== d.id) { addPdu(ui.pduSrc, d.id); ui.pduSrc = null; ui.hint = ''; uiTouch(); } return; }
    if (t === 'cpdu') { openWin('cpdu', 'Create Complex PDU', { devId: d.id, id: 'cpdu', data: { src: d.id } }); return; }
    if (t === 'cable') { const p = rel(e.clientX, e.clientY); ui.portMenu = { devId: d.id, x: p.x, y: p.y }; uiTouch(); return; }
    if (t !== 'select') return;
    const now = performance.now(); if (lastTap.current.id === d.id && now - lastTap.current.t < 400) { lastTap.current = { id: '', t: 0 }; openDevice(d); return; } lastTap.current = { id: d.id, t: now };
    if (e.shiftKey) ui.selected = ui.selected.includes(d.id) ? ui.selected.filter(x => x !== d.id) : [...ui.selected, d.id]; else if (!ui.selected.includes(d.id)) ui.selected = [d.id];
    const w = world(e.clientX, e.clientY); const orig: Record<string, { x: number; y: number }> = {}; for (const id of ui.selected) { const dd = devAt(id); if (dd) orig[id] = { x: dd.x, y: dd.y }; }
    drag.current = { kind: 'move', ids: [...ui.selected], sx: w.x, sy: w.y, orig, moved: false }; svgRef.current!.setPointerCapture(e.pointerId); uiTouch();
  }
  function onMove(e: any) {
    const w = world(e.clientX, e.clientY); if (ui.tool === 'cable' && ui.cableFrom) setCursor(w);
    const d = drag.current; if (!d) return;
    if (d.kind === 'move') { const dx = w.x - d.sx, dy = w.y - d.sy; if (!d.moved && Math.hypot(dx, dy) < 3) return; d.moved = true; for (const id of d.ids) { const dev = devAt(id); if (dev) { dev.x = Math.round(d.orig[id].x + dx); dev.y = Math.round(d.orig[id].y + dy); } } net.touch(); }
    else if (d.kind === 'rubber') setRubber({ x0: d.x0, y0: d.y0, x1: w.x, y1: w.y });
    else if (d.kind === 'pan') { ui.panX = d.px + e.clientX - d.sx; ui.panY = d.py + e.clientY - d.sy; uiTouch(); }
    else if (d.kind === 'note') { const n = net.notes.find(x => x.id === d.id); if (n) { n.x = d.ox + w.x - d.sx; n.y = d.oy + w.y - d.sy; net.touch(); } }
  }
  function onUp(e: any) {
    const d = drag.current; drag.current = null; try { svgRef.current!.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d) return;
    if (d.kind === 'move' && d.moved) commit();
    if (d.kind === 'note') commit();
    if (d.kind === 'rubber' && rubber) { const x0 = Math.min(rubber.x0, rubber.x1), x1 = Math.max(rubber.x0, rubber.x1), y0 = Math.min(rubber.y0, rubber.y1), y1 = Math.max(rubber.y0, rubber.y1); const ids = net.devices.filter(v => v.x >= x0 && v.x <= x1 && v.y >= y0 && v.y <= y1).map(v => v.id); ui.selected = e.shiftKey ? [...new Set([...ui.selected, ...ids])] : ids; setRubber(null); uiTouch(); }
  }
  function onDrop(e: any) { e.preventDefault(); const m = e.dataTransfer.getData('text/cnx-model'); if (!m) return; const w = world(e.clientX, e.clientY); const d = net.addDevice(m, Math.round(w.x), Math.round(w.y)); ui.selected = [d.id]; ui.tool = 'select'; ui.placing = null; commit(); uiTouch(); }
  function cableDown(e: any, c: Cable) { if (ui.tool !== 'delete') return; e.stopPropagation(); net.disconnect(c.id); commit(); uiTouch(); }
  function pickPort(devId: string, port: string) {
    const m = ui.portMenu; ui.portMenu = null; if (!m) return;
    if (!ui.cableFrom) { ui.cableFrom = { dev: devId, port }; ui.hint = 'Select a device to connect to'; uiTouch(); return; }
    const r = net.connect(ui.cableSel, ui.cableFrom, { dev: devId, port }); ui.cableFrom = null; ui.hint = '';
    if (!r.ok) toast(r.error ?? 'Could not connect'); else commit(); uiTouch();
  }

  const tf = `translate(${ui.panX} ${ui.panY}) scale(${ui.zoom})`; const prefs = ui.prefs;
  const from = ui.cableFrom ? devAt(ui.cableFrom.dev) : undefined;
  const menuDev = ui.portMenu ? devAt(ui.portMenu.devId) : undefined;
  const cls = `ws tool-${ui.tool}${ui.tool === 'select' ? '' : ' tool-active'}`;
  const tipDev = tip ? devAt(tip.id) : undefined;

  return (
    <div className={cls} onDragOver={e => e.preventDefault()} onDrop={onDrop} onContextMenu={e => { e.preventDefault(); ui.tool = 'select'; ui.placing = null; ui.cableFrom = null; ui.pduSrc = null; ui.portMenu = null; ui.hint = ''; uiTouch(); }}>
      <svg ref={svgRef} className="ws-svg" onPointerDown={onBgDown} onPointerMove={onMove} onPointerUp={onUp}>
        {prefs.grid && <defs><pattern id="grid" width={40 * ui.zoom} height={40 * ui.zoom} patternUnits="userSpaceOnUse" x={ui.panX} y={ui.panY}><path d={`M ${40 * ui.zoom} 0 L 0 0 0 ${40 * ui.zoom}`} fill="none" stroke="#e3e9f2" strokeWidth="1" /></pattern></defs>}
        {prefs.grid && <rect width="100%" height="100%" fill="url(#grid)" />}
        <g transform={tf}>
          {net.cables.map(c => {
            const a = devAt(c.a.dev), b = devAt(c.b.dev); if (!a || !b) return null;
            const pa = net.portPhy(a, c.a.port), pb = net.portPhy(b, c.b.port);
            const stroke = c.type === 'console' ? '#2aa4e8' : c.type === 'serial' ? '#d32f2f' : '#1b1b1b'; const dash = c.type === 'cross' ? '7 4' : c.type === 'console' ? '2 3' : undefined;
            const la = along(a, b, 40), lb = along(b, a, 40); const ta = along(a, b, 30), tb = along(b, a, 30); const len = Math.hypot(a.x - b.x, a.y - b.y);
            const showLights = prefs.linkLights && c.type !== 'console' && len > 80; const pl = prefs.portLabels && len > 110;
            return (
              <g key={c.id} onPointerDown={e => cableDown(e, c)} className="cable">
                <path d={cablePath(c, a, b)} stroke="transparent" strokeWidth="12" fill="none" />
                <path d={cablePath(c, a, b)} stroke={stroke} strokeWidth={c.type === 'console' ? 2 : 2.2} strokeDasharray={dash} fill="none"><title>{`${net.cableLabel(c.type)}: ${a.name} ${c.a.port} — ${b.name} ${c.b.port}`}</title></path>
                {showLights && <circle cx={ta.x} cy={ta.y} r="4" fill={COL[pa.color as keyof typeof COL] ?? '#999'} stroke="#222" strokeWidth=".8" />}
                {showLights && <circle cx={tb.x} cy={tb.y} r="4" fill={COL[pb.color as keyof typeof COL] ?? '#999'} stroke="#222" strokeWidth=".8" />}
                {pl && <text x={la.x + la.nx * 11} y={la.y + la.ny * 11 + 3} className="portlbl" textAnchor="middle">{c.a.port.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig').replace('Serial', 'Se')}</text>}
                {pl && <text x={lb.x + lb.nx * 11} y={lb.y + lb.ny * 11 + 3} className="portlbl" textAnchor="middle">{c.b.port.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig').replace('Serial', 'Se')}</text>}
              </g>
            );
          })}
          {from && cursor && <line x1={from.x} y1={from.y} x2={cursor.x} y2={cursor.y} stroke="#222" strokeWidth="2" strokeDasharray="5 4" pointerEvents="none" />}
          {net.devices.map(d => {
            const sel = ui.selected.includes(d.id); const src = ui.pduSrc === d.id;
            return (
              <g key={d.id} transform={`translate(${d.x} ${d.y})`} className="dev" onPointerDown={e => onDevDown(e, d)}
                onPointerEnter={e => { clearTimeout(tipTimer.current); const p = rel(e.clientX, e.clientY); tipTimer.current = window.setTimeout(() => setTip({ id: d.id, x: p.x, y: p.y }), 450); }} onPointerLeave={() => { clearTimeout(tipTimer.current); setTip(null); }}>
                <rect x="-32" y="-34" width="64" height="88" fill="transparent" />
                {(sel || src) && <rect x="-34" y="-34" width="68" height="84" rx="4" fill={src ? 'rgba(255,193,7,.18)' : 'rgba(30,120,255,.10)'} stroke={src ? '#ffa000' : '#2a7de1'} strokeDasharray="4 3" />}
                <g transform="translate(-28 -30)" opacity={d.power ? 1 : 0.45}><DevIcon kind={d.kind} /></g>
                {!d.power && <text y="-36" textAnchor="middle" className="offlbl">OFF</text>}
                {prefs.devLabels && <text y="40" textAnchor="middle" className="devname">{d.name}</text>}
                {prefs.devLabels && <text y="52" textAnchor="middle" className="devmodel">{modelOf(d.model).label}</text>}
              </g>
            );
          })}
          {net.notes.map(n => (
            <foreignObject key={n.id} x={n.x} y={n.y} width="170" height="84">
              <div className="note"><div className="note-h" onPointerDown={e => { e.stopPropagation(); if (ui.tool === 'delete') { net.notes = net.notes.filter(x => x.id !== n.id); net.touch(); commit(); return; } const w = world(e.clientX, e.clientY); drag.current = { kind: 'note', id: n.id, sx: w.x, sy: w.y, ox: n.x, oy: n.y }; svgRef.current!.setPointerCapture(e.pointerId); }}>Note</div>
                <textarea value={n.text} onPointerDown={e => e.stopPropagation()} onChange={e => { n.text = e.target.value; net.touch(); }} onBlur={() => commit()} placeholder="Type here…" /></div>
            </foreignObject>
          ))}
          {sim.last.map(ev => { const at = devAt(ev.at); const fr = ev.from ? devAt(ev.from) : undefined; if (!at) return null; return <Envelope key={`${sim.stamp}-${ev.n}`} x0={(fr ?? at).x} y0={(fr ?? at).y} x1={at.x} y1={at.y} drop={ev.status === 'drop'} />; })}
          {rubber && <rect x={Math.min(rubber.x0, rubber.x1)} y={Math.min(rubber.y0, rubber.y1)} width={Math.abs(rubber.x1 - rubber.x0)} height={Math.abs(rubber.y1 - rubber.y0)} fill="rgba(42,125,225,.12)" stroke="#2a7de1" strokeDasharray="3 3" />}
        </g>
      </svg>
      {!net.devices.length && <div className="ws-empty">Pick a device in the panel below, then click here to place it.<br /><small>File ▸ Open Samples has ready-made labs.</small></div>}
      {tipDev && tip && !drag.current && <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 14 }}><DevTip d={tipDev} /></div>}
      {ui.portMenu && menuDev && (
        <div className="portmenu" style={{ left: ui.portMenu.x, top: ui.portMenu.y }} onPointerDown={e => e.stopPropagation()}>
          <div className="pm-h">{menuDev.name}</div>
          {menuDev.ports.map(p => { const used = !!net.cableAt(menuDev.id, p.name); return <button key={p.name} disabled={used} onClick={() => pickPort(menuDev.id, p.name)}>{p.name}{used ? ' (in use)' : ''}</button>; })}
        </div>
      )}
      {inspect && devAt(inspect.devId) && (
        <div className="portmenu" style={{ left: inspect.x, top: inspect.y }} onPointerDown={e => e.stopPropagation()}>
          <div className="pm-h">Inspect {devAt(inspect.devId)!.name}</div>
          {inspectItems(devAt(inspect.devId)!).map(([k, l]) => <button key={k} onClick={() => { openWin('inspect', `${devAt(inspect.devId)!.name} — ${l}`, { id: `inspect:${inspect.devId}:${k}`, devId: inspect.devId, data: { table: k } }); setInspect(null); }}>{l}</button>)}
        </div>
      )}
    </div>
  );
}
function inspectItems(d: Dev): [string, string][] {
  const out: [string, string][] = [['ports', 'Port Status Summary Table'], ['arp', 'ARP Table']];
  if (d.kind === 'router' || d.kind === 'l3switch') out.push(['routing', 'Routing Table'], ['nat', 'NAT Table']); if (d.kind === 'switch' || d.kind === 'l3switch') out.push(['mac', 'MAC Table']); return out;
}
function Envelope({ x0, y0, x1, y1, drop }: { x0: number; y0: number; x1: number; y1: number; drop: boolean }) {
  const [go, setGo] = useState(false);
  useEffect(() => { const t = requestAnimationFrame(() => setGo(true)); return () => cancelAnimationFrame(t); }, []);
  const p = go ? { x: x1, y: y1 } : { x: x0, y: y0 };
  return (
    <g style={{ transform: `translate(${p.x}px, ${p.y}px)`, transition: `transform ${ui.prefs.animMs}ms linear` }} pointerEvents="none">
      <rect x="-11" y="-8" width="22" height="16" rx="1.5" fill={drop ? '#ffcdd2' : '#fff59d'} stroke="#444" /><path d="M-11 -8 L0 1 L11 -8" fill="none" stroke="#444" />
      {drop && <path d="M-7 -6 L7 6 M7 -6 L-7 6" stroke="#d32f2f" strokeWidth="3" />}
    </g>
  );
}
function DevTip({ d }: { d: Dev }) {
  const ports = d.ports.filter(p => p.kind !== 'Console' && p.kind !== 'RS232');
  return (
    <div>
      <div><b>Device Name:</b> {d.name}</div><div><b>Device Model:</b> {d.model}</div><div><b>Hostname:</b> {d.cfg.hostname}</div>
      <table><thead><tr><th>Port</th><th>Link</th><th>VLAN</th><th>IP Address</th><th>MAC Address</th></tr></thead><tbody>
        {ports.slice(0, 12).map(p => { const ph = net.portPhy(d, p.name); const c = net.cfgIf(d, p.name); const ip = c?.ip ? `${c.ip}` : '<not set>'; return <tr key={p.name}><td>{p.name}</td><td>{ph.conn ? (ph.up && ph.proto ? 'Up' : 'Down') : 'Down'}</td><td>{d.kind === 'switch' || d.kind === 'l3switch' ? (c?.swMode === 'trunk' ? 'trunk' : c?.accessVlan) : '--'}</td><td>{ip}</td><td>{p.mac}</td></tr>; })}
      </tbody></table>
      {ports.length > 12 && <div>… {ports.length - 12} more ports</div>}
      <div><b>Physical Location:</b> Intercity &gt; Home City &gt; Corporate Office &gt; Main Wiring Closet</div>
    </div>
  );
}
export function PhysicalView() {
  useRev();
  return (
    <div className="phys">
      <div className="phys-nav"><b>Intercity</b> › <b>Home City</b> › <b>Corporate Office</b> › <b>Main Wiring Closet</b></div>
      <svg viewBox="0 0 800 300" className="phys-map"><rect width="800" height="300" fill="#cfe8c4" /><rect x="0" y="130" width="800" height="36" fill="#9aa3ad" /><rect x="360" y="0" width="36" height="300" fill="#9aa3ad" />
        {[[40, 30], [150, 30], [250, 40], [470, 30], [600, 50], [60, 190], [200, 200], [500, 190], [650, 200]].map(([x, y], i) => <rect key={i} x={x} y={y} width="70" height="70" fill={i === 4 ? '#6c8ebf' : '#d8c9a8'} stroke="#555" />)}
        <text x="600" y="90" fontSize="11" fill="#fff" textAnchor="start">Corporate Office</text></svg>
      <div className="phys-rack"><b>Main Wiring Closet — {net.devices.length} device(s)</b>
        <div className="rack">{net.devices.map(d => <div key={d.id} className="rack-u"><DevIcon kind={d.kind} size={26} /> <span>{d.name}</span><small>{d.model}</small></div>)}{!net.devices.length && <i>No devices yet. Add devices in the Logical view.</i>}</div></div>
    </div>
  );
}

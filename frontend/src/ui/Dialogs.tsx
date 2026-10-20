import { useEffect, useState } from 'react';
import type { Dev } from '../model/types.ts';
import { isIp, subnetInfo } from '../lib/ip.ts';
import { routingInfo } from '../sim/routing.ts';
import { frameType, type Frame, type TEv } from '../sim/engine.ts';
import { showIpRoute, showArp, showMac, showNat } from '../ios/show.ts';
import { api, postQuery, LABS } from '../lib/api.ts';
import { net, ui, uiTouch, useRev, sim, savePrefs, addPdu, closeWin, commit, loadTopology, toast, primaryIp, type WinState } from './store.ts';
import { Win } from './Windows.tsx';

// ---------- PDU information ----------
function neighbours(ev: TEv): TEv | undefined { return sim.events.find(e => e.from === ev.at && e.pdu === ev.pdu && e.n > (ev as any).n && e.status === 'ok'); }
export function layersFor(ev: TEv, d: Dev): { inn: string[][]; out: string[][]; notes: string[] } {
  const f = ev.frame; const nx = neighbours(ev); const mk = (fr: Frame, port?: string): string[][] => {
    const L: string[][] = [[], [], [], [], [], [], []]; L[0] = [`Port(s): ${port ?? '-'}`];
    L[1] = [`Ethernet II Header`, `${fr.src} >> ${fr.dst}`].concat(fr.vlan ? [`802.1Q Header VLAN ${fr.vlan}`] : []);
    if (fr.kind === 'arp') L[2] = [`ARP Packet`, `Src. IP: ${fr.arp!.spa}, Dest. IP: ${fr.arp!.tpa}`];
    else { const p = fr.ip!; L[2] = [`IP Header`, `Src. IP: ${p.src}, Dest. IP: ${p.dst}`, p.proto === 'icmp' ? `ICMP Message Type: ${p.icmp!.type}` : `${p.proto.toUpperCase()} Src. Port: ${p.l4!.sport}, Dest. Port: ${p.l4!.dport}`]; if (p.l4) L[3] = [`${p.proto.toUpperCase()} Src. Port: ${p.l4.sport}`, `Dest. Port: ${p.l4.dport}${p.l4.flags ? ', Flags: ' + p.l4.flags : ''}`]; if (p.l4?.data?.app) L[6] = [`${p.l4.data.app} ${p.l4.data.k ?? ''}`]; }
    return L;
  };
  const depth = d.kind === 'hub' ? 1 : d.kind === 'switch' ? 2 : d.kind === 'router' || d.kind === 'l3switch' ? 3 : 7;
  const trim = (L: string[][]) => L.map((x, i) => (i < depth ? x : []));
  const inn = ev.from ? trim(mk(f, ev.atPort)) : [[], [], [], [], [], [], []]; const out = nx ? trim(mk(nx.frame, nx.fromPort)) : ev.from ? [[], [], [], [], [], [], []] : trim(mk(f, undefined));
  const notes: string[] = [];
  if (d.kind === 'hub') notes.push('The hub receives the signal and repeats it out of every other port.');
  else if (d.kind === 'switch' || d.kind === 'l3switch') notes.push('The switch learns the source MAC address in its table, then forwards the frame to the learned port or floods it within the VLAN.');
  else if (d.kind === 'router') notes.push('The router strips the Layer 2 header, looks up the destination in its routing table, decrements the TTL and re-frames the packet for the next hop.');
  else notes.push(ev.status === 'drop' ? 'The device discarded the frame (see the Info text in the event list).' : ev.from ? `The ${frameType(f)} PDU is processed by the host's protocol stack.` : `The host creates a new ${frameType(f)} PDU.`);
  if (ev.status === 'drop') notes.push(ev.info.split(' — ')[1] ?? 'The PDU was dropped.');
  return { inn, out, notes };
}
export function fieldsOf(fr: Frame): { title: string; rows: [string, string][] }[] {
  const S: { title: string; rows: [string, string][] }[] = [{ title: 'Ethernet II', rows: [['PREAMBLE', '101010…1011'], ['DEST MAC', fr.dst || '(resolving)'], ['SRC MAC', fr.src], ['TYPE', fr.kind === 'arp' ? '0x0806' : '0x0800'], ['FCS', '0x00000000']] }];
  if (fr.vlan) S.push({ title: '802.1Q', rows: [['VLAN ID', String(fr.vlan)]] });
  if (fr.kind === 'arp') { const a = fr.arp!; S.push({ title: 'ARP', rows: [['OPERATION', a.op === 1 ? 'request (1)' : 'reply (2)'], ['SENDER MAC', a.sha], ['SENDER IP', a.spa], ['TARGET MAC', a.tha], ['TARGET IP', a.tpa]] }); return S; }
  const p = fr.ip!; S.push({ title: 'IP', rows: [['VER', '4'], ['TTL', String(p.ttl)], ['PROT', p.proto === 'icmp' ? '0x1' : p.proto === 'tcp' ? '0x6' : '0x11'], ['SRC IP', p.src], ['DST IP', p.dst], ['ID', String(p.id)]] });
  if (p.icmp) S.push({ title: 'ICMP', rows: [['TYPE', String(p.icmp.type)], ['CODE', String(p.icmp.code)], ['ID', String(p.icmp.id)], ['SEQ', String(p.icmp.seq)]] });
  if (p.l4) S.push({ title: p.proto.toUpperCase(), rows: [['SRC PORT', String(p.l4.sport)], ['DST PORT', String(p.l4.dport)], ...(p.l4.flags ? [['FLAGS', p.l4.flags] as [string, string]] : [])] });
  return S;
}
export function PduInfoWin({ w }: { w: WinState }) {
  useRev(); const ev = sim.events[w.data.n]; const d = ev ? net.dev(ev.at) : undefined; const [tab, setTab] = useState('osi');
  if (!ev || !d) return <Win w={w} width={300}><div className="pad">Event no longer available.</div></Win>;
  const { inn, out, notes } = layersFor(ev, d); const nx = neighbours(ev);
  const col = (L: string[][], title: string) => <div className="osi-col"><b>{title}</b>{[7, 6, 5, 4, 3, 2, 1].map(n => <div key={n} className={`osi-l ${L[n - 1].length ? 'act' : ''}`}><span>Layer {n}</span>{L[n - 1].map((t, i) => <div key={i}>{t}</div>)}</div>)}</div>;
  const det = (fr: Frame | undefined) => fr ? fieldsOf(fr).map(s => <table className="grid" key={s.title}><thead><tr><th colSpan={2}>{s.title}</th></tr></thead><tbody>{s.rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table>) : <div className="muted pad">No outbound PDU: the device consumed or dropped this PDU.</div>;
  return (
    <Win w={w} width={620}>
      <div className="tabs">{[['osi', 'OSI Model'], ['in', 'Inbound PDU Details'], ['out', 'Outbound PDU Details']].map(([id, l]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
      <div className="tab-body">
        {tab === 'osi' && <div><div className="osi">{col(inn, 'In Layers')}{col(out, 'Out Layers')}</div><ol className="osi-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ol></div>}
        {tab === 'in' && <div className="pdu-det">{ev.from ? det(ev.frame) : <div className="muted pad">This device created the PDU.</div>}</div>}
        {tab === 'out' && <div className="pdu-det">{det(nx?.frame ?? (ev.from ? undefined : ev.frame))}</div>}
      </div>
    </Win>
  );
}

// ---------- Inspect ----------
export function InspectWin({ w }: { w: WinState }) {
  useRev(); const d = net.dev(w.devId ?? ''); if (!d) return <Win w={w} width={300}><div className="pad">Device deleted.</div></Win>;
  const t = w.data.table as string; let body = '';
  if (t === 'arp') body = showArp(d); else if (t === 'routing') body = showIpRoute(d, net); else if (t === 'mac') body = showMac(d); else if (t === 'nat') body = showNat(d);
  else body = ['Port                 Link   IP Address        MAC Address', ...d.ports.filter(p => p.kind !== 'Console' && p.kind !== 'RS232').map(p => `${p.name.padEnd(21)}${(net.portPhy(d, p.name).up ? 'Up' : 'Down').padEnd(7)}${(net.cfgIf(d, p.name)?.ip ?? '<not set>').padEnd(18)}${p.mac}`)].join('\n');
  void routingInfo;
  return <Win w={w} width={640}><pre className="inspect">{body}</pre></Win>;
}

// ---------- Complex PDU ----------
export function ComplexPduWin({ w }: { w: WinState }) {
  const src = net.dev(w.data.src); const edit = w.data.edit ? ui.pdus.find(p => p.id === w.data.edit) : undefined;
  const [app, setApp] = useState(edit?.type ?? 'ICMP'); const [dst, setDst] = useState(edit?.dstIp ?? ''); const [ttl, setTtl] = useState(String(edit?.ttl || 255)); const [size, setSize] = useState(String(edit?.size ?? 32)); const [port, setPort] = useState(String(edit?.port ?? 5000));
  if (!src) return <Win w={w} width={300}><div className="pad">Device deleted.</div></Win>;
  const go = () => {
    if (!isIp(dst)) { toast('Enter a valid destination IPv4 address.'); return; }
    const o = { dstIp: dst, type: app, ttl: Number(ttl) || 255, size: Math.max(1, Number(size) || 32), port: Number(port) || 5000 };
    const target = net.devices.find(x => primaryIp(x) === dst);
    if (edit) { Object.assign(edit, o); uiTouch(); } else addPdu(src.id, target?.id ?? src.id, o); closeWin(w.id);
  };
  return (
    <Win w={w} width={360}>
      <div className="pad"><div className="row"><b>Source Device:</b> {src.name}</div>
        <label className="fld"><span>Application</span><select value={app} onChange={e => setApp(e.target.value)}><option value="ICMP">PING</option><option value="UDP">UDP</option><option value="HTTP">HTTP</option></select></label>
        <label className="fld"><span>Destination IP</span><input value={dst} onChange={e => setDst(e.target.value)} placeholder="192.168.1.20" /></label>
        <label className="fld"><span>TTL</span><input value={ttl} onChange={e => setTtl(e.target.value)} /></label><label className="fld"><span>Size (bytes)</span><input value={size} onChange={e => setSize(e.target.value)} /></label>
        {app === 'UDP' && <label className="fld"><span>Destination port</span><input value={port} onChange={e => setPort(e.target.value)} /></label>}
        <button onClick={go}>{edit ? 'Update PDU' : 'Create PDU'}</button></div>
    </Win>
  );
}

// ---------- filters / preferences / help ----------
export function FiltersWin({ w }: { w: WinState }) {
  useRev();
  return <Win w={w} width={260}><div className="pad"><div className="row"><button onClick={() => { for (const k of Object.keys(sim.filters)) sim.filters[k] = true; uiTouch(); }}>Show All</button><button onClick={() => { for (const k of Object.keys(sim.filters)) sim.filters[k] = false; uiTouch(); }}>Show None</button></div>
    {Object.keys(sim.filters).map(k => <label key={k} className="chk"><input type="checkbox" checked={sim.filters[k]} onChange={e => { sim.filters[k] = e.target.checked; uiTouch(); }} />{k}</label>)}</div></Win>;
}
export function PrefsWin({ w }: { w: WinState }) {
  useRev(); const p = ui.prefs; const row = (k: 'devLabels' | 'portLabels' | 'linkLights' | 'grid', l: string) => <label className="chk"><input type="checkbox" checked={p[k]} onChange={e => { p[k] = e.target.checked; savePrefs(); }} />{l}</label>;
  return <Win w={w} width={320}><div className="pad"><h4>Interface</h4>{row('devLabels', 'Show Device Labels')}{row('portLabels', 'Show Port Labels')}{row('linkLights', 'Show Link Lights')}{row('grid', 'Show Workspace Grid')}
    <label className="fld"><span>Animation speed</span><input type="range" min={150} max={1500} step={50} value={1650 - p.animMs} onChange={e => { p.animMs = 1650 - Number(e.target.value); savePrefs(); }} /></label>
    <button onClick={() => { try { localStorage.removeItem('cisconetx.autosave'); } catch { /* ignore */ } toast('Autosave cleared.'); }}>Clear autosave</button></div></Win>;
}
export function HelpWin({ w }: { w: WinState }) {
  return (
    <Win w={w} width={520}><div className="pad help">
      <h3>CiscoNetX — Packet Tracer Edition</h3>
      <p>A browser-based network simulator. Build a topology, configure devices through the GUI or the IOS-style CLI, and watch packets move in Simulation mode.</p>
      <h4>Quick start</h4><ol><li>Pick <b>End Devices</b> or <b>Network Devices</b> in the bottom-left panel and click a model, then click the workspace.</li><li>Choose <b>Connections</b>, pick a cable, click a device, choose a port, then click the other device.</li><li>Double-click a device to configure it (Config, CLI, Desktop).</li><li>Use the envelope tool (right toolbar) or the PC <b>Command Prompt</b> to send pings.</li><li>Switch to <b>Simulation</b> and press <b>Capture / Forward</b> to step through events.</li></ol>
      <h4>Shortcuts</h4><table className="grid"><tbody>{[['Esc', 'Select tool'], ['N', 'Place note'], ['Del', 'Delete selection / delete tool'], ['I', 'Inspect tool'], ['P', 'Add simple PDU'], ['C', 'Add complex PDU'], ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'], ['Ctrl+S / Ctrl+O', 'Save / Open'], ['Ctrl+wheel', 'Zoom'], ['Right-click', 'Cancel current tool'], ['Tab / ?', 'IOS completion / help']].map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
      <p className="muted">Links start amber (spanning-tree learning) and turn green after a few seconds — use <i>Fast Forward Time</i> to skip the wait. The first ping of a new path usually times out while ARP resolves, just like Packet Tracer.</p>
    </div></Win>
  );
}
export function AboutWin({ w }: { w: WinState }) {
  return <Win w={w} width={380}><div className="pad"><h3>CiscoNetX 5.0</h3><p>Packet Tracer-style network simulator for Computer Networks coursework.</p><p>Includes: devices, cabling rules, link lights, STP, VLANs/trunks, ARP, ICMP, DHCP, DNS, HTTP, static/RIP/OSPF/EIGRP routing, ACLs, NAT, Realtime and Simulation modes, an IOS-style CLI and a FastAPI lab backend.</p><p className="muted">Educational simulator — not affiliated with or endorsed by Cisco Systems.</p></div></Win>;
}
export function SubnetWin({ w }: { w: WinState }) {
  const [ip, setIp] = useState('192.168.10.77'); const [pre, setPre] = useState('26'); const r = subnetInfo(ip, Number(pre));
  return <Win w={w} width={380}><div className="pad"><label className="fld"><span>IP address</span><input value={ip} onChange={e => setIp(e.target.value)} /></label><label className="fld"><span>Prefix length</span><input value={pre} onChange={e => setPre(e.target.value)} /></label>
    {r ? <table className="grid"><tbody>{([['Network', r.network], ['Subnet mask', r.mask], ['Wildcard', r.wildcard], ['Broadcast', r.broadcast], ['First host', r.first], ['Last host', r.last], ['Usable hosts', String(r.hosts)], ['Class', r.cls], ['Private', r.isPrivate ? 'yes' : 'no']] as [string, string][]).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody></table> : <p className="bad">Enter a valid IPv4 address and prefix (0–32).</p>}</div></Win>;
}

// ---------- backend labs ----------
function Pretty({ v, depth = 0 }: { v: any; depth?: number }) {
  if (v === null || v === undefined) return <i>null</i>; if (typeof v !== 'object') return <span>{String(v)}</span>;
  if (Array.isArray(v)) return v.length > 12 && typeof v[0] !== 'object' ? <span>[{v.slice(0, 40).join(', ')}{v.length > 40 ? ', …' : ''}]</span> : <ol className="pj">{v.slice(0, 40).map((x, i) => <li key={i}><Pretty v={x} depth={depth + 1} /></li>)}</ol>;
  return <table className="grid pj"><tbody>{Object.entries(v).map(([k, x]) => <tr key={k}><td>{k}</td><td><Pretty v={x} depth={depth + 1} /></td></tr>)}</tbody></table>;
}
export function LabsWin({ w }: { w: WinState }) {
  const [id, setId] = useState(LABS[0].id); const lab = LABS.find(l => l.id === id)!; const [vals, setVals] = useState<Record<string, string>>({}); const [res, setRes] = useState<any>(null); const [err, setErr] = useState(''); const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => { void api('/health').then(r => setOnline(r.ok)); }, []);
  useEffect(() => { setVals(Object.fromEntries(lab.fields.map(f => [f.key, f.value]))); setRes(null); setErr(''); }, [id]);
  const run = async () => { setErr(''); const r = await postQuery(lab.path, lab.params(vals)); if (r.ok) setRes(r.data); else { setRes(null); setErr(r.error ?? 'Failed'); } };
  return (
    <Win w={w} width={680}><div className="labs"><div className="labs-nav"><div className={`beon ${online ? 'on' : ''}`}>Backend: {online === null ? '…' : online ? 'online' : 'offline'}</div>{LABS.map(l => <button key={l.id} className={id === l.id ? 'on' : ''} onClick={() => setId(l.id)}>{l.title}<small>{l.group}</small></button>)}</div>
      <div className="labs-main"><h4>{lab.title}</h4>{lab.fields.map(f => <label key={f.key} className="fld"><span>{f.label}</span><input value={vals[f.key] ?? ''} onChange={e => setVals({ ...vals, [f.key]: e.target.value })} /></label>)}<button onClick={() => void run()}>Run on backend</button>
        {err && <div className="bad pad">{err}</div>}{res && <div className="res"><Pretty v={res} /></div>}</div></div></Win>
  );
}
const TYPE_MODEL: Record<string, string> = { router: '1941', switch: '2960-24TT', host: 'PC-PT', server: 'Server-PT', firewall: '1941', wireless: '2960-24TT' };
export function buildFromTopology(top: any): number {
  if (!top?.nodes?.length) return 0; net.clear(); const ids = new Map<string, Dev>(); const n = top.nodes.length; const cx = 380, cy = 230, R = Math.min(220, 60 + n * 22);
  top.nodes.forEach((node: any, i: number) => { const a = (i / n) * Math.PI * 2 - Math.PI / 2; const d = net.addDevice(TYPE_MODEL[node.type] ?? 'PC-PT', Math.round(cx + R * Math.cos(a) * 1.3), Math.round(cy + R * Math.sin(a))); if (node.name) d.name = String(node.name).slice(0, 24); ids.set(node.id, d); if ((node.type === 'host' || node.type === 'server') && isIp(node.ip)) { const c = d.cfg.ifs[0]; c.ip = node.ip; c.mask = '255.255.255.0'; } });
  for (const l of top.links ?? []) { const a = ids.get(l.source), b = ids.get(l.target); if (!a || !b) continue; const pa = a.ports.find(p => p.kind !== 'Console' && p.kind !== 'RS232' && !net.cableAt(a.id, p.name)), pb = b.ports.find(p => p.kind !== 'Console' && p.kind !== 'RS232' && !net.cableAt(b.id, p.name)); if (pa && pb) net.connect('auto', { dev: a.id, port: pa.name }, { dev: b.id, port: pb.name }); }
  for (const d of net.devices) if (d.kind === 'router') for (const c of d.cfg.ifs) c.adminUp = true; net.settle(); return net.devices.length;
}
export function CoachWin({ w }: { w: WinState }) {
  const [q, setQ] = useState('Explain OSPF and let me test a three-router topology'); const [res, setRes] = useState<any>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const ask = async () => { setBusy(true); setErr(''); const r = await api('/api/v1/enterprise/assistant/tutor', { question: q }); setBusy(false); if (r.ok) setRes(r.data); else { setRes(null); setErr(r.error ?? 'Failed'); } };
  const L = (title: string, items?: string[]) => items?.length ? <div><h4>{title}</h4><ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul></div> : null;
  return (
    <Win w={w} width={620}><div className="pad"><label className="fld col"><span>Ask the AI Lab Coach</span><textarea rows={3} value={q} onChange={e => setQ(e.target.value)} /></label><button disabled={busy} onClick={() => void ask()}>{busy ? 'Thinking…' : 'Ask'}</button>
      {err && <div className="bad pad">{err}</div>}
      {res && <div className="coach"><h3>{res.lab_name}</h3><p>{res.objective}</p>{L('Steps', res.steps)}{L('Commands', res.commands)}{L('Expected results', res.expected_results)}{L('Viva questions', res.viva_questions)}
        {res.topology?.nodes?.length > 0 && <button onClick={() => { const c = buildFromTopology(res.topology); loadTopology(net.toJSON()); toast(`Built ${c} devices in the workspace.`); commit(); }}>Build this topology in the workspace</button>}</div>}</div></Win>
  );
}

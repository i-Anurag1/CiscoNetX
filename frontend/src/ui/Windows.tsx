import { useEffect, useRef, useState } from 'react';
import type { Dev } from '../model/types.ts';
import { SERIAL_MODULE, isHost, isSwitch, modelOf } from '../model/catalog.ts';
import { dhcpAcquire, httpGet } from '../sim/engine.ts';
import { isIp, maskToLen } from '../lib/ip.ts';
import { net, ui, uiTouch, useRev, closeWin, focusWin, runGui, playTrace, commit, toast, type WinState } from './store.ts';
import { CliTerminal } from './Terminal.tsx';
import { DevIcon } from './icons.tsx';
import { isRouting } from '../sim/routing.ts';

export function Win({ w, children, width = 640, height }: { w: WinState; children: any; width?: number; height?: number }) {
  const start = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const down = (e: any) => {
    if (e.target.closest('button')) return; focusWin(w.id); start.current = { x: e.clientX, y: e.clientY, ox: w.x, oy: w.y };
    const move = (ev: PointerEvent) => { if (!start.current) return; w.x = Math.max(0, start.current.ox + ev.clientX - start.current.x); w.y = Math.max(0, start.current.oy + ev.clientY - start.current.y); uiTouch(); };
    const up = () => { start.current = null; window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return (
    <div className="win" style={{ left: w.x, top: w.y, width, height, zIndex: w.z }} onPointerDown={() => focusWin(w.id)}>
      <div className="win-title" onPointerDown={down}><span>{w.title}</span><button className="win-x" onClick={() => closeWin(w.id)} aria-label="Close">✕</button></div>
      <div className="win-body">{children}</div>
    </div>
  );
}
const Field = ({ label, children }: { label: string; children: any }) => <label className="fld"><span>{label}</span>{children}</label>;

// ---------------- Device window ----------------
export function DeviceWindow({ w }: { w: WinState }) {
  useRev();
  const d = net.dev(w.devId ?? ''); const [tab, setTab] = useState('config');
  useEffect(() => { if (d) { w.title = d.name; setTab(isHost(d.kind) ? 'desktop' : 'config'); } }, [d?.id]);
  if (!d) return <Win w={w} width={300}><div className="pad">Device was deleted.</div></Win>;
  const tabs: [string, string][] = [['physical', 'Physical'], ['config', 'Config']];
  if (isHost(d.kind)) tabs.push(['desktop', 'Desktop']); else if (d.kind !== 'hub') tabs.push(['cli', 'CLI']);
  if (d.kind === 'server') tabs.push(['services', 'Services']); tabs.push(['attr', 'Attributes']);
  w.title = d.name; const cur = tabs.some(t => t[0] === tab) ? tab : 'config';
  return (
    <Win w={w} width={720}>
      <div className="tabs">{tabs.map(([id, l]) => <button key={id} className={cur === id ? 'on' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
      <div className="tab-body">
        {cur === 'physical' && <PhysicalTab d={d} />}{cur === 'config' && <ConfigTab d={d} />}
        {cur === 'cli' && <CliTab d={d} />}{cur === 'desktop' && <DesktopTab d={d} />}{cur === 'services' && <ServicesTab d={d} />}{cur === 'attr' && <AttrTab d={d} />}
      </div>
    </Win>
  );
}
function PhysicalTab({ d }: { d: Dev }) {
  const m = modelOf(d.model); const ports = d.ports;
  return (
    <div className="phys-tab">
      <div className="phys-row">
        <div className="chassis"><DevIcon kind={d.kind} size={120} /></div>
        <div>
          <div className="power"><b>Physical Device View</b> — {m.desc}</div>
          <button className={`pwr ${d.power ? 'on' : ''}`} onClick={() => { net.setPower(d, !d.power); commit(); }}>{d.power ? '● Power ON — click to switch off' : '○ Power OFF — click to switch on'}</button>
          {d.kind === 'router' && (
            <div className="modules"><b>Module slots</b> <small>(power the device off to change)</small>
              {d.modules.map((mod, i) => <div key={i}>Slot {i}: <select disabled={d.power} value={mod ?? ''} onChange={e => { const err = net.setModule(d, i, e.target.value || null); if (err) toast(err); else commit(); }}><option value="">(empty)</option><option value={SERIAL_MODULE}>{SERIAL_MODULE} — 2 serial ports</option></select></div>)}
            </div>
          )}
        </div>
      </div>
      <table className="grid"><thead><tr><th>Port</th><th>Status</th><th>Connected to</th><th>MAC address</th></tr></thead>
        <tbody>{ports.map(p => { const ph = net.portPhy(d, p.name); const pe = net.peerOf(d.id, p.name); return <tr key={p.name}><td>{p.name}</td><td><span className={`led ${ph.color}`} /> {ph.conn ? (ph.color === 'green' ? 'Up' : ph.color === 'amber' ? 'Blocking/Learning' : 'Down') : '—'}</td><td>{pe ? `${pe.dev.name} ${pe.port}` : ''}</td><td>{p.mac}</td></tr>; })}</tbody></table>
    </div>
  );
}
function CliTab({ d }: { d: Dev }) { return <div className="cli-tab"><div className="term-title">IOS Command Line Interface</div><CliTerminal dev={d} kind="ios" /></div>; }
function AttrTab({ d }: { d: Dev }) {
  return <table className="grid attr"><tbody><tr><th>Display name</th><td>{d.name}</td></tr><tr><th>Model</th><td>{modelOf(d.model).desc}</td></tr><tr><th>Hostname</th><td>{d.cfg.hostname}</td></tr><tr><th>Power</th><td>{d.power ? 'On' : 'Off'}</td></tr><tr><th>Interfaces</th><td>{d.ports.length}</td></tr><tr><th>Startup-config</th><td>{d.startup ? 'Saved' : 'Not saved'}</td></tr><tr><th>Base MAC</th><td>{d.ports[0]?.mac}</td></tr></tbody></table>;
}

// ---------------- Config tab ----------------
function ConfigTab({ d }: { d: Dev }) {
  const [sel, setSel] = useState('settings'); const [name, setName] = useState(d.name); const [host, setHost] = useState(d.cfg.hostname);
  const log = ui.guiLog[d.id] ?? []; const host_ = isHost(d.kind); const rtr = isRouting(d) || d.kind === 'router'; const sw = isSwitch(d.kind);
  const eth = d.ports.filter(p => p.kind !== 'Console' && p.kind !== 'RS232');
  const items: [string, string][] = [['settings', 'Settings']];
  if (rtr && !host_) items.push(['static', 'Static'], ['rip', 'RIP']); if (sw) items.push(['vlan', 'VLAN Database']);
  const nav = (title: string, list: [string, string][]) => <><div className="nav-h">{title}</div>{list.map(([id, l]) => <button key={id} className={sel === id ? 'on' : ''} onClick={() => setSel(id)}>{l}</button>)}</>;
  return (
    <div className="cfg">
      <div className="cfg-nav">{nav('GLOBAL', [items[0]])}{items.length > 1 && nav(sw ? 'SWITCHING' : 'ROUTING', items.slice(1))}{nav('INTERFACE', eth.map(p => [p.name, p.name] as [string, string]))}</div>
      <div className="cfg-main">
        {sel === 'settings' && (
          <div><h4>Global Settings</h4>
            <Field label="Display Name"><input value={name} onChange={e => setName(e.target.value)} onBlur={() => { if (name.trim() && name !== d.name) { net.rename(d, name); commit(); } }} /></Field>
            {!host_ && <Field label="Hostname"><input value={host} onChange={e => setHost(e.target.value)} onBlur={() => { if (host !== d.cfg.hostname && /^\S+$/.test(host)) runGui(d, [`hostname ${host}`]); }} /></Field>}
            {host_ && <HostGlobals d={d} />}
            {!host_ && <p className="muted">Changes made here are applied by issuing the matching IOS commands (see the pane below).</p>}
          </div>
        )}
        {sel === 'static' && <StaticRoutes d={d} />}{sel === 'rip' && <RipNets d={d} />}{sel === 'vlan' && <VlanDb d={d} />}
        {eth.some(p => p.name === sel) && (host_ ? <HostIface d={d} /> : <IfacePane d={d} name={sel} />)}
      </div>
      {!host_ && <div className="cfg-log"><div className="nav-h">Equivalent IOS Commands</div><pre>{log.join('\n')}</pre></div>}
    </div>
  );
}
function HostGlobals({ d }: { d: Dev }) {
  const [gw, setGw] = useState(d.cfg.hostGw ?? ''); const [dns, setDns] = useState(d.cfg.hostDns ?? '');
  const save = () => { d.cfg.hostGw = isIp(gw) ? gw : undefined; d.cfg.hostDns = isIp(dns) ? dns : undefined; net.touch(); };
  return <><Field label="Gateway/DNS IPv4"><span /></Field><Field label="Default Gateway"><input value={gw} onChange={e => setGw(e.target.value)} onBlur={save} /></Field><Field label="DNS Server"><input value={dns} onChange={e => setDns(e.target.value)} onBlur={save} /></Field></>;
}
function HostIface({ d }: { d: Dev }) {
  const c = d.cfg.ifs[0]; const [dhcp, setDhcp] = useState(d.cfg.hostDhcp); const [ip, setIp] = useState(c?.ip ?? ''); const [mask, setMask] = useState(c?.mask ?? '');
  const apply = () => { if (!isIp(ip) || maskToLen(mask) === null) { toast('Enter a valid IPv4 address and subnet mask.'); return; } c.ip = ip; c.mask = mask; d.cfg.hostDhcp = false; net.touch(); commit(); };
  const doDhcp = async () => { const r = dhcpAcquire(net, d); await playTrace(r.trace); if (r.result.ok) { setIp(r.result.ip ?? ''); setMask(r.result.mask ?? ''); } else toast(r.result.error ?? 'DHCP failed'); };
  return (
    <div><h4>{c?.name}</h4>
      <Field label="MAC Address"><input readOnly value={d.ports[0]?.mac} /></Field>
      <div className="radios"><label><input type="radio" checked={dhcp} onChange={() => { setDhcp(true); void doDhcp(); }} /> DHCP</label><label><input type="radio" checked={!dhcp} onChange={() => setDhcp(false)} /> Static</label></div>
      <Field label="IPv4 Address"><input disabled={dhcp} value={ip} onChange={e => setIp(e.target.value)} /></Field><Field label="Subnet Mask"><input disabled={dhcp} value={mask} onChange={e => setMask(e.target.value)} /></Field>
      {!dhcp && <button onClick={apply}>Apply</button>}
    </div>
  );
}
function IfacePane({ d, name }: { d: Dev; name: string }) {
  const c = net.cfgIf(d, name); const sw = isSwitch(d.kind) && !c?.routed; const p = d.ports.find(x => x.name === name); const ph = net.portPhy(d, name);
  const [ip, setIp] = useState(c?.ip ?? ''); const [mask, setMask] = useState(c?.mask ?? ''); useEffect(() => { setIp(c?.ip ?? ''); setMask(c?.mask ?? ''); }, [name, c?.ip, c?.mask]);
  if (!c) return null;
  return (
    <div><h4>{name}</h4>
      <Field label="Port Status"><label><input type="checkbox" checked={c.adminUp} onChange={e => runGui(d, [`interface ${name}`, e.target.checked ? 'no shutdown' : 'shutdown'])} /> On</label> <span className={`led ${ph.color}`} /></Field>
      <Field label="MAC Address"><input readOnly value={p?.mac ?? ''} /></Field>
      {sw ? (<>
        <Field label="Mode"><select value={c.swMode} onChange={e => runGui(d, [`interface ${name}`, `switchport mode ${e.target.value}`])}><option value="access">access</option><option value="trunk">trunk</option></select></Field>
        {c.swMode === 'access' && <Field label="VLAN"><select value={c.accessVlan} onChange={e => runGui(d, [`interface ${name}`, `switchport access vlan ${e.target.value}`])}>{Object.entries(d.cfg.vlans).map(([id, v]) => <option key={id} value={id}>{id} – {v.name}</option>)}</select></Field>}
      </>) : (<>
        <Field label="IP Address"><input value={ip} onChange={e => setIp(e.target.value)} /></Field><Field label="Subnet Mask"><input value={mask} onChange={e => setMask(e.target.value)} /></Field>
        <button onClick={() => { if (!ip) runGui(d, [`interface ${name}`, 'no ip address']); else runGui(d, [`interface ${name}`, `ip address ${ip} ${mask}`]); }}>Apply</button>
        {name.startsWith('Serial') && <Field label="Clock Rate"><input defaultValue={c.clockRate ?? ''} placeholder="64000 (DCE side)" onBlur={e => { if (e.target.value) runGui(d, [`interface ${name}`, `clock rate ${e.target.value}`]); }} /></Field>}
      </>)}
    </div>
  );
}
function StaticRoutes({ d }: { d: Dev }) {
  const [a, setA] = useState(''); const [m, setM] = useState(''); const [n, setN] = useState('');
  return (
    <div><h4>Static Routes</h4>
      <div className="row"><input placeholder="Network" value={a} onChange={e => setA(e.target.value)} /><input placeholder="Mask" value={m} onChange={e => setM(e.target.value)} /><input placeholder="Next Hop" value={n} onChange={e => setN(e.target.value)} />
        <button onClick={() => { if (!isIp(a) || maskToLen(m) === null || !isIp(n)) { toast('Enter a valid network, mask and next hop.'); return; } runGui(d, [`ip route ${a} ${m} ${n}`]); setA(''); setM(''); setN(''); }}>Add</button></div>
      <table className="grid"><thead><tr><th>Network Address</th><th>Mask</th><th>Next Hop</th><th /></tr></thead><tbody>{d.cfg.statics.map((r, i) => <tr key={i}><td>{r.net}</td><td>{r.mask}</td><td>{r.nh ?? r.ifn}</td><td><button onClick={() => runGui(d, [`no ip route ${r.net} ${r.mask} ${r.nh ?? r.ifn}`])}>Remove</button></td></tr>)}</tbody></table>
    </div>
  );
}
function RipNets({ d }: { d: Dev }) {
  const [a, setA] = useState('');
  return (
    <div><h4>RIP Routing</h4><div className="row"><input placeholder="Network" value={a} onChange={e => setA(e.target.value)} /><button onClick={() => { if (!isIp(a)) { toast('Enter a valid network address.'); return; } runGui(d, ['router rip', 'version 2', `network ${a}`]); setA(''); }}>Add</button></div>
      <table className="grid"><thead><tr><th>Network Address</th><th /></tr></thead><tbody>{(d.cfg.rip?.nets ?? []).map(n => <tr key={n}><td>{n}</td><td><button onClick={() => runGui(d, ['router rip', `no network ${n}`])}>Remove</button></td></tr>)}</tbody></table></div>
  );
}
function VlanDb({ d }: { d: Dev }) {
  const [id, setId] = useState(''); const [nm, setNm] = useState('');
  return (
    <div><h4>VLAN Database</h4><div className="row"><input placeholder="VLAN Number" value={id} onChange={e => setId(e.target.value)} /><input placeholder="VLAN Name" value={nm} onChange={e => setNm(e.target.value)} />
      <button onClick={() => { const v = Number(id); if (!(v >= 2 && v <= 1001)) { toast('VLAN number must be 2–1001.'); return; } runGui(d, [`vlan ${v}`, ...(nm ? [`name ${nm}`] : [])]); setId(''); setNm(''); }}>Add</button></div>
      <table className="grid"><thead><tr><th>VLAN No</th><th>VLAN Name</th><th /></tr></thead><tbody>{Object.entries(d.cfg.vlans).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.name}</td><td>{k !== '1' && <button onClick={() => runGui(d, [`no vlan ${k}`])}>Remove</button>}</td></tr>)}</tbody></table></div>
  );
}

// ---------------- Desktop (hosts) ----------------
function DesktopTab({ d }: { d: Dev }) {
  const [app, setApp] = useState('');
  const apps: [string, string, string][] = [['ip', 'IP Configuration', '🖧'], ['cmd', 'Command Prompt', '⌨'], ['web', 'Web Browser', '🌐'], ['term', 'Terminal', '🖥']];
  if (!app) return <div className="desktop">{apps.map(([id, l, i]) => <button key={id} className="dapp" onClick={() => setApp(id)}><span>{i}</span>{l}</button>)}</div>;
  return (
    <div className="appwin"><div className="app-bar"><button onClick={() => setApp('')}>← Desktop</button><b>{apps.find(a => a[0] === app)![1]}</b></div>
      {app === 'ip' && <IpConfigApp d={d} />}{app === 'cmd' && <CliTerminal dev={d} kind="host" />}{app === 'web' && <BrowserApp d={d} />}{app === 'term' && <TermApp d={d} />}</div>
  );
}
function IpConfigApp({ d }: { d: Dev }) { return <div className="pad"><HostIface d={d} /><HostGlobals d={d} /></div>; }
function TermApp({ d }: { d: Dev }) {
  const port = d.ports.find(p => p.kind === 'RS232'); const pe = port ? net.peerOf(d.id, port.name) : null;
  if (!pe || pe.cable.type !== 'console') return <div className="pad bad">Cannot open Terminal: connect a Console cable from this device's RS 232 port to a router or switch Console port.</div>;
  return <><div className="term-title">Terminal — connected to {pe.dev.name}</div><CliTerminal dev={pe.dev} kind="ios" /></>;
}
function BrowserApp({ d }: { d: Dev }) {
  const [url, setUrl] = useState('http://'); const [page, setPage] = useState<{ ok: boolean; body: string } | null>(null); const [busy, setBusy] = useState(false);
  const go = async () => { setBusy(true); const r = httpGet(net, d, url); await playTrace(r.trace); setBusy(false); setPage(r.result.ok ? { ok: true, body: r.result.body ?? '' } : { ok: false, body: r.result.error ?? 'Request failed' }); };
  return (
    <div className="browser"><div className="addr"><span>URL</span><input value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void go(); }} /><button disabled={busy} onClick={() => void go()}>Go</button></div>
      <div className="page">{page ? (page.ok ? <iframe title="page" sandbox="" srcDoc={page.body} /> : <div className="bad pad"><h3>Page cannot be displayed</h3>{page.body}</div>) : <div className="muted pad">Enter a URL such as http://192.168.1.2 or a hostname served by a DNS server.</div>}</div></div>
  );
}

// ---------------- Services (servers) ----------------
function ServicesTab({ d }: { d: Dev }) {
  const s = d.svc!; const [t, setT] = useState('http'); const [rn, setRn] = useState(''); const [ri, setRi] = useState(''); const p = s.dhcp.pools[0];
  const save = () => { net.touch(); };
  return (
    <div className="cfg"><div className="cfg-nav"><div className="nav-h">SERVICES</div>{[['http', 'HTTP'], ['dns', 'DNS'], ['dhcp', 'DHCP']].map(([id, l]) => <button key={id} className={t === id ? 'on' : ''} onClick={() => setT(id)}>{l}</button>)}</div>
      <div className="cfg-main">
        {t === 'http' && <div><h4>HTTP</h4><div className="radios"><label><input type="radio" checked={s.http.on} onChange={() => { s.http.on = true; save(); }} />On</label><label><input type="radio" checked={!s.http.on} onChange={() => { s.http.on = false; save(); }} />Off</label></div><textarea className="html-ed" value={s.http.html} onChange={e => { s.http.html = e.target.value; save(); }} /></div>}
        {t === 'dns' && <div><h4>DNS</h4><div className="radios"><label><input type="radio" checked={s.dns.on} onChange={() => { s.dns.on = true; save(); }} />On</label><label><input type="radio" checked={!s.dns.on} onChange={() => { s.dns.on = false; save(); }} />Off</label></div>
          <div className="row"><input placeholder="Name" value={rn} onChange={e => setRn(e.target.value)} /><input placeholder="Address" value={ri} onChange={e => setRi(e.target.value)} /><button onClick={() => { if (!rn || !isIp(ri)) { toast('Enter a name and a valid IPv4 address.'); return; } s.dns.records.push({ name: rn, ip: ri }); setRn(''); setRi(''); save(); }}>Add</button></div>
          <table className="grid"><thead><tr><th>Name</th><th>Type</th><th>Address</th><th /></tr></thead><tbody>{s.dns.records.map((r, i) => <tr key={i}><td>{r.name}</td><td>A Record</td><td>{r.ip}</td><td><button onClick={() => { s.dns.records.splice(i, 1); save(); }}>Remove</button></td></tr>)}</tbody></table></div>}
        {t === 'dhcp' && <div><h4>DHCP</h4><div className="radios"><label><input type="radio" checked={s.dhcp.on} onChange={() => { s.dhcp.on = true; save(); }} />On</label><label><input type="radio" checked={!s.dhcp.on} onChange={() => { s.dhcp.on = false; save(); }} />Off</label></div>
          {(['name', 'gw', 'dns', 'start', 'mask'] as const).map(k => <Field key={k} label={{ name: 'Pool Name', gw: 'Default Gateway', dns: 'DNS Server', start: 'Start IP Address', mask: 'Subnet Mask' }[k]}><input value={String(p[k])} onChange={e => { (p as any)[k] = e.target.value; save(); }} /></Field>)}
          <Field label="Maximum Users"><input value={p.max} onChange={e => { p.max = Number(e.target.value) || 0; save(); }} /></Field></div>}
      </div></div>
  );
}

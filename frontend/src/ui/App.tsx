import { useEffect, useRef, useState } from 'react';
import { Cli } from '../ios/cli.ts';
import { SAMPLES } from '../lib/samples.ts';
import { Defs, Ico } from './icons.tsx';
import { Workspace, PhysicalView } from './Workspace.tsx';
import { Palette } from './Palette.tsx';
import { CommonTools, ModeTabs, PduList, SimPanel, TimeBar } from './Panels.tsx';
import { DeviceWindow } from './Windows.tsx';
import { AgentWin, openAgent } from './Agent.tsx';
import { AboutWin, CoachWin, ComplexPduWin, FiltersWin, HelpWin, InspectWin, LabsWin, PduInfoWin, PrefsWin, SubnetWin } from './Dialogs.tsx';
import { net, ui, uiTouch, useRev, commit, undo, redo, resetAll, loadTopology, loadAutosave, openWin, toast, powerCycleAll, fastForward, savePrefs } from './store.ts';

type Item = [string, (() => void) | null, string?] | 'sep' | { label: string; sub: { label: string; fn: () => void }[] };
function download(name: string, text: string): void { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const zoom = (f: number) => { ui.zoom = Math.min(3, Math.max(0.3, ui.zoom * f)); uiTouch(); };
function copySel(): void { ui.clipboard = ui.selected.slice(); toast(ui.clipboard.length ? `${ui.clipboard.length} device(s) copied.` : 'Select devices first.'); }
function pasteSel(): void {
  const made: string[] = [];
  for (const id of ui.clipboard) { const s = net.dev(id); if (!s) continue; const d = net.addDevice(s.model, s.x + 50, s.y + 50); d.cfg = JSON.parse(JSON.stringify(s.cfg)); if (s.svc) d.svc = JSON.parse(JSON.stringify(s.svc)); for (const c of d.cfg.ifs) if (c.type === 'phys' && !c.ip) c.ip = undefined; if (d.kind === 'pc' || d.kind === 'laptop' || d.kind === 'server') { d.cfg.ifs[0].ip = undefined; d.cfg.ifs[0].mask = undefined; } made.push(d.id); }
  if (made.length) { ui.selected = made; commit(); uiTouch(); }
}
async function openSample(id: string): Promise<void> {
  const s = SAMPLES.find(x => x.id === id); if (!s) return;
  Cli.resetAll(); net.clear(); try { await s.build(net); } catch (e) { toast(`Sample failed: ${e instanceof Error ? e.message : e}`); return; }
  net.settle(); loadTopology(net.toJSON()); toast(`${s.title}: ${s.desc}`, 6000);
}
function openFile(): void {
  const i = document.createElement('input'); i.type = 'file'; i.accept = '.cnx,.json,application/json';
  i.onchange = async () => { const f = i.files?.[0]; if (!f) return; try { Cli.resetAll(); loadTopology(JSON.parse(await f.text())); toast(`Opened ${f.name}`); } catch (e) { toast(`Cannot open file: ${e instanceof Error ? e.message : 'invalid file'}`); } };
  i.click();
}
const newDoc = (): void => { if (net.devices.length && !window.confirm('Discard the current topology and start a new one?')) return; resetAll(); };
const save = (): void => { download('network.cnx', net.snapshot()); toast('Saved network.cnx'); };
function fit(): void {
  if (!net.devices.length) return; const xs = net.devices.map(d => d.x), ys = net.devices.map(d => d.y); const x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 60, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 80;
  const el = document.querySelector('.ws-svg') as SVGSVGElement | null; const W = el?.clientWidth ?? 900, H = el?.clientHeight ?? 500;
  ui.zoom = Math.min(2, Math.max(0.3, Math.min(W / (x1 - x0), H / (y1 - y0)))); ui.panX = -x0 * ui.zoom + (W - (x1 - x0) * ui.zoom) / 2; ui.panY = -y0 * ui.zoom + (H - (y1 - y0) * ui.zoom) / 2; uiTouch();
}

function Menu({ title, items }: { title: string; items: Item[] }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (!open) return; const f = () => setOpen(false); const t = setTimeout(() => window.addEventListener('click', f), 0); return () => { clearTimeout(t); window.removeEventListener('click', f); }; }, [open]);
  return (
    <div className="menu"><button className={open ? 'on' : ''} onClick={() => setOpen(!open)} onMouseEnter={e => { if (document.querySelector('.menu .drop')) { setOpen(true); void e; } }}>{title}</button>
      {open && <div className="drop">{items.map((it, i) => it === 'sep' ? <hr key={i} /> : Array.isArray(it) ? <button key={i} disabled={!it[1]} onClick={() => { it[1]?.(); setOpen(false); }}><span>{it[0]}</span><kbd>{it[2] ?? ''}</kbd></button>
        : <div key={i} className="flyout"><button><span>{it.label}</span><kbd>â–¸</kbd></button><div className="drop sub">{it.sub.map(s => <button key={s.label} onClick={() => { s.fn(); setOpen(false); }}>{s.label}</button>)}</div></div>)}</div>}
    </div>
  );
}
const TB = ({ i, t, f, on }: { i: string; t: string; f: () => void; on?: boolean }) => <button className={`tb ${on ? 'on' : ''}`} title={t} onClick={f}>{Ico[i]}</button>;

export function App() {
  useRev(); const [ready, setReady] = useState(false); const once = useRef(false);
  useEffect(() => { if (once.current) return; once.current = true; if (!loadAutosave()) net.touch(); commit(); setReady(true); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement; if (t.closest('input,textarea,select,.term,[contenteditable]')) return;
      const m = e.ctrlKey || e.metaKey; const k = e.key.toLowerCase();
      if (m && k === 'z') { e.preventDefault(); undo(); } else if (m && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); redo(); } else if (m && k === 's') { e.preventDefault(); save(); } else if (m && k === 'o') { e.preventDefault(); openFile(); } else if (m && k === 'n') { e.preventDefault(); newDoc(); } else if (m && k === 'c') copySel(); else if (m && k === 'v') pasteSel(); else if (m && k === 'a') { e.preventDefault(); ui.selected = net.devices.map(d => d.id); uiTouch(); }
      else if (!m) {
        const set = (tool: typeof ui.tool, hint = '') => { ui.tool = tool; ui.placing = null; ui.cableFrom = null; ui.pduSrc = null; ui.hint = hint; uiTouch(); };
        if (k === 'escape') set('select'); else if (k === 'n') set('note', 'Click the workspace to place a note'); else if (k === 'i') set('inspect', 'Click a device to inspect'); else if (k === 'p') set('pdu', 'Select a source device'); else if (k === 'c') set('cpdu', 'Select a source device');
        else if (k === 'delete' || k === 'backspace') { if (ui.selected.length) { for (const id of ui.selected) net.removeDevice(id); ui.selected = []; commit(); uiTouch(); } else set('delete', 'Click a device or cable to delete it'); }
        else if (k === '+' || k === '=') zoom(1.15); else if (k === '-') zoom(1 / 1.15);
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const sim = ui.mode === 'simulation';
  return (
    <div className="app">
      <Defs />
      <div className="titlebar"><span className="logo">â—†</span> CiscoNetX â€” Packet Tracer Edition <span className="ver">v5.0</span></div>
      <div className="menubar">
        <Menu title="File" items={[['New', newDoc, 'Ctrl+N'], ['Openâ€¦', openFile, 'Ctrl+O'], { label: 'Open Samples', sub: SAMPLES.map(s => ({ label: s.title, fn: () => void openSample(s.id) })) }, 'sep', ['Save', save, 'Ctrl+S'], ['Save Asâ€¦', save], 'sep', ['Printâ€¦', () => window.print(), 'Ctrl+P']]} />
        <Menu title="Edit" items={[['Undo', undo, 'Ctrl+Z'], ['Redo', redo, 'Ctrl+Y'], 'sep', ['Copy', copySel, 'Ctrl+C'], ['Paste', pasteSel, 'Ctrl+V'], ['Select All', () => { ui.selected = net.devices.map(d => d.id); uiTouch(); }, 'Ctrl+A'], ['Delete', () => { for (const id of ui.selected) net.removeDevice(id); ui.selected = []; commit(); uiTouch(); }, 'Del']]} />
        <Menu title="Options" items={[['Preferencesâ€¦', () => openWin('prefs', 'Preferences', { id: 'prefs' })], 'sep', [ui.prefs.devLabels ? 'âœ“ Show Device Labels' : 'Show Device Labels', () => { ui.prefs.devLabels = !ui.prefs.devLabels; savePrefs(); }], [ui.prefs.portLabels ? 'âœ“ Show Port Labels' : 'Show Port Labels', () => { ui.prefs.portLabels = !ui.prefs.portLabels; savePrefs(); }], [ui.prefs.linkLights ? 'âœ“ Show Link Lights' : 'Show Link Lights', () => { ui.prefs.linkLights = !ui.prefs.linkLights; savePrefs(); }]]} />
        <Menu title="View" items={[['Zoom In', () => zoom(1.15), '+'], ['Zoom Out', () => zoom(1 / 1.15), '-'], ['Reset Zoom', () => { ui.zoom = 1; uiTouch(); }], ['Zoom to Fit', fit], 'sep', [ui.prefs.grid ? 'âœ“ Workspace Grid' : 'Workspace Grid', () => { ui.prefs.grid = !ui.prefs.grid; savePrefs(); }], ['Logical Workspace', () => { ui.view = 'logical'; uiTouch(); }], ['Physical Workspace', () => { ui.view = 'physical'; uiTouch(); }]]} />
        <Menu title="Tools" items={[['Subnet Calculator', () => openWin('subnet', 'Subnet Calculator', { id: 'subnet' })], ['Power Cycle Devices', powerCycleAll], ['Fast Forward Time', fastForward]]} />
        <Menu title="AI Agent" items={[["Solve a lab question…", () => openAgent("solve")], ["Network Doctor…", () => openAgent("doctor")], ["Break it (fault injector)…", () => openAgent("doctor")]]} />
        <Menu title="Extensions" items={[['CiscoNetX Labs (backend)â€¦', () => openWin('labs', 'CiscoNetX Labs', { id: 'labs' })], ['AI Lab Coachâ€¦', () => openWin('coach', 'AI Lab Coach', { id: 'coach' })]]} />
        <Menu title="Help" items={[['Quick Start & Shortcuts', () => openWin('help', 'Help', { id: 'help' })], ['About CiscoNetX', () => openWin('about', 'About', { id: 'about' })]]} />
      </div>
      <div className="toolbar">
        <TB i="new" t="New (Ctrl+N)" f={newDoc} /><TB i="open" t="Open (Ctrl+O)" f={openFile} /><TB i="save" t="Save (Ctrl+S)" f={save} /><TB i="print" t="Print" f={() => window.print()} /><span className="sep" />
        <TB i="copy" t="Copy" f={copySel} /><TB i="paste" t="Paste" f={pasteSel} /><TB i="undo" t="Undo (Ctrl+Z)" f={undo} /><TB i="redo" t="Redo (Ctrl+Y)" f={redo} /><span className="sep" />
        <TB i="zin" t="Zoom In" f={() => zoom(1.15)} /><TB i="zout" t="Zoom Out" f={() => zoom(1 / 1.15)} /><TB i="zreset" t="Reset Zoom" f={() => { ui.zoom = 1; uiTouch(); }} /><span className="sep" />
        <TB i="calc" t="Subnet Calculator" f={() => openWin('subnet', 'Subnet Calculator', { id: 'subnet' })} /><button className="ai-btn" title="AI Solver" onClick={() => openAgent("solve")}>✦ AI Solver</button><button className="ai-btn doc" title="Network Doctor" onClick={() => openAgent("doctor")}>⚕ Doctor</button><span className="grow" /><span className="zoomlbl">{Math.round(ui.zoom * 100)}%</span><TB i="help" t="Help" f={() => openWin('help', 'Help', { id: 'help' })} />
      </div>
      <div className="viewtabs"><button className={ui.view === 'logical' ? 'on' : ''} onClick={() => { ui.view = 'logical'; uiTouch(); }}>Logical</button><button className={ui.view === 'physical' ? 'on' : ''} onClick={() => { ui.view = 'physical'; uiTouch(); }}>Physical</button><span className="root">[Root]</span>
        <span className="hint">{ui.hint}</span></div>
      <div className="main">
        <div className="wsbox">{ready && (ui.view === 'logical' ? <Workspace /> : <PhysicalView />)}</div>
        <CommonTools />
        {sim && <SimPanel />}
      </div>
      <div className="bottom"><Palette /><div className="right"><TimeBar /><PduList /></div><ModeTabs /></div>
      {ui.wins.map(w => {
        switch (w.kind) {
          case 'device': return <DeviceWindow key={w.id} w={w} />; case 'pduinfo': return <PduInfoWin key={w.id} w={w} />; case 'inspect': return <InspectWin key={w.id} w={w} />; case 'cpdu': return <ComplexPduWin key={w.id + (w.data?.edit ?? '')} w={w} />;
          case 'filters': return <FiltersWin key={w.id} w={w} />; case 'prefs': return <PrefsWin key={w.id} w={w} />; case 'help': return <HelpWin key={w.id} w={w} />; case 'about': return <AboutWin key={w.id} w={w} />;
          case 'subnet': return <SubnetWin key={w.id} w={w} />; case 'labs': return <LabsWin key={w.id} w={w} />; case 'coach': return <CoachWin key={w.id} w={w} />; case 'agent': return <AgentWin key={w.id} w={w} />; default: return null;
        }
      })}
      {ui.toast && <div className="toast" role="status">{ui.toast}</div>}
    </div>
  );
}

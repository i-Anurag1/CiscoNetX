import { net, ui, uiTouch, useRev, sim, stepFwd, stepBack, startPlay, stopPlay, resetSim, setMode, visibleEvents, firePdu, powerCycleAll, fastForward, openWin, commit, type PduRec } from './store.ts';
import { Ico } from './icons.tsx';

export const fmtClock = (s: number): string => { const t = Math.floor(s); return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60].map(x => String(x).padStart(2, '0')).join(':'); };
export function TimeBar() {
  useRev();
  return (
    <div className="timebar">
      <span className="clock">Time: {fmtClock(net.clock)}</span>
      <button onClick={powerCycleAll} title="Reboot every device from its startup configuration">Power Cycle Devices</button>
      <button onClick={fastForward} title="Skip forward so spanning-tree timers expire">▶▶ Fast Forward Time</button>
    </div>
  );
}
export function ModeTabs() {
  useRev();
  return (
    <div className="modetabs">
      <button className={ui.mode === 'realtime' ? 'on' : ''} onClick={() => setMode('realtime')}>Realtime</button>
      <button className={ui.mode === 'simulation' ? 'on' : ''} onClick={() => setMode('simulation')}>Simulation</button>
    </div>
  );
}
export function PduList() {
  useRev();
  const rows = ui.pdus.filter(p => p.scenario === ui.scenario);
  const nm = (id: string) => net.dev(id)?.name ?? '(deleted)';
  const del = (p: PduRec) => { ui.pdus = ui.pdus.filter(x => x.id !== p.id); uiTouch(); };
  return (
    <div className="pdupanel">
      <div className="pdu-head">
        <span>Scenario</span>
        <select value={ui.scenario} onChange={e => { ui.scenario = Number(e.target.value); uiTouch(); }}>{ui.scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <button onClick={() => { const id = Math.max(...ui.scenarios.map(s => s.id)) + 1; ui.scenarios.push({ id, name: `Scenario ${id}` }); ui.scenario = id; uiTouch(); }}>New</button>
        <button disabled={ui.scenarios.length < 2} onClick={() => { ui.pdus = ui.pdus.filter(p => p.scenario !== ui.scenario); ui.scenarios = ui.scenarios.filter(s => s.id !== ui.scenario); ui.scenario = ui.scenarios[0].id; uiTouch(); }}>Delete</button>
        <button onClick={() => { ui.pduWin = !ui.pduWin; uiTouch(); }}>Toggle PDU List Window</button>
      </div>
      {ui.pduWin && (
        <div className="pdu-table"><table><thead><tr><th>Fire</th><th>Last Status</th><th>Source</th><th>Destination</th><th>Type</th><th>Color</th><th>Time(sec)</th><th>Periodic</th><th>Num</th><th>Edit</th><th>Delete</th></tr></thead>
          <tbody>{rows.map(p => (
            <tr key={p.id}>
              <td><button className="fire" title="Fire this PDU" onClick={() => void firePdu(p)}>✉</button></td>
              <td className={p.status === 'Successful' ? 'ok' : p.status === 'Failed' ? 'bad' : ''}>{p.status}</td><td>{nm(p.src)}</td><td>{nm(p.dst)}</td><td>{p.type}</td><td><span className="swatch" style={{ background: p.color }} /></td>
              <td>{p.time.toFixed(3)}</td><td><input type="checkbox" checked={p.periodic} onChange={e => { p.periodic = e.target.checked; uiTouch(); }} /></td><td>{p.id}</td>
              <td><a onClick={() => openWin('cpdu', 'Edit PDU', { id: 'cpdu', devId: p.src, data: { src: p.src, edit: p.id } })}>(edit)</a></td><td><a onClick={() => del(p)}>(delete)</a></td>
            </tr>))}
            {!rows.length && <tr><td colSpan={11} className="muted">No PDUs yet — use the envelope tool on the right, then click a source and a destination.</td></tr>}
          </tbody></table></div>
      )}
    </div>
  );
}
export function SimPanel() {
  useRev();
  const ev = visibleEvents(); const nm = (id: string | null) => (id ? net.dev(id)?.name ?? '?' : '--');
  const last = sim.cursor >= sim.events.length;
  return (
    <div className="simpanel">
      <div className="sim-title">Simulation Panel</div>
      <div className="sim-sec"><b>Event List</b>
        <div className="sim-filter"><button onClick={() => openWin('filters', 'Event List Filters', { id: 'filters' })}>Edit Filters</button><span className="muted">Visible: {Object.entries(sim.filters).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}</span></div>
      </div>
      <div className="sim-list"><table><thead><tr><th>Vis.</th><th>Time(sec)</th><th>Last Device</th><th>At Device</th><th>Type</th></tr></thead>
        <tbody>{ev.map(e => (
          <tr key={e.n} className={e.n === sim.cursor - 1 ? 'cur' : ''} onClick={() => openWin('pduinfo', `PDU Information at Device: ${nm(e.at)}`, { id: `pdu:${e.n}`, data: { n: e.n } })}>
            <td><span className={`vis ${e.status}`} style={{ background: e.status === 'drop' ? '#e53935' : '#2e7d32' }} /></td><td>{e.t.toFixed(3)}</td><td>{nm(e.from)}</td><td>{nm(e.at)}</td><td>{e.type}</td></tr>))}
          {!ev.length && <tr><td colSpan={5} className="muted">Fire a PDU or run ping, then press Capture / Forward.</td></tr>}
        </tbody></table></div>
      <div className="sim-ctrl">
        <label><input type="checkbox" checked={sim.constantDelay} onChange={e => { sim.constantDelay = e.target.checked; uiTouch(); }} />Constant Delay</label>
        <button onClick={() => resetSim()}>Reset Simulation</button>
      </div>
      <div className="sim-play"><span>Play Controls:</span>
        <button title="Back" onClick={stepBack} disabled={sim.cursor === 0}>⏮</button>
        <button title={sim.playing ? 'Pause' : 'Auto Capture / Play'} onClick={() => (sim.playing ? stopPlay() : startPlay())}>{sim.playing ? '⏸' : '▶'}</button>
        <button title="Capture / Forward" onClick={() => stepFwd()} disabled={last && !sim.events.length}>⏭</button>
        <input type="range" min={150} max={1500} step={50} value={1650 - ui.prefs.animMs} onChange={e => { ui.prefs.animMs = 1650 - Number(e.target.value); if (sim.playing) { stopPlay(); startPlay(); } uiTouch(); }} title="Animation speed" />
      </div>
    </div>
  );
}
export function CommonTools() {
  useRev();
  const T: [string, string, string, string][] = [['select', 'Select (ESC)', 'select', ''], ['note', 'Place Note (N)', 'note', ''], ['delete', 'Delete (Del)', 'delete', ''], ['inspect', 'Inspect (I)', 'inspect', ''], ['pdu', 'Add Simple PDU (P)', 'pdu', 'Select a source device'], ['cpdu', 'Add Complex PDU (C)', 'cpdu', 'Select a source device']];
  return (
    <div className="tools">
      {T.map(([id, label, ico, hint]) => <button key={id} className={ui.tool === id ? 'on' : ''} title={label} onClick={() => { ui.tool = id as typeof ui.tool; ui.placing = null; ui.cableFrom = null; ui.pduSrc = null; ui.hint = hint; if (id === 'delete') { for (const sid of ui.selected) net.removeDevice(sid); if (ui.selected.length) { ui.selected = []; commit(); } } uiTouch(); }}>{Ico[ico]}</button>)}
    </div>
  );
}

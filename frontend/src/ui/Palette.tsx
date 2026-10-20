import { CABLES, MODELS, modelOf } from '../model/catalog.ts';
import { DevIcon, Ico, CableIcon } from './icons.tsx';
import { ui, uiTouch, useRev } from './store.ts';

const CATS = [{ id: 'router', icon: 'cat_router', label: 'Network Devices' }, { id: 'end', icon: 'cat_end', label: 'End Devices' }, { id: 'conn', icon: 'cat_conn', label: 'Connections' }] as const;
const SUBS: Record<string, { id: string; label: string }[]> = { router: [{ id: 'router', label: 'Routers' }, { id: 'switch', label: 'Switches' }, { id: 'hub', label: 'Hubs' }], end: [{ id: 'end', label: 'End Devices' }], conn: [{ id: 'conn', label: 'Connections' }] };

export function Palette() {
  useRev();
  const top = ui.palCat === 'conn' ? 'conn' : ui.palCat === 'end' ? 'end' : 'router';
  const sub = ui.palCat === 'switch' || ui.palCat === 'hub' ? ui.palCat : top;
  const label = ui.palSel || (top === 'conn' ? 'Connections' : modelOf(sub === 'router' ? '1941' : sub).label);
  const models = MODELS.filter(m => m.cat === sub);
  return (
    <div className="palette">
      <div className="pal-top">
        {CATS.map(c => <button key={c.id} className={`pal-cat ${top === c.id ? 'on' : ''}`} title={c.label} onClick={() => { ui.palCat = c.id === 'router' ? 'router' : c.id; ui.palSel = c.label; uiTouch(); }}>{Ico[c.icon]}</button>)}
      </div>
      <div className="pal-sub">
        {SUBS[top].map(s => <button key={s.id} className={`pal-subbtn ${sub === s.id ? 'on' : ''}`} title={s.label} onClick={() => { ui.palCat = s.id; ui.palSel = s.label; uiTouch(); }}>{s.id === 'conn' ? Ico.cat_conn : Ico[`cat_${s.id}`]}</button>)}
      </div>
      <div className="pal-items">
        <div className="pal-scroll">
          {top === 'conn' ? CABLES.map(c => (
            <button key={c.id} className={`pal-item ${ui.tool === 'cable' && ui.cableSel === c.id ? 'on' : ''}`} title={c.label} onClick={() => { ui.tool = 'cable'; ui.cableSel = c.id; ui.cableFrom = null; ui.palSel = c.label; ui.hint = 'Select a device, then choose a port'; uiTouch(); }}><CableIcon id={c.id} /></button>
          )) : models.map(m => (
            <button key={m.id} className={`pal-item ${ui.tool === 'place' && ui.placing === m.id ? 'on' : ''}`} title={m.desc} draggable onDragStart={e => e.dataTransfer.setData('text/cnx-model', m.id)}
              onMouseEnter={() => { ui.palSel = m.desc; uiTouch(); }} onClick={() => { ui.tool = 'place'; ui.placing = m.id; ui.palSel = m.desc; ui.hint = `Click the workspace to place ${m.label}`; uiTouch(); }}>
              <DevIcon kind={m.kind} size={34} /><span>{m.label}</span>
            </button>
          ))}
        </div>
        <div className="pal-label">{label}</div>
      </div>
    </div>
  );
}

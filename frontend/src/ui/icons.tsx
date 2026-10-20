import type { ReactElement } from 'react';
import type { Kind } from '../model/types.ts';
export function Defs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8fb9e6" /><stop offset="1" stopColor="#3f78b8" /></linearGradient>
        <linearGradient id="gBlueD" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#2f66a3" /><stop offset=".5" stopColor="#4a86c6" /><stop offset="1" stopColor="#24508a" /></linearGradient>
        <linearGradient id="gGrey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#f3f3f0" /><stop offset="1" stopColor="#b9b9b2" /></linearGradient>
        <linearGradient id="gScreen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#8fd0ff" /><stop offset="1" stopColor="#2f78c8" /></linearGradient>
        <linearGradient id="gTower" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#e9e9e4" /><stop offset="1" stopColor="#a9a9a2" /></linearGradient>
      </defs>
    </svg>
  );
}
const A = (x1: number, y1: number, x2: number, y2: number) => <path d={`M${x1} ${y1} L${x2} ${y2}`} stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />;
function head(x: number, y: number, dx: number, dy: number) {
  const l = Math.hypot(dx, dy); const ux = dx / l, uy = dy / l; const px = -uy, py = ux;
  return <path d={`M${x} ${y} L${x - ux * 6 + px * 3.6} ${y - uy * 6 + py * 3.6} L${x - ux * 6 - px * 3.6} ${y - uy * 6 - py * 3.6} Z`} fill="#fff" />;
}
export function DevIcon({ kind, size = 56 }: { kind: Kind; size?: number }) {
  const s = { width: size, height: size } as const;
  if (kind === 'router') return (
    <svg viewBox="0 0 64 64" {...s}><path d="M5 24 V43 C5 50 17 55 32 55 S59 50 59 43 V24 Z" fill="url(#gBlueD)" stroke="#173a63" /><ellipse cx="32" cy="24" rx="27" ry="12" fill="url(#gBlue)" stroke="#173a63" />
      {A(16, 24, 48, 24)}{head(49, 24, 1, 0)}{head(15, 24, -1, 0)}{A(32, 16.5, 32, 31.5)}{head(32, 15.5, 0, -1)}{head(32, 32.5, 0, 1)}</svg>);
  if (kind === 'switch' || kind === 'l3switch') return (
    <svg viewBox="0 0 64 64" {...s}><path d="M4 31 L15 18 H61 L50 31 Z" fill="url(#gBlue)" stroke="#173a63" /><rect x="4" y="31" width="46" height="19" fill="url(#gBlueD)" stroke="#173a63" /><path d="M50 31 L61 18 V37 L50 50 Z" fill="#1f4a7c" stroke="#173a63" />
      {A(14, 25, 46, 25)}{head(47, 25, 1, 0)}{head(13, 25, -1, 0)}{A(20, 40, 40, 40)}{head(41, 40, 1, 0)}{head(19, 40, -1, 0)}{kind === 'l3switch' && <circle cx="45" cy="43" r="3" fill="#ffd54f" />}</svg>);
  if (kind === 'hub') return (
    <svg viewBox="0 0 64 64" {...s}><path d="M4 32 L15 20 H61 L50 32 Z" fill="#cfd8e3" stroke="#59687a" /><rect x="4" y="32" width="46" height="16" fill="url(#gGrey)" stroke="#59687a" /><path d="M50 32 L61 20 V36 L50 48 Z" fill="#8a96a5" stroke="#59687a" />
      {[0, 1, 2, 3, 4].map(i => <rect key={i} x={9 + i * 8} y="38" width="5" height="5" fill="#34485f" />)}</svg>);
  if (kind === 'server') return (
    <svg viewBox="0 0 64 64" {...s}><rect x="16" y="5" width="32" height="54" rx="3" fill="url(#gTower)" stroke="#555" />{[0, 1, 2, 3].map(i => <rect key={i} x="21" y={11 + i * 9} width="22" height="6" fill="#e2e2dd" stroke="#777" />)}<circle cx="26" cy="49" r="2.2" fill="#3ddc84" /><circle cx="33" cy="49" r="2.2" fill="#ffca28" /><rect x="22" y="53" width="20" height="2" fill="#777" /></svg>);
  if (kind === 'laptop') return (
    <svg viewBox="0 0 64 64" {...s}><path d="M14 14 H50 L52 40 H12 Z" fill="#d9d9d3" stroke="#555" /><rect x="17" y="17" width="30" height="20" fill="url(#gScreen)" stroke="#456" /><path d="M6 42 H58 L54 52 H10 Z" fill="url(#gGrey)" stroke="#555" /><path d="M22 46 H42" stroke="#888" strokeWidth="2" /></svg>);
  return (
    <svg viewBox="0 0 64 64" {...s}><rect x="6" y="8" width="34" height="28" rx="2" fill="#dcdcd5" stroke="#555" /><rect x="9" y="11" width="28" height="21" fill="url(#gScreen)" stroke="#456" /><rect x="19" y="36" width="8" height="5" fill="#b0b0a8" stroke="#666" /><rect x="12" y="41" width="22" height="3" rx="1" fill="#cfcfc7" stroke="#666" />
      <rect x="43" y="14" width="15" height="38" rx="2" fill="url(#gTower)" stroke="#555" /><rect x="46" y="19" width="9" height="3" fill="#777" /><circle cx="50" cy="45" r="1.8" fill="#3ddc84" /><path d="M8 52 H38 L36 58 H10 Z" fill="url(#gGrey)" stroke="#666" /></svg>);
}
const st = { fill: 'none', stroke: '#35506f', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
export const Ico: Record<string, ReactElement> = {
  new: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M6 3h8l4 4v14H6z M14 3v4h4" /></svg>,
  open: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M3 7h6l2 2h10v10H3z" fill="#f6d36b" /></svg>,
  save: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M4 4h13l3 3v13H4z M8 4v5h8V4 M8 20v-6h8v6" fill="#9db8d8" /></svg>,
  print: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M7 9V3h10v6 M6 17H4v-7h16v7h-2 M7 14h10v7H7z" /></svg>,
  copy: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M9 9h10v12H9z M5 15V3h10" /></svg>,
  paste: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M6 5h12v16H6z M9 3h6v4H9z" /></svg>,
  undo: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M9 7L4 12l5 5 M4 12h10a6 6 0 010 8h-3" /></svg>,
  redo: <svg viewBox="0 0 24 24" width="20" height="20"><path {...st} d="M15 7l5 5-5 5 M20 12H10a6 6 0 000 8h3" /></svg>,
  zin: <svg viewBox="0 0 24 24" width="20" height="20"><circle {...st} cx="10" cy="10" r="6" /><path {...st} d="M15 15l6 6 M7 10h6 M10 7v6" /></svg>,
  zout: <svg viewBox="0 0 24 24" width="20" height="20"><circle {...st} cx="10" cy="10" r="6" /><path {...st} d="M15 15l6 6 M7 10h6" /></svg>,
  zreset: <svg viewBox="0 0 24 24" width="20" height="20"><circle {...st} cx="10" cy="10" r="6" /><path {...st} d="M15 15l6 6" /><text x="7" y="13" fontSize="7" fill="#35506f" stroke="none">1:1</text></svg>,
  help: <svg viewBox="0 0 24 24" width="20" height="20"><circle {...st} cx="12" cy="12" r="9" fill="#e8f1fb" /><path {...st} d="M9.5 9.5a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4 M12 17v.5" /></svg>,
  calc: <svg viewBox="0 0 24 24" width="20" height="20"><rect {...st} x="5" y="3" width="14" height="18" rx="2" /><path {...st} d="M8 7h8 M8 11h2 M12 11h2 M8 15h2 M12 15h2" /></svg>,
  select: <svg viewBox="0 0 24 24" width="26" height="26"><path d="M6 3l12 10h-6l3 7-3 1-3-7-3 3z" fill="#fff" stroke="#233" strokeWidth="1.4" strokeLinejoin="round" /></svg>,
  note: <svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 4h14v12l-4 4H5z M15 20v-4h4" fill="#ffe98a" stroke="#6a5a1c" strokeWidth="1.4" strokeLinejoin="round" /><path d="M8 9h8 M8 13h5" stroke="#6a5a1c" strokeWidth="1.2" /></svg>,
  delete: <svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 5l14 14 M19 5L5 19" stroke="#c62828" strokeWidth="3.2" strokeLinecap="round" /></svg>,
  inspect: <svg viewBox="0 0 24 24" width="26" height="26"><circle cx="10" cy="10" r="6" fill="#dbeeff" stroke="#233" strokeWidth="1.6" /><path d="M15 15l6 6" stroke="#233" strokeWidth="2.6" strokeLinecap="round" /></svg>,
  pdu: <svg viewBox="0 0 24 24" width="26" height="26"><rect x="3" y="6" width="18" height="12" rx="1" fill="#fff" stroke="#233" strokeWidth="1.4" /><path d="M3 7l9 7 9-7" fill="none" stroke="#233" strokeWidth="1.4" /></svg>,
  cpdu: <svg viewBox="0 0 24 24" width="26" height="26"><rect x="3" y="8" width="18" height="11" rx="1" fill="#fff8d6" stroke="#233" strokeWidth="1.4" /><path d="M3 8l9-5 9 5 M3 19l7-6 M21 19l-7-6" fill="none" stroke="#233" strokeWidth="1.4" /></svg>,
  cat_router: <svg viewBox="0 0 32 32" width="26" height="26"><ellipse cx="16" cy="12" rx="12" ry="5" fill="#5c8fc7" stroke="#173a63" /><path d="M4 12v8c0 3 5 5 12 5s12-2 12-5v-8" fill="#3f78b8" stroke="#173a63" /></svg>,
  cat_switch: <svg viewBox="0 0 32 32" width="26" height="26"><path d="M2 15l5-7h23l-5 7z" fill="#8fb9e6" stroke="#173a63" /><rect x="2" y="15" width="23" height="9" fill="#3f78b8" stroke="#173a63" /><path d="M25 15l5-7v10l-5 6z" fill="#1f4a7c" stroke="#173a63" /></svg>,
  cat_hub: <svg viewBox="0 0 32 32" width="26" height="26"><path d="M2 16l5-7h23l-5 7z" fill="#cfd8e3" stroke="#59687a" /><rect x="2" y="16" width="23" height="8" fill="#b9b9b2" stroke="#59687a" /><path d="M25 16l5-7v9l-5 6z" fill="#8a96a5" stroke="#59687a" /></svg>,
  cat_end: <svg viewBox="0 0 32 32" width="26" height="26"><rect x="3" y="5" width="17" height="14" rx="1" fill="#dcdcd5" stroke="#555" /><rect x="5" y="7" width="13" height="10" fill="#4f95dd" /><rect x="22" y="8" width="7" height="19" fill="#c4c4bd" stroke="#555" /></svg>,
  cat_conn: <svg viewBox="0 0 32 32" width="26" height="26"><path d="M5 25 L14 15 L11 15 L20 4 L17 14 L22 14 L12 28Z" fill="#f5c400" stroke="#6b5600" strokeLinejoin="round" /></svg>,
};
export function CableIcon({ id }: { id: string }) {
  if (id === 'auto') return Ico.cat_conn;
  const col = id === 'console' ? '#4aa3df' : id.startsWith('serial') ? '#d32f2f' : '#222'; const dash = id === 'cross' ? '5 3' : undefined;
  return <svg viewBox="0 0 32 32" width="26" height="26"><path d={id.startsWith('serial') ? 'M4 26 L10 18 L8 18 L16 8 L14 17 L18 17 L9 28 Z' : 'M4 26 L28 6'} stroke={col} fill={id.startsWith('serial') ? col : 'none'} strokeWidth="2.4" strokeDasharray={dash} strokeLinecap="round" /></svg>;
}

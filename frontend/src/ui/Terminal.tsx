import { useEffect, useRef, useState } from 'react';
import { Cli } from '../ios/cli.ts';
import { HostShell } from '../ios/host.ts';
import type { Dev } from '../model/types.ts';
import { net, playTrace } from './store.ts';

const hist = new Map<string, string[]>(); const screens = new Map<string, string>();
export function CliTerminal({ dev, kind }: { dev: Dev; kind: 'ios' | 'host' }) {
  const key = `${dev.id}:${kind}`; const cli = useRef<Cli | HostShell | null>(null);
  if (!cli.current) cli.current = kind === 'ios' ? new Cli(net, dev, playTrace) : new HostShell(net, dev, playTrace);
  const [text, setText] = useState<string>(() => screens.get(key) ?? (kind === 'ios' ? (cli.current as Cli).banner() : 'CiscoNetX PC Command Line 1.0\n'));
  const [line, setLine] = useState(''); const [busy, setBusy] = useState(false); const hi = useRef(-1); const box = useRef<HTMLDivElement>(null);
  const prompt = () => (kind === 'ios' ? (cli.current as Cli).prompt() : 'C:\\>');
  useEffect(() => { screens.set(key, text); const b = box.current; if (b) b.scrollTop = b.scrollHeight; }, [text, key]);
  useEffect(() => { box.current?.focus(); }, []);
  const history = hist.get(key) ?? (hist.set(key, []), hist.get(key)!);
  async function submit() {
    const l = line; const p = prompt(); setLine(''); hi.current = -1;
    if (kind === 'ios' && l.trim().endsWith('?')) { const h = (cli.current as Cli).help(l.trim().slice(0, -1)); setText(t => `${t}${p}${l}\n${h}\n`); return; }
    if (l.trim()) { history.push(l); if (history.length > 80) history.shift(); }
    setText(t => `${t}${p}${l}\n`); setBusy(true);
    const out = await cli.current!.exec(l); setBusy(false);
    if (out === '\u0000CLS') { setText(''); return; }
    setText(t => t + (out ? out + '\n' : ''));
  }
  function onKey(e: any) {
    if (busy) { e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); void submit(); }
    else if (e.key === 'Backspace') { e.preventDefault(); setLine(l => l.slice(0, -1)); }
    else if (e.key === 'Tab') { e.preventDefault(); if (kind === 'ios') setLine(l => (cli.current as Cli).complete(l)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (history.length) { hi.current = Math.min(history.length - 1, hi.current + 1); setLine(history[history.length - 1 - hi.current]); } }
    else if (e.key === 'ArrowDown') { e.preventDefault(); hi.current = Math.max(-1, hi.current - 1); setLine(hi.current < 0 ? '' : history[history.length - 1 - hi.current]); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'z')) { e.preventDefault(); if (kind === 'ios') { const c = cli.current as Cli; if (c.s.mode !== 'user' && c.s.mode !== 'priv' && !c.s.asking) { c.s.mode = 'priv'; c.s.ifs = []; } setText(t => t + `${prompt()}${line}^Z\n`); setLine(''); } }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'v') { /* paste handled by onPaste */ }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); setLine(l => l + e.key); if (e.key === '?' && kind === 'ios') { const l = line; setLine(''); const h = (cli.current as Cli).help(l); setText(t => `${t}${prompt()}${l}?\n${h}\n`); } }
  }
  function onPaste(e: any) { e.preventDefault(); const t = e.clipboardData.getData('text'); const lines = t.split(/\r?\n/); setLine(l => l + lines[0]); if (lines.length > 1) void (async () => { for (let i = 0; i < lines.length; i++) { if (i > 0) { const cur = lines[i]; setText(tt => `${tt}${prompt()}${cur}\n`); const out = await cli.current!.exec(cur); if (out) setText(tt => tt + out + '\n'); } } })(); }
  return (
    <div className={`term ${kind}`} tabIndex={0} ref={box} onKeyDown={onKey} onPaste={onPaste} onClick={() => box.current?.focus()}>
      <pre>{text}<span>{(kind === 'ios' && ((cli.current as Cli).s.asking === 'dialog' || (cli.current as Cli).s.asking === 'ret')) ? '' : prompt()}{(kind === 'ios' && (cli.current as Cli).s.asking === 'pw') ? '*'.repeat(line.length) : line}</span><span className="caret">{busy ? '' : '█'}</span></pre>
    </div>
  );
}

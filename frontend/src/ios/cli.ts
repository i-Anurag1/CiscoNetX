import type { Dev, IfCfg, Acl, AclAddr, PortM } from '../model/types.ts';
import type { Net } from '../model/net.ts';
import { defaultIf } from '../model/net.ts';
import { isSwitch } from '../model/catalog.ts';
import { isIp, isUsableHost, maskToLen, parseIp, wildToLen, lenToMask, fmtIp } from '../lib/ip.ts';
import { echoOnce, finalize, Trace, traceroute, type PingResult } from '../sim/engine.ts';
import { routingInfo, isRouting } from '../sim/routing.ts';
import * as S from './show.ts';

export type Mode = 'user' | 'priv' | 'config' | 'if' | 'line' | 'rip' | 'ospf' | 'eigrp' | 'vlan' | 'dhcp' | 'nacl';
export interface Sess { mode: Mode; ifs: string[]; line: 'con' | 'vty'; pool: string; acl: string; vlan: number; hist: string[]; asking: null | 'pw' | 'dialog' | 'ret'; booted: boolean }
export type TraceHook = (tr: Trace) => Promise<void>;
type Out = string | void;
interface Cmd { modes: Mode[]; pat: string[]; fn: (h: Cli, a: string[]) => Out | Promise<Out> }
const sessions = new Map<string, Sess>();
const CFG_FAMILY: Mode[] = ['if', 'line', 'rip', 'ospf', 'eigrp', 'vlan', 'dhcp', 'nacl'];
const HELP: Record<string, string> = {
  show: 'Show running system information', enable: 'Turn on privileged commands', configure: 'Enter configuration mode', terminal: 'Configuration from vty interface', interface: 'Select an interface to configure', ip: 'Interface Internet Protocol config commands', no: 'Negate a command or set its defaults', exit: 'Exit from the current mode', end: 'Exit to privileged EXEC', ping: 'Send echo messages', traceroute: 'Trace route to destination', copy: 'Copy from one file to another', write: 'Write running configuration to memory', router: 'Enable a routing process', hostname: 'Set system\'s network name', shutdown: 'Shutdown the selected interface', network: 'Enable routing on an IP network', switchport: 'Set switching mode characteristics', vlan: 'VLAN commands', 'access-list': 'Add an access list entry', description: 'Interface specific description', disable: 'Turn off privileged commands', reload: 'Halt and perform a cold restart', erase: 'Erase a filesystem', line: 'Configure a terminal line', banner: 'Define a login banner', access: 'x', clear: 'Reset functions', do: 'To run exec commands in config mode', passive: 'Suppress routing updates on an interface', version: 'Set routing protocol version', encapsulation: 'Set encapsulation type for an interface', duplex: 'Configure duplex operation', speed: 'Configure speed operation', clock: 'Configure serial interface clock', bandwidth: 'Set bandwidth informational parameter', 'default-router': 'Default routers', 'dns-server': 'DNS servers', name: 'Ascii name of the VLAN', permit: 'Specify packets to forward', deny: 'Specify packets to reject', password: 'Set a password', login: 'Enable password checking', spanning: 'Spanning Tree Subsystem', service: 'Modify use of network based services', enable_: 'x',
};
const norm = (s: string) => s.toLowerCase();
const IFT: [string, string][] = [['fastethernet', 'FastEthernet'], ['gigabitethernet', 'GigabitEthernet'], ['serial', 'Serial'], ['loopback', 'Loopback'], ['vlan', 'Vlan']];

export class Cli {
  net: Net; dev: Dev; s: Sess; hook: TraceHook; private cmds: Cmd[] = [];
  constructor(net: Net, dev: Dev, hook: TraceHook = async () => {}, detached?: Sess) {
    this.net = net; this.dev = dev; this.hook = hook;
    let s = detached ?? sessions.get(dev.id);
    if (!s) { s = { mode: 'user', ifs: [], line: 'con', pool: '', acl: '', vlan: 1, hist: [], asking: dev.startup ? 'ret' : 'dialog', booted: false }; if (!detached) sessions.set(dev.id, s); }
    this.s = s; this.build();
  }
  static reset(devId: string): void { sessions.delete(devId); }
  static resetAll(): void { sessions.clear(); }
  static detached(net: Net, dev: Dev): Cli { return new Cli(net, dev, async () => {}, { mode: 'config', ifs: [], line: 'con', pool: '', acl: '', vlan: 1, hist: [], asking: null, booted: true }); }
  get cfg() { return this.dev.cfg; }
  banner(): string {
    if (this.s.booted) return '';
    this.s.booted = true;
    const head = `System Bootstrap, Version 15.1(4)M4, SIMULATED\nCiscoNetX ${this.dev.model} platform with 524288 Kbytes of main memory\n\n`;
    if (this.s.asking === 'dialog') return head + '            --- System Configuration Dialog ---\n\nWould you like to enter the initial configuration dialog? [yes/no]: ';
    return head + '\nPress RETURN to get started!\n';
  }
  prompt(): string {
    const h = this.cfg.hostname; const m = this.s.mode;
    if (this.s.asking === 'pw') return 'Password: '; if (this.s.asking === 'dialog') return ''; if (this.s.asking === 'ret') return '';
    const suffix: Record<Mode, string> = { user: '>', priv: '#', config: '(config)#', if: this.s.ifs.length > 1 ? '(config-if-range)#' : this.s.ifs[0]?.includes('.') ? '(config-subif)#' : '(config-if)#', line: '(config-line)#', rip: '(config-router)#', ospf: '(config-router)#', eigrp: '(config-router)#', vlan: '(config-vlan)#', dhcp: '(dhcp-config)#', nacl: `(config-${this.cfg.acls.find(a => a.name === this.s.acl)?.ext ? 'ext' : 'std'}-nacl)#` };
    return h + suffix[m];
  }
  private add(modes: Mode[], pat: string, fn: Cmd['fn']): void { this.cmds.push({ modes, pat: pat.split(' '), fn }); }

  // ---------- matching ----------
  private candidates(mode: Mode): Cmd[] {
    const cm = this.cmds.filter(c => c.modes.includes(mode));
    if (mode === 'priv') return [...cm, ...this.cmds.filter(c => c.modes.includes('user'))];
    if (CFG_FAMILY.includes(mode)) return [...cm, ...this.cmds.filter(c => c.modes.includes('config') && !cm.some(x => x.pat.join(' ') === c.pat.join(' ')))];
    return cm;
  }
  private match(toks: string[], mode: Mode): { cmd?: Cmd; err?: string } {
    const cs = this.candidates(mode); const ok: { c: Cmd; exact: number }[] = []; let bestPrefix = 0; let incomplete = false;
    for (const c of cs) {
      let i = 0; let exact = 0; let good = true;
      for (; i < toks.length; i++) {
        const p = c.pat[i];
        if (p === undefined) { good = false; break; }
        if (p === '<rest>') { i = toks.length; break; }
        if (p.startsWith('<')) continue;
        if (norm(p) === norm(toks[i])) { exact++; continue; }
        if (!norm(p).startsWith(norm(toks[i]))) { good = false; break; }
      }
      bestPrefix = Math.max(bestPrefix, good ? toks.length : i);
      if (!good) continue;
      const full = c.pat.length === toks.length || c.pat[toks.length] === '<rest>' && false || (c.pat[c.pat.length - 1] === '<rest>' && toks.length >= c.pat.length - 1 && c.pat.length - 1 <= toks.length);
      if (full) ok.push({ c, exact }); else incomplete = true;
    }
    if (ok.length) {
      const max = Math.max(...ok.map(x => x.exact)); let top = ok.filter(x => x.exact === max);
      if (top.length > 1) { const spec = (c: Cmd) => c.pat.filter(p => !p.startsWith('<')).length; const ms = Math.max(...top.map(x => spec(x.c))); top = top.filter(x => spec(x.c) === ms); }
      if (top.length > 1) { const lits = new Set(top.map(x => x.c.pat.filter(p => !p.startsWith('<')).join(' '))); if (lits.size > 1) return { err: `% Ambiguous command:  "${toks.join(' ')}"` }; }
      return { cmd: top[0].c };
    }
    if (incomplete && bestPrefix >= toks.length) return { err: '% Incomplete command.' };
    return { err: `% Invalid input detected at '^' marker.|${bestPrefix}` };
  }
  help(line: string): string {
    const toks = line.trim().split(/\s+/).filter(Boolean); const trailing = /\s$/.test(line) || toks.length === 0;
    const prefix = trailing ? toks : toks.slice(0, -1); const part = trailing ? '' : toks[toks.length - 1];
    const seen = new Map<string, string>(); let cr = false;
    for (const c of this.candidates(this.s.mode)) {
      let good = true;
      for (let i = 0; i < prefix.length; i++) { const p = c.pat[i]; if (p === undefined) { good = false; break; } if (p === '<rest>') break; if (!p.startsWith('<') && !norm(p).startsWith(norm(prefix[i]))) { good = false; break; } }
      if (!good) continue;
      const p = c.pat[prefix.length];
      if (p === undefined) { if (!part) cr = true; continue; }
      if (p.startsWith('<')) { if (!part) seen.set(p === '<rest>' ? 'LINE' : p.replace(/[<>]/g, '').toUpperCase(), 'Argument'); continue; }
      if (norm(p).startsWith(norm(part))) seen.set(p, HELP[p] ?? '');
    }
    const rows = [...seen.entries()].sort().map(([k, v]) => `  ${k.padEnd(18)}${v}`); if (cr) rows.unshift('  <cr>');
    return rows.join('\n');
  }
  complete(line: string): string {
    const toks = line.split(/\s+/); if (/\s$/.test(line)) return line; const last = toks[toks.length - 1]; const prefix = toks.slice(0, -1);
    const opts = new Set<string>();
    for (const c of this.candidates(this.s.mode)) {
      let good = true;
      for (let i = 0; i < prefix.length; i++) { const p = c.pat[i]; if (p === undefined) { good = false; break; } if (p === '<rest>') break; if (!p.startsWith('<') && !norm(p).startsWith(norm(prefix[i]))) { good = false; break; } }
      const p = c.pat[prefix.length]; if (good && p && !p.startsWith('<') && norm(p).startsWith(norm(last))) opts.add(p);
    }
    return opts.size === 1 ? [...prefix, [...opts][0]].join(' ') + ' ' : line;
  }

  // ---------- execution ----------
  async exec(raw: string): Promise<string> {
    const s = this.s; const line = raw.trim();
    if (s.asking === 'dialog') { s.asking = 'ret'; return /^y/i.test(line) ? '\nInitial configuration dialog is not available in this simulator; continuing without it.\n\nPress RETURN to get started!\n' : '\nPress RETURN to get started!\n'; }
    if (s.asking === 'ret') { s.asking = null; s.mode = 'user'; return ''; }
    if (s.asking === 'pw') { s.asking = null; if (line === this.cfg.secret) s.mode = 'priv'; else return '% Access denied'; return ''; }
    if (!line) return '';
    if (line.startsWith('!')) return '';
    s.hist.push(line); if (s.hist.length > 100) s.hist.shift();
    const toks = line.split(/\s+/);
    let mode = s.mode; let run = toks;
    if (toks[0].toLowerCase() === 'do' && CFG_FAMILY.concat('config').includes(mode)) { mode = 'priv'; run = toks.slice(1); if (!run.length) return '% Incomplete command.'; const saved = s.mode; s.mode = 'priv'; const r = await this.run(run, line, mode); s.mode = saved; return r; }
    return this.run(run, line, mode);
  }
  private async run(toks: string[], line: string, mode: Mode): Promise<string> {
    const m = this.match(toks, mode);
    if (!m.cmd) {
      if (m.err!.includes('|')) { const [msg, idx] = m.err!.split('|'); const pos = toks.slice(0, Number(idx)).join(' ').length + (Number(idx) > 0 ? 1 : 0); const base = line.indexOf(toks[0]); return `${' '.repeat(this.prompt().length + base + pos)}^\n${msg}`; }
      return m.err!;
    }
    try { const r = await m.cmd.fn(this, toks); return r ?? ''; } catch (e) { return `% ${e instanceof Error ? e.message : 'Command failed'}`; }
  }

  // ---------- helpers used by command handlers ----------
  parseIf(toks: string[]): string | null {
    const j = toks.join('').toLowerCase(); const m = /^([a-z]+)([\d/.]+)$/.exec(j); if (!m) return null;
    const t = IFT.find(([k]) => k.startsWith(m[1]) && m[1].length >= (m[1].startsWith('g') ? 1 : m[1].startsWith('s') ? 1 : 2) || (m[1] === 'gi' && k === 'gigabitethernet') || (m[1] === 'fa' && k === 'fastethernet'));
    if (!t) return null; const name = t[1] + m[2]; return name;
  }
  selectIf(name: string): IfCfg | string {
    const d = this.dev; const net = this.net;
    if (name.startsWith('Loopback')) { if (isSwitch(d.kind)) return 'Invalid'; let c = net.cfgIf(d, name); if (!c) { c = defaultIf(name, 'lo', true); d.cfg.ifs.push(c); net.touch(); } return c; }
    if (name.startsWith('Vlan')) { if (!isSwitch(d.kind)) return 'Invalid'; let c = net.cfgIf(d, name); if (!c) { c = defaultIf(name, 'svi', name !== 'Vlan1'); d.cfg.ifs.push(c); net.touch(); } return c; }
    if (name.includes('.')) {
      const par = name.split('.')[0]; if (!d.ports.some(p => p.name === par) || isSwitch(d.kind)) return 'Invalid';
      let c = net.cfgIf(d, name); if (!c) { c = defaultIf(name, 'sub', true); c.parent = par; d.cfg.ifs.push(c); net.touch(); } return c;
    }
    const c = net.cfgIf(d, name); if (!c || c.type !== 'phys') return 'Invalid'; return c;
  }
  ifsSel(): IfCfg[] { return this.s.ifs.map(n => this.net.cfgIf(this.dev, n)).filter((x): x is IfCfg => !!x); }
  touch(): void { this.net.touch(); }
  linkMsg(c: IfCfg, up: boolean): string {
    if (c.type !== 'phys') return '';
    const ph = this.net.portPhy(this.dev, c.name); if (!ph.up) return '';
    const st = up ? 'up' : 'down';
    return `\n%LINK-5-CHANGED: Interface ${c.name}, changed state to ${st}\n\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${c.name}, changed state to ${ph.proto && up ? 'up' : 'down'}`;
  }
  async ping(target: string, count = 5): Promise<string> {
    if (!isIp(target)) return '% Unrecognized host or address, or protocol not running.';
    const tr = new Trace(this.net); const res: PingResult[] = [];
    for (let i = 0; i < count; i++) res.push(echoOnce(tr, this.dev, target, i + 1, i, { size: 72 }));
    finalize(tr); await this.hook(tr);
    const sym = res.map(r => r.status === 'reply' ? '!' : r.status === 'timeout' ? '.' : 'U').join(''); const ok = res.filter(r => r.status === 'reply'); const ms = ok.map(r => r.ms ?? 0);
    const rate = Math.round((ok.length / count) * 100);
    return `\nType escape sequence to abort.\nSending ${count}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:\n${sym}\nSuccess rate is ${rate} percent (${ok.length}/${count})${ok.length ? `, round-trip min/avg/max = ${Math.min(...ms)}/${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)}/${Math.max(...ms)} ms` : ''}`;
  }
  async trace(target: string): Promise<string> {
    if (!isIp(target)) return '% Unrecognized host or address, or protocol not running.';
    const r = traceroute(this.net, this.dev, target); await this.hook(r.trace);
    return `\nType escape sequence to abort.\n\nTracing the route to ${target}\n\n` + r.hops.map(h => `  ${h.hop}   ${h.addr ? `${h.addr}   ${h.ms.map(m => (m < 1 ? '<1' : m) + ' msec').join('   ')}` : '*        *        *'}`).join('\n') + '\n';
  }
  parseAclAddr(t: string[], i: number): [AclAddr, number] | null {
    if (t[i] === 'any') return [{ any: true, ip: '0.0.0.0', wild: '255.255.255.255' }, i + 1];
    if (t[i] === 'host' && isIp(t[i + 1])) return [{ any: false, ip: t[i + 1], wild: '0.0.0.0' }, i + 2];
    if (isIp(t[i]) && isIp(t[i + 1])) return [{ any: false, ip: t[i], wild: t[i + 1] }, i + 2];
    if (isIp(t[i])) return [{ any: false, ip: t[i], wild: '0.0.0.0' }, i + 1];
    return null;
  }
  parsePort(t: string[], i: number): [PortM | undefined, number] {
    const names: Record<string, number> = { www: 80, http: 80, https: 443, ftp: 21, 'ftp-data': 20, telnet: 23, ssh: 22, smtp: 25, domain: 53, dns: 53, pop3: 110, tftp: 69 };
    const v = (x: string) => names[x] ?? Number(x);
    if (['eq', 'gt', 'lt', 'neq'].includes(t[i]) && t[i + 1] !== undefined) return [{ op: t[i] as PortM['op'], a: v(t[i + 1]) }, i + 2];
    if (t[i] === 'range' && t[i + 2] !== undefined) return [{ op: 'range', a: v(t[i + 1]), b: v(t[i + 2]) }, i + 3];
    return [undefined, i];
  }
  aclEntry(acl: Acl, t: string[]): string | void {
    const action = t[0] as 'permit' | 'deny'; let i = 1;
    if (!acl.ext) { const a = this.parseAclAddr(t, i); if (!a) return '% Invalid input detected'; acl.entries.push({ action, proto: 'ip', src: a[0], dst: { any: true, ip: '0.0.0.0', wild: '255.255.255.255' }, hits: 0 }); return; }
    const proto = t[i++]; if (!['ip', 'icmp', 'tcp', 'udp'].includes(proto)) return '% Invalid input detected at \'^\' marker.';
    const s = this.parseAclAddr(t, i); if (!s) return '% Invalid source address'; i = s[1];
    let sp: PortM | undefined; [sp, i] = proto === 'tcp' || proto === 'udp' ? this.parsePort(t, i) : [undefined, i];
    const d = this.parseAclAddr(t, i); if (!d) return '% Invalid destination address'; i = d[1];
    let dp: PortM | undefined; [dp, i] = proto === 'tcp' || proto === 'udp' ? this.parsePort(t, i) : [undefined, i];
    acl.entries.push({ action, proto, src: s[0], dst: d[0], sp, dp, hits: 0 });
  }
  getAcl(name: string, ext: boolean): Acl { let a = this.cfg.acls.find(x => x.name === name); if (!a) { a = { name, ext, entries: [] }; this.cfg.acls.push(a); } return a; }
  build(): void {
    const d = this.dev; const net = this.net; const U: Mode[] = ['user', 'priv']; const P: Mode[] = ['priv']; const C: Mode[] = ['config']; const IF: Mode[] = ['if'];
    const sw = isSwitch(d.kind); const cfg = () => d.cfg;
    // ---- exec ----
    this.add(['user'], 'enable', h => { if (h.cfg.secret) { h.s.asking = 'pw'; return; } h.s.mode = 'priv'; });
    this.add(P, 'disable', h => { h.s.mode = 'user'; });
    this.add(['user', 'priv'], 'exit', h => { h.s.mode = 'user'; return 'logout'; });
    this.add(P, 'configure terminal', h => { h.s.mode = 'config'; return 'Enter configuration commands, one per line.  End with CNTL/Z.'; });
    this.add(P, 'configure', h => { h.s.mode = 'config'; return 'Enter configuration commands, one per line.  End with CNTL/Z.'; });
    this.add(U, 'ping <host>', (h, a) => h.ping(a[1])); this.add(U, 'traceroute <host>', (h, a) => h.trace(a[1]));
    this.add(P, 'copy running-config startup-config', h => { net.saveStartup(d); return 'Destination filename [startup-config]? \nBuilding configuration...\n[OK]'; });
    this.add(P, 'write memory', h => { net.saveStartup(d); return 'Building configuration...\n[OK]'; }); this.add(P, 'write', h => { net.saveStartup(d); return 'Building configuration...\n[OK]'; });
    this.add(P, 'erase startup-config', h => { d.startup = null; return 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete'; });
    this.add(P, 'reload', h => { net.powerCycle(d); Cli.reset(d.id); return 'Proceed with reload? [confirm]\n\nReloading...'; });
    this.add(P, 'terminal length <n>', () => {}); this.add(P, 'terminal width <n>', () => {}); this.add(U, 'terminal monitor', () => {});
    this.add(P, 'clear ip nat translation *', () => { d.rt.nat = []; net.touch(); });
    this.add(P, 'clear arp-cache', () => { d.rt.arp = {}; net.touch(); }); this.add(P, 'clear mac address-table dynamic', () => { d.rt.macTable = []; });
    this.add(P, 'clear counters', () => {}); this.add(P, 'clear counters <rest>', () => {});
    this.add(U, 'show running-config', h => S.runningConfig(d, net)); this.add(U, 'show startup-config', () => d.startup ? S.runningConfig(d, net, d.startup) : 'startup-config is not present');
    this.add(U, 'show ip route', () => S.showIpRoute(d, net)); this.add(U, 'show ip route <proto>', (h, a) => S.showIpRoute(d, net, a[3]));
    this.add(U, 'show ip interface brief', () => S.showIpIntBrief(d, net));
    this.add(U, 'show interfaces', () => d.cfg.ifs.map(c => S.showInterface(d, c, net)).join('\n'));
    this.add(U, 'show interfaces <name>', (h, a) => { const n = h.parseIf([a[2]]); const c = n && net.cfgIf(d, n); return c ? S.showInterface(d, c, net) : '% Invalid input detected at \'^\' marker.'; });
    this.add(U, 'show interfaces <name> <num>', (h, a) => { const n = h.parseIf([a[2], a[3]]); const c = n && net.cfgIf(d, n); return c ? S.showInterface(d, c, net) : '% Invalid input detected at \'^\' marker.'; });
    this.add(U, 'show version', () => S.showVersion(d)); this.add(U, 'show clock', () => '*0:12:41.000 UTC Mon Mar 1 1993');
    this.add(U, 'show ip protocols', () => S.showProtocols(d, net)); this.add(U, 'show ip ospf neighbor', () => S.showOspfNbr(d, net)); this.add(U, 'show ip eigrp neighbors', () => S.showEigrpNbr(d, net));
    this.add(U, 'show cdp neighbors', () => S.showCdp(d, net)); this.add(U, 'show arp', () => S.showArp(d)); this.add(U, 'show ip arp', () => S.showArp(d));
    this.add(U, 'show ip nat translations', () => S.showNat(d)); this.add(U, 'show access-lists', () => S.showAcls(d)); this.add(U, 'show ip access-lists', () => S.showAcls(d));
    this.add(U, 'show ip dhcp binding', () => S.showDhcpBinding(d)); this.add(U, 'show history', h => h.s.hist.join('\n'));
    this.add(U, 'show vlan brief', () => S.showVlanBrief(d)); this.add(U, 'show vlan', () => S.showVlanBrief(d)); this.add(U, 'show mac address-table', () => S.showMac(d)); this.add(U, 'show mac-address-table', () => S.showMac(d));
    this.add(U, 'show spanning-tree', () => S.showStp(d, net)); this.add(U, 'show interfaces trunk', () => S.showTrunk(d, net));
    this.add(U, 'show ip dhcp pool', () => d.cfg.dhcpPools.map(p => `Pool ${p.name} :\n Utilization mark (high/low)    : 100 / 0\n Subnet size (first/next)       : 0 / 0\n Total addresses                : 254\n Leased addresses               : ${d.rt.binds.filter(b => b.pool === p.name).length}`).join('\n'));
    // ---- global config ----
    this.add(C, 'hostname <name>', (h, a) => { h.cfg.hostname = a[1]; h.touch(); });
    this.add(C, 'enable secret <pw>', (h, a) => { h.cfg.secret = a[a.length - 1]; }); this.add(C, 'enable secret <lvl> <pw>', (h, a) => { h.cfg.secret = a[3]; }); this.add(C, 'enable password <pw>', (h, a) => { h.cfg.secret = h.cfg.secret ?? a[2]; });
    this.add(C, 'no enable secret', h => { h.cfg.secret = undefined; });
    this.add(C, 'no ip domain-lookup', h => { h.cfg.domainLookup = false; }); this.add(C, 'ip domain-lookup', h => { h.cfg.domainLookup = true; }); this.add(C, 'ip domain-name <n>', () => {});
    this.add(C, 'service password-encryption', () => {}); this.add(C, 'ip classless', () => {}); this.add(C, 'ip cef', () => {}); this.add(C, 'no ip cef', () => {}); this.add(C, 'username <rest>', () => {}); this.add(C, 'crypto <rest>', () => {}); this.add(C, 'ip ssh <rest>', () => {});
    this.add(C, 'banner motd <rest>', (h, a) => { h.cfg.banner = a.slice(2).join(' ').replace(/^(.)(.*)\1$/, '$2'); }); this.add(C, 'cdp run', h => { h.cfg.cdp = true; }); this.add(C, 'no cdp run', h => { h.cfg.cdp = false; });
    this.add(C, 'ip routing', h => { h.cfg.ipRouting = true; h.touch(); }); this.add(C, 'no ip routing', h => { h.cfg.ipRouting = sw ? false : true; h.touch(); });
    this.add(C, 'ip default-gateway <ip>', (h, a) => { if (!isIp(a[2])) return '% Invalid input detected at \'^\' marker.'; h.cfg.defaultGw = a[2]; h.touch(); }); this.add(C, 'no ip default-gateway', h => { h.cfg.defaultGw = undefined; h.touch(); });
    this.add(C, 'spanning-tree mode <m>', () => {}); this.add(C, 'spanning-tree extend system-id', () => {}); this.add(C, 'spanning-tree vlan <v> priority <p>', (h, a) => { h.cfg.stpPrio = Number(a[4]); h.touch(); });
    this.add(C, 'spanning-tree vlan <v> root primary', h => { h.cfg.stpPrio = 24576; h.touch(); }); this.add(C, 'spanning-tree vlan <v> root secondary', h => { h.cfg.stpPrio = 28672; h.touch(); });
    const route = (h: Cli, a: string[], neg: boolean): Out => {
      const mlen = maskToLen(a[3]); if (!isIp(a[2]) || mlen === null) return '% Invalid input detected at \'^\' marker.';
      const nhIsIp = isIp(a[4]); const ifn = nhIsIp ? undefined : h.parseIf(a.slice(4, a.length > 6 ? 6 : 5)) ?? undefined; const ad = Number(a[nhIsIp ? 5 : (a.length > 6 ? 6 : 5)]) || 1;
      if (neg) { h.cfg.statics = h.cfg.statics.filter(r => !(r.net === a[2 + 1 - 1 + 0 + 0] && false)); h.cfg.statics = h.cfg.statics.filter(r => !(r.net === a[3 - 1 + 0] && r.mask === a[3] && (nhIsIp ? r.nh === a[4] : true))); h.touch(); return; }
      if (!nhIsIp && !ifn) return '% Invalid input detected at \'^\' marker.';
      h.cfg.statics.push({ net: a[2], mask: a[3], nh: nhIsIp ? a[4] : undefined, ifn, ad }); h.touch();
    };
    this.add(C, 'ip route <net> <mask> <nh>', (h, a) => route(h, a, false)); this.add(C, 'ip route <net> <mask> <nh> <ad>', (h, a) => route(h, a, false)); this.add(C, 'ip route <net> <mask> <i> <n>', (h, a) => route(h, a, false));
    this.add(C, 'no ip route <net> <mask> <nh>', (h, a) => { const nh = a[5]; h.cfg.statics = h.cfg.statics.filter(r => !(r.net === a[3] && r.mask === a[4] && (r.nh === nh || r.ifn?.toLowerCase().startsWith(nh.toLowerCase())))); h.touch(); });
    this.add(C, 'no ip route <net> <mask>', (h, a) => { h.cfg.statics = h.cfg.statics.filter(r => !(r.net === a[3] && r.mask === a[4])); h.touch(); });
    this.add(C, 'interface <name>', (h, a) => h.enterIf([a[1]])); this.add(C, 'interface <name> <num>', (h, a) => h.enterIf([a[1], a[2]]));
    this.add(C, 'interface range <a> <b> <c>', (h, a) => h.enterRange(a)); this.add(C, 'interface range <a> <b> <c> <d>', (h, a) => h.enterRange(a));
    this.add(C, 'no interface <name>', (h, a) => { const n = h.parseIf([a[2]]); if (n && /^(Loopback|Vlan)|\./.test(n)) { h.cfg.ifs = h.cfg.ifs.filter(i => i.name !== n); h.touch(); } });
    this.add(C, 'no interface <name> <num>', (h, a) => { const n = h.parseIf([a[2], a[3]]); if (n && /^(Loopback|Vlan)|\./.test(n)) { h.cfg.ifs = h.cfg.ifs.filter(i => i.name !== n); h.touch(); } });
    this.add(C, 'line console 0', h => { h.s.mode = 'line'; h.s.line = 'con'; }); this.add(C, 'line vty <a> <b>', h => { h.s.mode = 'line'; h.s.line = 'vty'; });
    this.add(['line'], 'password <pw>', (h, a) => { if (h.s.line === 'con') h.cfg.conPw = a[1]; else h.cfg.vtyPw = a[1]; }); this.add(['line'], 'login', h => { if (h.s.line === 'con') h.cfg.conLogin = true; else h.cfg.vtyLogin = true; });
    this.add(['line'], 'no login', h => { if (h.s.line === 'con') h.cfg.conLogin = false; else h.cfg.vtyLogin = false; }); this.add(['line'], 'transport input <t>', () => {}); this.add(['line'], 'exec-timeout <a> <b>', () => {}); this.add(['line'], 'logging synchronous', () => {});
    this.add(C, 'vlan <id>', (h, a) => { const v = Number(a[1]); if (!sw) return '% Invalid input detected at \'^\' marker.'; if (!(v >= 1 && v <= 4094)) return '% Invalid input detected at \'^\' marker.'; if (!h.cfg.vlans[a[1]]) h.cfg.vlans[a[1]] = { name: `VLAN${String(v).padStart(4, '0')}` }; h.s.mode = 'vlan'; h.s.vlan = v; h.touch(); });
    this.add(C, 'no vlan <id>', (h, a) => { delete h.cfg.vlans[a[2]]; h.touch(); }); this.add(['vlan'], 'name <n>', (h, a) => { h.cfg.vlans[String(h.s.vlan)] = { name: a[1] }; });
    // routing protocols
    this.add(C, 'router rip', h => { h.cfg.rip = h.cfg.rip ?? { version: 1, nets: [], passive: [], defOrig: false, redistStatic: false, redistConn: false }; h.s.mode = 'rip'; h.touch(); });
    this.add(C, 'no router rip', h => { h.cfg.rip = undefined; h.touch(); });
    this.add(C, 'router ospf <pid>', (h, a) => { if (!h.cfg.ospf.length) h.cfg.ospf.push({ pid: Number(a[2]), nets: [], passive: [], defOrig: false, refBw: 100, redistStatic: false, redistConn: false }); h.s.mode = 'ospf'; h.touch(); });
    this.add(C, 'no router ospf <pid>', h => { h.cfg.ospf = []; h.touch(); });
    this.add(C, 'router eigrp <as>', (h, a) => { if (!h.cfg.eigrp.length) h.cfg.eigrp.push({ as: Number(a[2]), nets: [], passive: [], autoSum: true, redistStatic: false, redistConn: false }); h.s.mode = 'eigrp'; h.touch(); });
    this.add(C, 'no router eigrp <as>', h => { h.cfg.eigrp = []; h.touch(); });
    this.add(['rip'], 'version <v>', (h, a) => { h.cfg.rip!.version = Number(a[1]); h.touch(); }); this.add(['rip'], 'network <n>', (h, a) => { if (!isIp(a[1])) return '% Invalid input detected at \'^\' marker.'; if (!h.cfg.rip!.nets.includes(a[1])) h.cfg.rip!.nets.push(a[1]); h.touch(); });
    this.add(['rip'], 'no network <n>', (h, a) => { h.cfg.rip!.nets = h.cfg.rip!.nets.filter(x => x !== a[2]); h.touch(); }); this.add(['rip'], 'passive-interface <n>', (h, a) => { const n = h.parseIf([a[1]]) ?? a[1]; h.cfg.rip!.passive.push(n); h.touch(); });
    this.add(['rip'], 'passive-interface <n> <m>', (h, a) => { h.cfg.rip!.passive.push(h.parseIf([a[1], a[2]]) ?? a[1]); h.touch(); });
    this.add(['rip', 'eigrp'], 'no auto-summary', h => { if (h.cfg.eigrp[0]) h.cfg.eigrp[0].autoSum = false; }); this.add(['rip'], 'auto-summary', () => {});
    this.add(['rip'], 'default-information originate', h => { h.cfg.rip!.defOrig = true; h.touch(); }); this.add(['rip'], 'redistribute static', h => { h.cfg.rip!.redistStatic = true; h.touch(); }); this.add(['rip'], 'redistribute connected', h => { h.cfg.rip!.redistConn = true; h.touch(); });
    this.add(['ospf'], 'router-id <ip>', (h, a) => { h.cfg.ospf[0].rid = a[1]; h.touch(); }); this.add(['ospf'], 'network <n> <w> area <a>', (h, a) => { if (!isIp(a[1]) || wildToLen(a[2]) === null) return '% Invalid input detected at \'^\' marker.'; h.cfg.ospf[0].nets.push({ net: a[1], wild: a[2], area: Number(a[4]) }); h.touch(); });
    this.add(['ospf'], 'no network <n> <w> area <a>', (h, a) => { h.cfg.ospf[0].nets = h.cfg.ospf[0].nets.filter(x => !(x.net === a[2] && x.wild === a[3])); h.touch(); });
    this.add(['ospf'], 'passive-interface <n>', (h, a) => { h.cfg.ospf[0].passive.push(h.parseIf([a[1]]) ?? a[1]); h.touch(); }); this.add(['ospf'], 'passive-interface <n> <m>', (h, a) => { h.cfg.ospf[0].passive.push(h.parseIf([a[1], a[2]]) ?? a[1]); h.touch(); });
    this.add(['ospf'], 'default-information originate', h => { h.cfg.ospf[0].defOrig = true; h.touch(); }); this.add(['ospf'], 'default-information originate always', h => { h.cfg.ospf[0].defOrig = true; h.touch(); });
    this.add(['ospf'], 'auto-cost reference-bandwidth <n>', (h, a) => { h.cfg.ospf[0].refBw = Number(a[2]); h.touch(); }); this.add(['ospf'], 'redistribute static', h => { h.cfg.ospf[0].redistStatic = true; h.touch(); }); this.add(['ospf'], 'redistribute static subnets', h => { h.cfg.ospf[0].redistStatic = true; h.touch(); });
    this.add(['ospf'], 'redistribute connected', h => { h.cfg.ospf[0].redistConn = true; h.touch(); }); this.add(['ospf'], 'redistribute connected subnets', h => { h.cfg.ospf[0].redistConn = true; h.touch(); }); this.add(['ospf'], 'log-adjacency-changes', () => {});
    this.add(['eigrp'], 'network <n>', (h, a) => { h.cfg.eigrp[0].nets.push({ net: a[1] }); h.touch(); }); this.add(['eigrp'], 'network <n> <w>', (h, a) => { h.cfg.eigrp[0].nets.push({ net: a[1], wild: a[2] }); h.touch(); });
    this.add(['eigrp'], 'passive-interface <n>', (h, a) => { h.cfg.eigrp[0].passive.push(h.parseIf([a[1]]) ?? a[1]); h.touch(); }); this.add(['eigrp'], 'passive-interface <n> <m>', (h, a) => { h.cfg.eigrp[0].passive.push(h.parseIf([a[1], a[2]]) ?? a[1]); h.touch(); });
    this.add(['eigrp'], 'redistribute static', h => { h.cfg.eigrp[0].redistStatic = true; h.touch(); }); this.add(['eigrp'], 'redistribute connected', h => { h.cfg.eigrp[0].redistConn = true; h.touch(); }); this.add(['eigrp'], 'eigrp router-id <ip>', () => {});
    // DHCP / NAT / ACL
    this.add(C, 'ip dhcp pool <n>', (h, a) => { if (!h.cfg.dhcpPools.some(p => p.name === a[3])) h.cfg.dhcpPools.push({ name: a[3], net: '0.0.0.0', mask: '0.0.0.0' }); h.s.mode = 'dhcp'; h.s.pool = a[3]; h.touch(); });
    this.add(C, 'no ip dhcp pool <n>', (h, a) => { h.cfg.dhcpPools = h.cfg.dhcpPools.filter(p => p.name !== a[4]); h.touch(); });
    this.add(C, 'ip dhcp excluded-address <a>', (h, a) => { h.cfg.dhcpExcluded.push([a[3], a[3]]); }); this.add(C, 'ip dhcp excluded-address <a> <b>', (h, a) => { h.cfg.dhcpExcluded.push([a[3], a[4]]); });
    const pool = (h: Cli) => h.cfg.dhcpPools.find(p => p.name === h.s.pool)!;
    this.add(['dhcp'], 'network <n> <m>', (h, a) => { if (!isIp(a[1]) || maskToLen(a[2]) === null) return '% Invalid input detected at \'^\' marker.'; pool(h).net = a[1]; pool(h).mask = a[2]; h.touch(); });
    this.add(['dhcp'], 'default-router <ip>', (h, a) => { pool(h).gw = a[1]; }); this.add(['dhcp'], 'dns-server <ip>', (h, a) => { pool(h).dns = a[1]; }); this.add(['dhcp'], 'domain-name <n>', () => {}); this.add(['dhcp'], 'lease <rest>', () => {});
    this.add(C, 'ip nat pool <n> <s> <e> netmask <m>', (h, a) => { h.cfg.natPools.push({ name: a[3], start: a[4], end: a[5], mask: a[7] }); h.touch(); });
    this.add(C, 'ip nat inside source static <l> <g>', (h, a) => { h.cfg.natStatics.push({ local: a[5], global: a[6] }); h.touch(); }); this.add(C, 'no ip nat inside source static <l> <g>', (h, a) => { h.cfg.natStatics = h.cfg.natStatics.filter(s => s.local !== a[6]); h.touch(); });
    this.add(C, 'ip nat inside source list <acl> pool <p>', (h, a) => { h.cfg.natRules.push({ acl: a[5], pool: a[7], overload: false }); h.touch(); });
    this.add(C, 'ip nat inside source list <acl> pool <p> overload', (h, a) => { h.cfg.natRules.push({ acl: a[5], pool: a[7], overload: true }); h.touch(); });
    this.add(C, 'ip nat inside source list <acl> interface <n> overload', (h, a) => { h.cfg.natRules.push({ acl: a[5], ifn: h.parseIf([a[7]]) ?? a[7], overload: true }); h.touch(); });
    this.add(C, 'ip nat inside source list <acl> interface <n> <m> overload', (h, a) => { h.cfg.natRules.push({ acl: a[5], ifn: h.parseIf([a[7], a[8]]) ?? a[7], overload: true }); h.touch(); });
    this.add(C, 'no ip nat inside source <rest>', h => { h.cfg.natRules = []; h.cfg.natStatics = []; h.touch(); });
    this.add(C, 'access-list <n> <rest>', (h, a) => { const num = Number(a[1]); if (!(num >= 1 && num <= 199)) return '% Invalid input detected at \'^\' marker.'; if (!['permit', 'deny'].includes(a[2])) return a[2] === 'remark' ? undefined : '% Invalid input detected at \'^\' marker.'; const acl = h.getAcl(a[1], num >= 100); const r = h.aclEntry(acl, a.slice(2)); h.touch(); return r; });
    this.add(C, 'no access-list <n>', (h, a) => { h.cfg.acls = h.cfg.acls.filter(x => x.name !== a[2]); h.touch(); });
    this.add(C, 'ip access-list standard <n>', (h, a) => { h.getAcl(a[3], false); h.s.mode = 'nacl'; h.s.acl = a[3]; }); this.add(C, 'ip access-list extended <n>', (h, a) => { h.getAcl(a[3], true); h.s.mode = 'nacl'; h.s.acl = a[3]; });
    this.add(C, 'no ip access-list <t> <n>', (h, a) => { h.cfg.acls = h.cfg.acls.filter(x => x.name !== a[4]); h.touch(); });
    this.add(['nacl'], 'permit <rest>', (h, a) => { const r = h.aclEntry(h.cfg.acls.find(x => x.name === h.s.acl)!, a); h.touch(); return r; }); this.add(['nacl'], 'deny <rest>', (h, a) => { const r = h.aclEntry(h.cfg.acls.find(x => x.name === h.s.acl)!, a); h.touch(); return r; }); this.add(['nacl'], 'remark <rest>', () => {});
    // ---- interface ----
    const each = (h: Cli, f: (c: IfCfg) => void): void => { h.ifsSel().forEach(f); h.touch(); };
    this.add(IF, 'shutdown', h => { let m = ''; each(h, c => { const was = h.net.portPhy(d, c.name).up; c.adminUp = false; if (was) m += `\n%LINK-5-CHANGED: Interface ${c.name}, changed state to administratively down\n\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${c.name}, changed state to down`; }); return m || undefined; });
    this.add(IF, 'no shutdown', h => { let m = ''; each(h, c => { c.adminUp = true; }); h.ifsSel().forEach(c => { m += h.linkMsg(c, true); }); return m || undefined; });
    this.add(IF, 'ip address <ip> <mask>', (h, a) => { if (!isIp(a[2]) || maskToLen(a[3]) === null) return '% Invalid input detected at \'^\' marker.'; if (!isUsableHost(a[2], a[3]) && maskToLen(a[3])! < 31) return 'Bad mask /' + maskToLen(a[3]) + ' for address ' + a[2]; const dup = h.cfg.ifs.find(i => i.ip === a[2] && !h.s.ifs.includes(i.name)); if (dup) return `% ${a[2]} overlaps with ${dup.name}`; each(h, c => { c.ip = a[2]; c.mask = a[3]; c.dhcp = false; }); });
    this.add(IF, 'ip address dhcp', h => { each(h, c => { c.dhcp = true; }); }); this.add(IF, 'no ip address', h => { each(h, c => { c.ip = undefined; c.mask = undefined; c.dhcp = false; }); });
    this.add(IF, 'description <rest>', (h, a) => { each(h, c => { c.desc = a.slice(1).join(' '); }); }); this.add(IF, 'no description', h => { each(h, c => { c.desc = undefined; }); });
    this.add(IF, 'duplex <m>', () => {}); this.add(IF, 'speed <m>', () => {}); this.add(IF, 'mdix <rest>', () => {});
    this.add(IF, 'clock rate <n>', (h, a) => { each(h, c => { c.clockRate = Number(a[2]); }); }); this.add(IF, 'no clock rate', h => { each(h, c => { c.clockRate = undefined; }); }); this.add(IF, 'bandwidth <n>', (h, a) => { each(h, c => { c.bandwidth = Number(a[1]); }); }); this.add(IF, 'delay <n>', (h, a) => { each(h, c => { c.delay = Number(a[1]); }); });
    this.add(IF, 'encapsulation dot1Q <v>', (h, a) => { each(h, c => { c.vlan = Number(a[2]); c.vlanNative = false; }); }); this.add(IF, 'encapsulation dot1Q <v> native', (h, a) => { each(h, c => { c.vlan = Number(a[2]); c.vlanNative = true; }); });
    this.add(IF, 'encapsulation <t>', () => {}); this.add(IF, 'ip helper-address <ip>', (h, a) => { each(h, c => { if (!c.helper.includes(a[2])) c.helper.push(a[2]); }); }); this.add(IF, 'no ip helper-address <ip>', (h, a) => { each(h, c => { c.helper = c.helper.filter(x => x !== a[3]); }); });
    this.add(IF, 'ip access-group <n> in', (h, a) => { each(h, c => { c.aclIn = a[2]; }); }); this.add(IF, 'ip access-group <n> out', (h, a) => { each(h, c => { c.aclOut = a[2]; }); });
    this.add(IF, 'no ip access-group <n> in', h => { each(h, c => { c.aclIn = undefined; }); }); this.add(IF, 'no ip access-group <n> out', h => { each(h, c => { c.aclOut = undefined; }); });
    this.add(IF, 'ip nat inside', h => { each(h, c => { c.nat = 'inside'; }); }); this.add(IF, 'ip nat outside', h => { each(h, c => { c.nat = 'outside'; }); }); this.add(IF, 'no ip nat <x>', h => { each(h, c => { c.nat = undefined; }); });
    this.add(IF, 'ip ospf cost <n>', (h, a) => { each(h, c => { c.ospfCost = Number(a[3]); }); }); this.add(IF, 'ip ospf priority <n>', (h, a) => { each(h, c => { c.ospfPrio = Number(a[3]); }); });
    this.add(IF, 'switchport mode access', h => { each(h, c => { c.swMode = 'access'; }); }); this.add(IF, 'switchport mode trunk', h => { each(h, c => { c.swMode = 'trunk'; }); });
    this.add(IF, 'switchport access vlan <v>', (h, a) => { const v = Number(a[3]); let m = ''; if (!h.cfg.vlans[a[3]]) { h.cfg.vlans[a[3]] = { name: `VLAN${String(v).padStart(4, '0')}` }; m = `% Access VLAN does not exist. Creating vlan ${v}`; } each(h, c => { c.accessVlan = v; c.swMode = 'access'; }); return m || undefined; });
    this.add(IF, 'switchport trunk native vlan <v>', (h, a) => { each(h, c => { c.nativeVlan = Number(a[4]); }); }); this.add(IF, 'switchport trunk allowed vlan <l>', (h, a) => { each(h, c => { c.allowed = a[4] === 'all' ? '' : a[4]; }); });
    this.add(IF, 'switchport trunk allowed vlan add <l>', (h, a) => { each(h, c => { c.allowed = c.allowed ? c.allowed + ',' + a[5] : ''; }); }); this.add(IF, 'switchport trunk encapsulation <e>', () => {});
    this.add(IF, 'switchport nonegotiate', () => {}); this.add(IF, 'switchport port-security <rest>', () => {}); this.add(IF, 'switchport', h => { each(h, c => { c.routed = false; }); }); this.add(IF, 'no switchport', h => { if (d.kind !== 'l3switch') return '% Invalid input detected at \'^\' marker.'; each(h, c => { c.routed = true; }); });
    this.add(IF, 'spanning-tree portfast', h => { each(h, c => { c.portfast = true; }); }); this.add(IF, 'spanning-tree <rest>', () => {});
    this.add(IF, 'no <rest>', () => {}); this.add(C, 'no <rest>', () => {});
    // ---- mode movement ----
    this.add(['if', 'line', 'rip', 'ospf', 'eigrp', 'vlan', 'dhcp', 'nacl'], 'exit', h => { h.s.mode = 'config'; h.s.ifs = []; }); this.add(['config'], 'exit', h => { h.s.mode = 'priv'; });
    this.add(['config', 'if', 'line', 'rip', 'ospf', 'eigrp', 'vlan', 'dhcp', 'nacl'], 'end', h => { h.s.mode = 'priv'; h.s.ifs = []; return ''; });
    void isRouting; void routingInfo; void lenToMask; void fmtIp; void parseIp;
  }
  enterIf(toks: string[]): Out {
    const n = this.parseIf(toks); if (!n) return `% Invalid input detected at '^' marker.`;
    const c = this.selectIf(n); if (typeof c === 'string') return `% Invalid input detected at '^' marker.`;
    this.s.mode = 'if'; this.s.ifs = [c.name];
  }
  enterRange(a: string[]): Out {
    const rest = a.slice(2).join(' ').toLowerCase(); const m = /^([a-z]+)\s*(\d+)\/(\d+)\s*-\s*(?:[a-z]+\s*\d+\/)?(\d+)$/.exec(rest);
    if (!m) return `% Invalid input detected at '^' marker.`;
    const t = IFT.find(([k]) => k.startsWith(m[1])); if (!t) return `% Invalid input detected at '^' marker.`;
    const names: string[] = []; for (let i = Number(m[3]); i <= Number(m[4]); i++) { const nm = `${t[1]}${m[2]}/${i}`; if (this.net.cfgIf(this.dev, nm)) names.push(nm); }
    if (!names.length) return `% Invalid input detected at '^' marker.`; this.s.mode = 'if'; this.s.ifs = names;
  }
}

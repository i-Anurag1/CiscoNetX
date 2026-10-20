import type { Dev } from '../model/types.ts';
import type { Net } from '../model/net.ts';
import { dhcpAcquire, dnsResolve, echoOnce, finalize, nicOf, Trace, traceroute, type PingResult } from '../sim/engine.ts';
import { isIp, maskToLen } from '../lib/ip.ts';
import type { TraceHook } from './cli.ts';

export const linkLocal = (mac: string): string => { const h = mac.replace(/\./g, '').toUpperCase(); const b = (parseInt(h.slice(0, 2), 16) ^ 2).toString(16).toUpperCase().padStart(2, '0'); return `FE80::${b}${h.slice(2, 4)}:${h.slice(4, 6)}FF:FE${h.slice(6, 8)}:${h.slice(8, 12)}`; };
export function ipconfigText(net: Net, d: Dev, all: boolean): string {
  const nic = nicOf(net, d); if (!nic) return 'No network adapter.';
  const up = nic.up; const ip = up && nic.ip !== '0.0.0.0' ? nic.ip : '0.0.0.0'; const mask = ip === '0.0.0.0' ? '0.0.0.0' : nic.mask;
  const L = [`FastEthernet0 Connection:(default port)`, ''];
  if (all) L.push('   Connection-specific DNS Suffix..:', '   Physical Address................: ' + nic.mac.replace(/\./g, '-').replace(/(..)(..)-(..)(..)-(..)(..)/, '$1-$2-$3-$4-$5-$6'), '   Link-local IPv6 Address.........: ' + linkLocal(nic.mac), '   IPv6 Address....................: ::', `   IPv4 Address....................: ${ip}`, `   Subnet Mask.....................: ${mask}`, `   Default Gateway.................: ::`, `                                     ${d.cfg.hostGw ?? '0.0.0.0'}`, `   DHCP Servers....................: ${d.cfg.hostDhcp ? d.cfg.hostGw ?? '0.0.0.0' : '0.0.0.0'}`, `   DNS Servers.....................: ${d.cfg.hostDns ?? '0.0.0.0'}`);
  else L.push('   Connection-specific DNS Suffix..:', '   Link-local IPv6 Address.........: ' + linkLocal(nic.mac), '   IPv6 Address....................: ::', `   IPv4 Address....................: ${ip}`, `   Subnet Mask.....................: ${mask}`, '   Default Gateway.................: ::', `                                     ${d.cfg.hostGw ?? '0.0.0.0'}`);
  return L.join('\n');
}
export class HostShell {
  net: Net; dev: Dev; hook: TraceHook;
  constructor(net: Net, dev: Dev, hook: TraceHook = async () => {}) { this.net = net; this.dev = dev; this.hook = hook; }
  async exec(line: string): Promise<string> {
    const t = line.trim().split(/\s+/).filter(Boolean); if (!t.length) return '';
    const cmd = t[0].toLowerCase(); const d = this.dev; const net = this.net;
    if (cmd === 'ping') return this.ping(t);
    if (cmd === 'tracert' || cmd === 'traceroute') return this.tracert(t);
    if (cmd === 'ipconfig') {
      const f = (t[1] ?? '').toLowerCase();
      if (f === '/all') return ipconfigText(net, d, true);
      if (f === '/release') { const c = nicOf(net, d); if (c) { const ic = net.cfgIf(d, c.name)!; ic.ip = undefined; ic.mask = undefined; d.cfg.hostGw = undefined; net.touch(); } return ipconfigText(net, d, false); }
      if (f === '/renew') { const r = dhcpAcquire(net, d); await this.hook(r.trace); return r.result.ok ? ipconfigText(net, d, false) : 'DHCP request failed.'; }
      if (f === '') return ipconfigText(net, d, false);
      return 'Invalid Command.';
    }
    if (cmd === 'arp' && (t[1] ?? '').toLowerCase() === '-a') {
      const e = Object.entries(d.rt.arp); if (!e.length) return 'No ARP Entries Found';
      return ['  Internet Address      Physical Address      Type', ...e.map(([ip, v]) => `  ${ip.padEnd(22)}${v.mac.replace(/\./g, '-').replace(/(..)(..)-(..)(..)-(..)(..)/, '$1-$2-$3-$4-$5-$6').toLowerCase().padEnd(22)}dynamic`)].join('\n');
    }
    if (cmd === 'nslookup') {
      if (!t[1]) return 'Usage: nslookup <name>'; const tr = new Trace(net); const r = dnsResolve(tr, d, t[1], 0); finalize(tr); await this.hook(tr);
      return `Server:  ${d.cfg.hostDns ?? '[none]'}\nAddress:  ${d.cfg.hostDns ?? ''}\n\n` + (r.ip ? `Non-authoritative answer:\nName:    ${t[1]}\nAddress:  ${r.ip}` : `*** ${r.error ?? 'can\'t find ' + t[1]}`);
    }
    if (cmd === 'help' || cmd === '?') return 'Available Commands:\n  arp          ipconfig     nslookup     ping         tracert\n  hostname     help         cls';
    if (cmd === 'hostname') return d.name;
    if (cmd === 'cls') return '\u0000CLS';
    return 'Invalid Command.';
  }
  private async resolve(target: string, tr: Trace): Promise<string | null> { const r = dnsResolve(tr, this.dev, target, 0); return r.ip; }
  async ping(t: string[]): Promise<string> {
    let count = 4, size = 32; const rest: string[] = [];
    for (let i = 1; i < t.length; i++) { if (t[i] === '-n') count = Number(t[++i]) || 4; else if (t[i] === '-l') size = Number(t[++i]) || 32; else if (t[i] === '-t') count = 4; else rest.push(t[i]); }
    const target = rest[0]; if (!target) return 'Usage: ping [-n count] [-l size] target_name';
    const tr = new Trace(this.net); let dst = target;
    if (!isIp(target)) { const ip = await this.resolve(target, tr); if (!ip) { finalize(tr); await this.hook(tr); return 'Ping request could not find host ' + target + '. Please check the name and try again.'; } dst = ip; }
    const res: PingResult[] = []; let t0 = tr.events.length ? 1 : 0;
    for (let i = 0; i < count; i++) res.push(echoOnce(tr, this.dev, dst, i + 1, t0 + i, { size }));
    finalize(tr); await this.hook(tr);
    const L = [`Pinging ${dst} with ${size} bytes of data:`, ''];
    for (const r of res) {
      if (r.status === 'reply') L.push(`Reply from ${r.from}: bytes=${r.bytes} time=${(r.ms ?? 0) < 1 ? '<1' : r.ms}ms TTL=${r.ttl}`.replace('time=<1ms', 'time<1ms'));
      else if (r.status === 'timeout') L.push('Request timed out.');
      else L.push(`Reply from ${r.from}: Destination host unreachable.`);
    }
    const ok = res.filter(r => r.status === 'reply'); const ms = ok.map(r => r.ms ?? 0);
    L.push('', `Ping statistics for ${dst}:`, `    Packets: Sent = ${count}, Received = ${ok.length}, Lost = ${count - ok.length} (${Math.round(((count - ok.length) / count) * 100)}% loss),`);
    if (ok.length) L.push('Approximate round trip times in milli-seconds:', `    Minimum = ${Math.min(...ms)}ms, Maximum = ${Math.max(...ms)}ms, Average = ${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)}ms`);
    return L.join('\n');
  }
  async tracert(t: string[]): Promise<string> {
    const target = t[1]; if (!target) return 'Usage: tracert target_name'; const pre = new Trace(this.net); let dst = target;
    if (!isIp(target)) { const ip = await this.resolve(target, pre); if (!ip) return 'Unable to resolve target system name ' + target + '.'; dst = ip; }
    const r = traceroute(this.net, this.dev, dst); await this.hook(r.trace);
    const L = [`Tracing route to ${dst} over a maximum of 30 hops:`, ''];
    for (const h of r.hops) L.push(`  ${String(h.hop).padEnd(3)}${h.addr ? h.ms.map(m => (m < 1 ? '<1 ms' : m + ' ms').padEnd(8)).join('') + ' ' + h.addr : '*        *        *        Request timed out.'}`);
    L.push('', 'Trace complete.'); return L.join('\n');
  }
}
void maskToLen;

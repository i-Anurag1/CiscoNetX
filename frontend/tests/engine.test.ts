import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Net } from '../src/model/net.ts';
import { SAMPLES } from '../src/lib/samples.ts';
import { ping, httpGet, dhcpAcquire } from '../src/sim/engine.ts';
import { Cli } from '../src/ios/cli.ts';
import { HostShell } from '../src/ios/host.ts';
import { subnetInfo, maskToLen, parseIp } from '../src/lib/ip.ts';

const byName = (n: Net, name: string) => { const d = n.devByName(name); assert.ok(d, `device ${name}`); return d; };
async function build(id: string): Promise<Net> { Cli.resetAll(); const n = new Net(); await SAMPLES.find(s => s.id === id)!.build(n); n.settle(); return n; }
const ok = (n: Net, from: string, to: string, count = 4) => { const r = ping(n, byName(n, from), to, { count }); return r.results.filter(x => x.status === 'reply').length; };

test('ip helpers', () => {
  assert.equal(parseIp('192.168.1.1'), 3232235777); assert.equal(parseIp('300.1.1.1'), null); assert.equal(maskToLen('255.255.255.192'), 26); assert.equal(maskToLen('255.0.255.0'), null);
  const s = subnetInfo('192.168.10.77', 26)!; assert.equal(s.network, '192.168.10.64'); assert.equal(s.broadcast, '192.168.10.127'); assert.equal(s.hosts, 62);
});
test('basic LAN: first ping times out on ARP, then succeeds', async () => {
  const n = await build('lan'); const r = ping(n, byName(n, 'PC0'), '192.168.1.11', { count: 4 });
  assert.equal(r.results[0].status, 'timeout'); assert.equal(r.results.filter(x => x.status === 'reply').length, 3);
});
test('static routes connect two LANs', async () => {
  const n = await build('static'); ping(n, byName(n, 'PC0'), '192.168.2.10', { count: 2 }); assert.equal(ok(n, 'PC0', '192.168.2.10'), 4);
  assert.equal(ping(n, byName(n, 'PC0'), '192.168.2.10', { count: 1 }).results[0].ttl, 126);
});
test('VLAN isolation and router-on-a-stick', async () => {
  const n = await build('vlan'); ping(n, byName(n, 'PC0'), '192.168.20.10', { count: 3 }); assert.equal(ok(n, 'PC0', '192.168.20.10'), 4);
  assert.equal(ok(n, 'PC0', '192.168.10.11') >= 3, true);
  const sw = byName(n, 'Switch0'); n.cfgIf(sw, 'FastEthernet0/11')!.accessVlan = 10; n.touch(); const r = ping(n, byName(n, 'PC0'), '192.168.10.10', { count: 1 }); assert.ok(r);
});
test('OSPF triangle converges and survives a link failure', async () => {
  const n = await build('ospf'); ping(n, byName(n, 'PC0'), '192.168.3.10', { count: 3 }); assert.equal(ok(n, 'PC0', '192.168.3.10'), 4);
  const cli = new Cli(n, byName(n, 'Router0')); cli.s.asking = null; await cli.exec('en'); const rt = await cli.exec('show ip route'); assert.match(rt, /O\s+192\.168\.3\.0\/24/);
  const r1 = byName(n, 'Router0'); n.cfgIf(r1, 'GigabitEthernet0/1')!.adminUp = false; n.touch(); ping(n, byName(n, 'PC0'), '192.168.3.10', { count: 3 }); assert.equal(ok(n, 'PC0', '192.168.3.10'), 4);
});
test('DHCP + DNS + HTTP', async () => {
  const n = await build('services'); const a = byName(n, 'PC0'); const d = dhcpAcquire(n, a); assert.equal(d.result.ok, true); assert.equal(d.result.ip, '192.168.1.100');
  const h = httpGet(n, a, 'http://www.cisconetx.local'); assert.equal(h.result.ok, true); assert.match(h.result.body ?? '', /Welcome/);
  assert.equal(httpGet(n, a, 'http://nosuch.local').result.ok, false);
});
test('NAT overload and default route', async () => {
  const n = await build('nat'); ping(n, byName(n, 'PC0'), '203.0.113.10', { count: 3 }); assert.equal(ok(n, 'PC0', '203.0.113.10'), 4);
  const cli = new Cli(n, byName(n, 'Router0')); cli.s.asking = null; await cli.exec('en'); assert.match(await cli.exec('show ip nat translations'), /198\.51\.100\.2/);
});
test('ACL blocks traffic with administratively prohibited reply', async () => {
  const n = await build('static'); const r2 = byName(n, 'Router1'); const c = new Cli(n, r2); c.s.asking = null;
  for (const l of ['en', 'conf t', 'access-list 100 deny icmp 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255', 'access-list 100 permit ip any any', 'interface g0/1', 'ip access-group 100 in', 'end']) await c.exec(l);
  ping(n, byName(n, 'PC0'), '192.168.2.10', { count: 2 }); const r = ping(n, byName(n, 'PC0'), '192.168.2.10', { count: 2 }); assert.ok(r.results.every(x => x.status !== 'reply'));
});
test('cable rules: wrong cable gives red link; switch auto-MDIX; console', () => {
  const n = new Net(); const a = n.addDevice('PC-PT', 0, 0), b = n.addDevice('PC-PT', 0, 0), s = n.addDevice('2960-24TT', 0, 0), r = n.addDevice('1941', 0, 0);
  n.connect('straight', { dev: a.id, port: 'FastEthernet0' }, { dev: b.id, port: 'FastEthernet0' }); assert.equal(n.portPhy(a, 'FastEthernet0').color, 'red');
  assert.equal(n.connect('console', { dev: a.id, port: 'RS 232' }, { dev: r.id, port: 'Console' }).ok, true);
  assert.equal(n.connect('straight', { dev: s.id, port: 'FastEthernet0/1' }, { dev: r.id, port: 'GigabitEthernet0/0' }).ok, true);
  assert.equal(n.connect('serialdce', { dev: s.id, port: 'FastEthernet0/2' }, { dev: r.id, port: 'GigabitEthernet0/1' }).ok, false);
});
test('serial link needs clock rate and power-off module install', async () => {
  const n = new Net(); const a = n.addDevice('2911', 0, 0), b = n.addDevice('2911', 0, 0); a.power = false; b.power = false;
  assert.equal(n.setModule(a, 0, 'HWIC-2T'), null); assert.equal(n.setModule(b, 0, 'HWIC-2T'), null); n.setPower(a, true); n.setPower(b, true);
  assert.equal(n.connect('auto', { dev: a.id, port: 'Serial0/0/0' }, { dev: b.id, port: 'Serial0/0/0' }).ok, true);
  for (const [d, ip] of [[a, '10.1.1.1'], [b, '10.1.1.2']] as const) { const c = new Cli(n, d); c.s.asking = null; for (const l of ['en', 'conf t', 'int s0/0/0', `ip address ${ip} 255.255.255.252`, 'no shutdown', 'end']) await c.exec(l); }
  assert.equal(n.portPhy(a, 'Serial0/0/0').proto, false);
  const ca = new Cli(n, a); ca.s.asking = null; for (const l of ['en', 'conf t', 'int s0/0/0', 'clock rate 64000', 'end']) await ca.exec(l);
  assert.equal(n.portPhy(a, 'Serial0/0/0').proto, true); assert.equal((await ca.exec('ping 10.1.1.2')).includes('!'), true);
});
test('IOS CLI: abbreviations, errors, help, running-config, host shell', async () => {
  const n = await build('static'); const r = byName(n, 'Router0'); const c = new Cli(n, r); c.s.asking = null;
  assert.equal(c.prompt(), 'R1>'); await c.exec('en'); assert.equal(c.prompt(), 'R1#');
  assert.match(await c.exec('sh ip int br'), /GigabitEthernet0\/0\s+192\.168\.1\.1\s+YES manual up\s+up/);
  assert.match(await c.exec('show ip rout'), /S\s+192\.168\.2\.0\/24 \[1\/0\] via 10\.0\.0\.2/);
  assert.match(await c.exec('sho foo'), /Invalid input/); assert.match(await c.exec('show'), /Incomplete/);
  await c.exec('conf t'); assert.equal(c.prompt(), 'R1(config)#'); await c.exec('int g0/0'); assert.equal(c.prompt(), 'R1(config-if)#'); await c.exec('end');
  assert.match(await c.exec('show running-config'), /ip route 192\.168\.2\.0 255\.255\.255\.0 10\.0\.0\.2/);
  await c.exec('copy run start'); assert.ok(r.startup); assert.match(c.help('show ip '), /route/);
  const hs = new HostShell(n, byName(n, 'PC0')); assert.match(await hs.exec('ipconfig'), /192\.168\.1\.10/); assert.match(await hs.exec('ping 192.168.1.1'), /Reply from 192\.168\.1\.1/); assert.match(await hs.exec('tracert 192.168.2.10'), /Trace complete/);
  assert.equal(await hs.exec('bogus'), 'Invalid Command.');
});
test('save/load round trip keeps behaviour', async () => {
  const n = await build('static'); const s = n.snapshot(); const m = new Net(); m.restore(s); m.settle(); ping(m, byName(m, 'PC0'), '192.168.2.10', { count: 2 }); assert.equal(ok(m, 'PC0', '192.168.2.10'), 4);
});
test('STP blocks a redundant link', () => {
  const n = new Net(); const a = n.addDevice('2960-24TT', 0, 0), b = n.addDevice('2960-24TT', 0, 0);
  n.connect('auto', { dev: a.id, port: 'FastEthernet0/1' }, { dev: b.id, port: 'FastEthernet0/1' }); n.connect('auto', { dev: a.id, port: 'FastEthernet0/2' }, { dev: b.id, port: 'FastEthernet0/2' }); n.settle();
  const states = [a, b].flatMap(d => ['FastEthernet0/1', 'FastEthernet0/2'].map(p => n.portPhy(d, p).stp)); assert.equal(states.filter(x => x === 'blk').length, 1);
});

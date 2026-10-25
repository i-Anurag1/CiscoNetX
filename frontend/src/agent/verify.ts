import { Cli } from '../ios/cli.ts';
import type { Net } from '../model/net.ts';
import type { Dev } from '../model/types.ts';
import { inNet, parseIp } from '../lib/ip.ts';
import { httpGet, nicOf, ping, traceroute, type PingResult } from '../sim/engine.ts';
import { routingInfo } from '../sim/routing.ts';
import type { Plan, PlanCheck } from './plan.ts';
import { parseCidr } from './ipam.ts';

export interface CheckResult {
  check: PlanCheck;
  passed: boolean;
  actual: 'pass' | 'fail';
  detail: string;
  sent: number;
  received: number;
}

export interface Evidence {
  key: string;
  command: string;
  why: string;
  output: string;
}

export interface PathProbe {
  ok: boolean;
  path: string[];
  received: number;
}

export interface FailoverResult {
  srcHost: string;
  dstHost: string;
  linkLabel: string;
  canReroute: boolean;
  before: PathProbe;
  during: PathProbe;
  after: PathProbe;
  rerouted: boolean;
  passed: boolean;
  summary: string;
}

export interface Score {
  passed: number;
  total: number;
  percent: number;
}

export function addressOf(net: Net, key: string): string {
  const dev = net.devByName(key);
  if (!dev) {
    return '';
  }
  const nic = nicOf(net, dev);
  if (!nic || nic.ip === '0.0.0.0') {
    return '';
  }
  return nic.ip;
}

export function pingWithWarmup(
  net: Net,
  dev: Dev,
  target: string,
): { sent: number; received: number; results: PingResult[] } {
  ping(net, dev, target, { count: 2 });
  const measured = ping(net, dev, target, { count: 4 });
  let received = 0;
  for (const item of measured.results) {
    if (item.status === 'reply') {
      received += 1;
    }
  }
  return { sent: measured.results.length, received, results: measured.results };
}

function finish(check: PlanCheck, actual: 'pass' | 'fail', detail: string, sent: number, received: number): CheckResult {
  return { check, passed: actual === check.expect, actual, detail, sent, received };
}

function describePing(results: PingResult[], received: number): string {
  if (received > 0) {
    const last = results[results.length - 1];
    const ttl = last && last.ttl !== undefined ? `, TTL ${last.ttl}` : '';
    return `${received}/4 replies${ttl}`;
  }
  const first = results[0];
  if (!first) {
    return 'no reply';
  }
  if (first.status === 'unreach') {
    return `destination unreachable from ${first.from ?? 'a router'}`;
  }
  if (first.status === 'noroute') {
    return 'no route or gateway on the sending host';
  }
  if (first.status === 'ttl') {
    return 'TTL expired (routing loop)';
  }
  return 'request timed out';
}

export function runCheck(net: Net, check: PlanCheck): CheckResult {
  const source = net.devByName(check.from);
  if (!source) {
    return finish(check, 'fail', `${check.from} does not exist`, 0, 0);
  }

  if (check.kind === 'ping') {
    let target = check.toIp ?? '';
    if (!target && check.toKey) {
      target = addressOf(net, check.toKey);
    }
    if (!target) {
      return finish(check, 'fail', 'the destination has no IP address', 0, 0);
    }
    const outcome = pingWithWarmup(net, source, target);
    const actual = outcome.received === outcome.sent ? 'pass' : 'fail';
    const partial = outcome.received > 0 && outcome.received < outcome.sent;
    const detail = partial ? `only ${outcome.received}/${outcome.sent} replies` : describePing(outcome.results, outcome.received);
    return finish(check, actual, detail, outcome.sent, outcome.received);
  }

  if (check.kind === 'http') {
    const address = check.url ?? '';
    let outcome = httpGet(net, source, address);
    if (!outcome.result.ok) {
      outcome = httpGet(net, source, address);
    }
    if (outcome.result.ok) {
      return finish(check, 'pass', `HTTP ${outcome.result.status ?? 200} from ${outcome.result.ip ?? ''}`, 1, 1);
    }
    return finish(check, 'fail', outcome.result.error ?? 'request failed', 1, 0);
  }

  if (check.kind === 'dhcp') {
    const nic = nicOf(net, source);
    const cidr = check.prefix ? parseCidr(check.prefix) : null;
    if (!nic || nic.ip === '0.0.0.0') {
      return finish(check, 'fail', 'no lease received', 1, 0);
    }
    const inside = cidr ? inNet(nic.ip, cidr.network, cidr.prefix) : true;
    if (inside && source.cfg.hostDhcp) {
      return finish(check, 'pass', `leased ${nic.ip}`, 1, 1);
    }
    return finish(check, 'fail', `address ${nic.ip} is not a lease from ${check.prefix ?? 'the pool'}`, 1, 0);
  }

  const cidr = check.prefix ? parseCidr(check.prefix) : null;
  if (!cidr) {
    return finish(check, 'fail', 'bad prefix in the check', 0, 0);
  }
  const wanted = parseIp(cidr.network);
  const routes = routingInfo(net).routes.get(source.id) ?? [];
  const codes = check.codes ?? [];
  for (const route of routes) {
    if (route.net === wanted && route.len === cidr.prefix && codes.includes(route.code)) {
      const via = route.nh ? ` via ${route.nh}` : ` on ${route.ifn}`;
      return finish(check, 'pass', `${route.code} route${via}`, 1, 1);
    }
  }
  return finish(check, 'fail', `no ${codes.join('/')} route to ${check.prefix}`, 1, 0);
}

export function runChecks(net: Net, plan: Plan, onResult?: (result: CheckResult, index: number) => void): CheckResult[] {
  const results: CheckResult[] = [];
  plan.checks.forEach((check, index) => {
    const outcome = runCheck(net, check);
    results.push(outcome);
    if (onResult) {
      onResult(outcome, index);
    }
  });
  return results;
}

export function scoreOf(results: CheckResult[]): Score {
  let passed = 0;
  for (const item of results) {
    if (item.passed) {
      passed += 1;
    }
  }
  const total = results.length;
  const percent = total === 0 ? 100 : Math.round((passed / total) * 100);
  return { passed, total, percent };
}

export async function gatherEvidence(net: Net, plan: Plan): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  for (const item of plan.show) {
    const dev = net.devByName(item.key);
    if (!dev) {
      continue;
    }
    const cli = Cli.detached(net, dev);
    const output = await cli.exec(`do ${item.command}`);
    evidence.push({ key: item.key, command: item.command, why: item.why, output: output.trim() });
  }
  return evidence;
}

export function nameHops(net: Net): Map<string, string> {
  const names = new Map<string, string>();
  for (const dev of net.devices) {
    for (const iface of net.l3ifs(dev)) {
      names.set(iface.ip, dev.name);
    }
    const nic = nicOf(net, dev);
    if (nic && nic.ip !== '0.0.0.0' && !names.has(nic.ip)) {
      names.set(nic.ip, dev.name);
    }
  }
  return names;
}

function probe(net: Net, srcName: string, target: string): PathProbe {
  const src = net.devByName(srcName);
  if (!src || !target) {
    return { ok: false, path: [], received: 0 };
  }
  const outcome = pingWithWarmup(net, src, target);
  const names = nameHops(net);
  const trace = traceroute(net, src, target);
  const path: string[] = [src.name];
  for (const hop of trace.hops) {
    if (hop.addr) {
      path.push(names.get(hop.addr) ?? hop.addr);
    }
  }
  return { ok: outcome.received === outcome.sent, path, received: outcome.received };
}

function isRouterKey(plan: Plan, key: string): boolean {
  const device = plan.devices.find(item => item.key === key);
  return device !== undefined && device.role === 'router';
}

function linksUsedByPath(plan: Plan, path: string[]): number[] {
  const used: number[] = [];
  for (let index = 0; index + 1 < path.length; index++) {
    const first = path[index];
    const second = path[index + 1];
    if (!isRouterKey(plan, first) || !isRouterKey(plan, second)) {
      continue;
    }
    plan.links.forEach((link, linkIndex) => {
      const forward = link.a === first && link.b === second;
      const backward = link.a === second && link.b === first;
      if ((forward || backward) && !used.includes(linkIndex)) {
        used.push(linkIndex);
      }
    });
  }
  return used;
}

function connectedWithout(plan: Plan, skip: number, from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const curr = queue.shift() as string;
    if (curr === to) {
      return true;
    }
    plan.links.forEach((link, index) => {
      if (index === skip) {
        return;
      }
      if (!isRouterKey(plan, link.a) || !isRouterKey(plan, link.b)) {
        return;
      }
      let next = '';
      if (link.a === curr) {
        next = link.b;
      } else if (link.b === curr) {
        next = link.a;
      }
      if (next !== '' && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    });
  }
  return false;
}

export function runFailover(net: Net, plan: Plan): FailoverResult | null {
  const failover = plan.failover;
  if (!failover) {
    return null;
  }
  const target = addressOf(net, failover.dstHost);
  const before = probe(net, failover.srcHost, target);

  const pinned = plan.spec.failLink.length === 2;
  const used = linksUsedByPath(plan, before.path);
  let linkIndex = failover.linkIndex;
  if (!pinned && !used.includes(linkIndex) && used.length > 0) {
    linkIndex = used[0];
  }

  const link = plan.links[linkIndex];
  const dev = net.devByName(link.a);
  const iface = dev ? net.cfgIf(dev, link.pa) : undefined;
  if (!dev || !iface) {
    return null;
  }

  const routersOnPath = before.path.filter(name => isRouterKey(plan, name));
  const srcRouter = routersOnPath[0] ?? link.a;
  const dstRouter = routersOnPath[routersOnPath.length - 1] ?? link.b;
  const dynamic = plan.spec.routing === 'ospf' || plan.spec.routing === 'rip' || plan.spec.routing === 'eigrp';
  const onPath = used.includes(linkIndex);
  const canReroute = dynamic && connectedWithout(plan, linkIndex, srcRouter, dstRouter);

  iface.adminUp = false;
  net.touch();
  const during = probe(net, failover.srcHost, target);

  iface.adminUp = true;
  net.touch();
  net.settle();
  const after = probe(net, failover.srcHost, target);

  const rerouted = during.ok && during.path.join('>') !== before.path.join('>');
  let passed = false;
  let summary = '';
  if (!onPath) {
    passed = before.ok && during.ok && after.ok;
    summary = passed
      ? 'That link carried no traffic on the active path, so the connection stayed up while it was down.'
      : 'The connection did not stay up although the failed link was not on the active path.';
  } else if (canReroute) {
    passed = before.ok && during.ok && rerouted && after.ok;
    summary = passed
      ? `Traffic moved from ${before.path.join(' > ')} to ${during.path.join(' > ')} when the link failed, and returned after it was restored.`
      : 'The backup path did not take over as expected.';
  } else {
    passed = before.ok && !during.ok && after.ok;
    summary = passed
      ? 'With no alternative path the connection stopped while the link was down and recovered when it came back.'
      : 'The link failure did not behave as expected.';
  }

  return {
    srcHost: failover.srcHost,
    dstHost: failover.dstHost,
    linkLabel: link.label,
    canReroute: onPath && canReroute,
    before,
    during,
    after,
    rerouted,
    passed,
    summary,
  };
}

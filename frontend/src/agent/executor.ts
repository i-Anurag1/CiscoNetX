import { Cli } from '../ios/cli.ts';
import { modelOf } from '../model/catalog.ts';
import type { Net } from '../model/net.ts';
import type { Dev } from '../model/types.ts';
import { dhcpAcquire } from '../sim/engine.ts';
import type { Plan, PlanDevice } from './plan.ts';

export type RunEvent =
  | { kind: 'device'; key: string; index: number; total: number }
  | { kind: 'cable'; index: number; total: number; label: string }
  | { kind: 'services'; key: string }
  | { kind: 'config'; key: string; index: number; total: number; lines: number }
  | { kind: 'dhcp'; key: string; ok: boolean; ip: string }
  | { kind: 'settle' };

export interface ExecOptions {
  onEvent?: (event: RunEvent) => void;
  pause?: (kind: RunEvent['kind']) => Promise<void>;
  signal?: { cancelled: boolean };
}

export interface CommandIssue {
  key: string;
  command: string;
  output: string;
}

export interface ExecResult {
  devices: Record<string, string>;
  errors: string[];
  commandIssues: CommandIssue[];
  dhcpFailures: string[];
  cancelled: boolean;
}

export function looksLikeError(output: string): boolean {
  return /^% |^Bad mask/m.test(output);
}

export async function runLines(
  net: Net,
  dev: Dev,
  lines: string[],
  onIssue?: (command: string, output: string) => void,
): Promise<number> {
  const cli = Cli.detached(net, dev);
  let issues = 0;
  for (const line of lines) {
    const output = await cli.exec(line);
    if (looksLikeError(output)) {
      issues += 1;
      if (onIssue) {
        onIssue(line, output.trim());
      }
    }
  }
  net.touch();
  return issues;
}

function bumpCounter(net: Net, device: Dev, name: string): void {
  const base = modelOf(device.model).base;
  if (!name.startsWith(base)) {
    return;
  }
  const rest = name.slice(base.length);
  if (!/^\d+$/.test(rest)) {
    return;
  }
  const wanted = Number(rest) + 1;
  const current = net.counters[base] ?? 0;
  if (current < wanted) {
    net.counters[base] = wanted;
  }
}

function addPlanned(net: Net, planned: PlanDevice): Dev {
  const dev = net.addDevice(planned.model, planned.x, planned.y);
  const hasModules = planned.modules.some(item => item !== null);
  if (hasModules) {
    net.setPower(dev, false);
    planned.modules.forEach((module, slot) => {
      if (module !== null) {
        net.setModule(dev, slot, module);
      }
    });
    net.setPower(dev, true);
  }
  bumpCounter(net, dev, planned.name);
  net.rename(dev, planned.name);
  dev.cfg.hostname = planned.name;
  return dev;
}

function findDevice(net: Net, key: string): Dev | undefined {
  return net.devByName(key);
}

export async function buildPlan(net: Net, plan: Plan, options: ExecOptions = {}): Promise<ExecResult> {
  const result: ExecResult = {
    devices: {},
    errors: [],
    commandIssues: [],
    dhcpFailures: [],
    cancelled: false,
  };
  const emit = options.onEvent ?? (() => {});
  const pause = options.pause ?? (async () => {});
  const stopped = (): boolean => {
    if (options.signal && options.signal.cancelled) {
      result.cancelled = true;
      return true;
    }
    return false;
  };

  const total = plan.devices.length;
  for (let index = 0; index < total; index++) {
    if (stopped()) {
      return result;
    }
    const planned = plan.devices[index];
    const dev = addPlanned(net, planned);
    result.devices[planned.key] = dev.id;
    emit({ kind: 'device', key: planned.key, index: index + 1, total });
    await pause('device');
  }

  const linkTotal = plan.links.length;
  for (let index = 0; index < linkTotal; index++) {
    if (stopped()) {
      return result;
    }
    const link = plan.links[index];
    const first = findDevice(net, link.a);
    const second = findDevice(net, link.b);
    if (!first || !second) {
      result.errors.push(`Cannot cable ${link.a} to ${link.b}: device missing.`);
      continue;
    }
    const outcome = net.connect('auto', { dev: first.id, port: link.pa }, { dev: second.id, port: link.pb });
    if (!outcome.ok) {
      result.errors.push(`${link.a} ${link.pa} to ${link.b} ${link.pb}: ${outcome.error ?? 'cable failed'}`);
    }
    emit({ kind: 'cable', index: index + 1, total: linkTotal, label: link.label });
    await pause('cable');
  }

  for (const host of plan.hosts) {
    const dev = findDevice(net, host.key);
    if (!dev) {
      continue;
    }
    const nic = dev.cfg.ifs[0];
    if (!nic) {
      continue;
    }
    if (!host.dhcp) {
      nic.ip = host.ip;
      nic.mask = host.mask;
      dev.cfg.hostGw = host.gateway ? host.gateway : undefined;
      dev.cfg.hostDns = host.dns ? host.dns : undefined;
    }
  }

  for (const server of plan.servers) {
    const dev = findDevice(net, server.key);
    if (!dev || !dev.svc) {
      continue;
    }
    dev.svc.http = { on: server.http, html: server.html };
    dev.svc.dns = { on: server.dns, records: server.records.map(item => ({ name: item.name, ip: item.ip })) };
    if (server.dhcp && server.pools.length > 0) {
      dev.svc.dhcp = {
        on: true,
        pools: server.pools.map(pool => ({
          name: pool.name,
          gw: pool.gateway,
          dns: pool.dns,
          start: pool.start,
          mask: pool.mask,
          max: pool.max,
        })),
      };
    }
    emit({ kind: 'services', key: server.key });
    await pause('services');
  }

  net.touch();
  net.settle();
  emit({ kind: 'settle' });

  const configTotal = plan.configs.length;
  for (let index = 0; index < configTotal; index++) {
    if (stopped()) {
      return result;
    }
    const config = plan.configs[index];
    const dev = findDevice(net, config.key);
    if (!dev) {
      result.errors.push(`Cannot configure ${config.key}: device missing.`);
      continue;
    }
    await runLines(net, dev, config.lines, (command, output) => {
      result.commandIssues.push({ key: config.key, command, output });
    });
    net.saveStartup(dev);
    emit({ kind: 'config', key: config.key, index: index + 1, total: configTotal, lines: config.lines.length });
    await pause('config');
  }

  net.touch();
  net.settle();
  emit({ kind: 'settle' });

  for (const host of plan.hosts) {
    if (!host.dhcp) {
      continue;
    }
    if (stopped()) {
      return result;
    }
    const dev = findDevice(net, host.key);
    if (!dev) {
      continue;
    }
    let outcome = dhcpAcquire(net, dev);
    if (!outcome.result.ok) {
      net.settle();
      outcome = dhcpAcquire(net, dev);
    }
    if (outcome.result.ok) {
      emit({ kind: 'dhcp', key: host.key, ok: true, ip: outcome.result.ip ?? '' });
    } else {
      result.dhcpFailures.push(host.key);
      emit({ kind: 'dhcp', key: host.key, ok: false, ip: '' });
    }
    await pause('dhcp');
  }

  net.touch();
  return result;
}

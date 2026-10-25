import { isHost, isSwitch } from '../model/catalog.ts';
import type { Net } from '../model/net.ts';
import type { Dev, IfCfg } from '../model/types.ts';
import { classfulLen, fmtIp, inNet, maskToLen, netInt, netOf, parseIp, sameNet, wildMatch } from '../lib/ip.ts';
import { dhcpAcquire, nicOf } from '../sim/engine.ts';
import { isRouting, lookup, routingInfo } from '../sim/routing.ts';
import { runLines } from './executor.ts';
import type { Plan } from './plan.ts';

export type Phase = 'power' | 'physical' | 'addressing' | 'layer2' | 'hosts' | 'protocol' | 'routes';
export type Severity = 'error' | 'warning';

export const PHASES: Phase[] = ['power', 'physical', 'addressing', 'layer2', 'hosts', 'protocol', 'routes'];

export interface Fix {
  text: string;
  commands: string[];
  apply: (net: Net) => Promise<void> | void;
}

export interface Finding {
  id: string;
  phase: Phase;
  severity: Severity;
  device: string;
  title: string;
  detail: string;
  fix: Fix | null;
}

export interface RepairReport {
  rounds: number;
  applied: Finding[];
  remaining: Finding[];
}

function cliFix(device: string, text: string, lines: string[]): Fix {
  return {
    text,
    commands: lines,
    apply: async (net: Net) => {
      const dev = net.devByName(device);
      if (dev) {
        await runLines(net, dev, lines);
      }
    },
  };
}

function directFix(device: string, text: string, commands: string[], change: (dev: Dev, net: Net) => void): Fix {
  return {
    text,
    commands,
    apply: (net: Net) => {
      const dev = net.devByName(device);
      if (dev) {
        change(dev, net);
        net.touch();
      }
    },
  };
}

function push(
  out: Finding[],
  id: string,
  phase: Phase,
  severity: Severity,
  device: string,
  title: string,
  detail: string,
  fix: Fix | null,
): void {
  if (out.some(item => item.id === id)) {
    return;
  }
  out.push({ id, phase, severity, device, title, detail, fix });
}

export function physIf(dev: Dev): IfCfg | undefined {
  return dev.cfg.ifs.find(item => item.type === 'phys');
}

function portOfIf(cfg: IfCfg): string | null {
  if (cfg.type === 'phys') {
    return cfg.name;
  }
  if (cfg.type === 'sub' && cfg.parent) {
    return cfg.parent;
  }
  return null;
}

function addressed(cfg: IfCfg): boolean {
  return Boolean(cfg.ip) && Boolean(cfg.mask) && cfg.ip !== '0.0.0.0';
}

export function usedAddresses(net: Net): Set<string> {
  const used = new Set<string>();
  for (const dev of net.devices) {
    for (const cfg of dev.cfg.ifs) {
      if (cfg.ip) {
        used.add(cfg.ip);
      }
    }
  }
  return used;
}

export function freeAddress(net: Net, ip: string, mask: string): string | null {
  const prefix = maskToLen(mask);
  const parsed = parseIp(ip);
  if (prefix === null || parsed === null || prefix > 30) {
    return null;
  }
  const used = usedAddresses(net);
  const base = netInt(parsed, prefix);
  const size = 2 ** (32 - prefix);
  const order: number[] = [];
  for (let offset = 10; offset < size - 1; offset++) {
    order.push(offset);
  }
  for (let offset = 2; offset < Math.min(10, size - 1); offset++) {
    order.push(offset);
  }
  for (const offset of order) {
    const candidate = fmtIp(base + offset);
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function assignFree(net: Net, dev: Dev, preferred: string, mask: string): void {
  const cfg = physIf(dev);
  if (!cfg) {
    return;
  }
  let chosen = preferred;
  if (usedAddresses(net).has(chosen)) {
    const another = freeAddress(net, preferred, mask);
    if (another) {
      chosen = another;
    }
  }
  cfg.ip = chosen;
}

function partnerAddress(ip: string, mask: string): string | null {
  const prefix = maskToLen(mask);
  const parsed = parseIp(ip);
  if (prefix === null || parsed === null || prefix > 30) {
    return null;
  }
  const base = netInt(parsed, prefix);
  const first = fmtIp(base + 1);
  const second = fmtIp(base + 2);
  return first === ip ? second : first;
}

function wildcardFromMask(mask: string): string {
  const prefix = maskToLen(mask) ?? 24;
  return fmtIp((~((prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0)) >>> 0));
}

function routingDevices(net: Net): Dev[] {
  return net.devices.filter(dev => dev.power && isRouting(dev));
}

function hasProtocol(dev: Dev): boolean {
  return dev.cfg.ospf.length > 0 || dev.cfg.eigrp.length > 0 || Boolean(dev.cfg.rip);
}

function detectPower(net: Net, out: Finding[]): void {
  for (const dev of net.devices) {
    if (dev.power) {
      continue;
    }
    push(
      out,
      `power:${dev.name}`,
      'power',
      'error',
      dev.name,
      `${dev.name} is powered off`,
      'A powered-off device drops every link attached to it.',
      {
        text: `Power on ${dev.name}`,
        commands: ['power on'],
        apply: (target: Net) => {
          const found = target.devByName(dev.name);
          if (found) {
            target.setPower(found, true);
          }
        },
      },
    );
  }
}

function detectAdminDown(net: Net, out: Finding[]): void {
  for (const cable of net.cables) {
    if (cable.type === 'console') {
      continue;
    }
    for (const end of [cable.a, cable.b]) {
      const dev = net.dev(end.dev);
      if (!dev || !dev.power) {
        continue;
      }
      const cfg = net.cfgIf(dev, end.port);
      if (!cfg || cfg.adminUp) {
        continue;
      }
      const lines = [`interface ${cfg.name}`, 'no shutdown', 'exit'];
      push(
        out,
        `admin:${dev.name}:${cfg.name}`,
        'physical',
        'error',
        dev.name,
        `${cfg.name} on ${dev.name} is administratively down`,
        'The cable is connected but the interface was shut down, so the link stays down.',
        isHost(dev.kind)
          ? directFix(dev.name, `Enable ${cfg.name} on ${dev.name}`, ['no shutdown'], (found, target) => {
              const hostIf = target.cfgIf(found, cfg.name);
              if (hostIf) {
                hostIf.adminUp = true;
              }
            })
          : cliFix(dev.name, `Run no shutdown on ${cfg.name}`, lines),
      );
    }
  }

  for (const dev of net.devices) {
    if (!dev.power || isHost(dev.kind)) {
      continue;
    }
    for (const cfg of dev.cfg.ifs) {
      const virtual = cfg.type === 'sub' || cfg.type === 'svi';
      if (!virtual || cfg.adminUp || !addressed(cfg)) {
        continue;
      }
      push(
        out,
        `admin:${dev.name}:${cfg.name}`,
        'physical',
        'error',
        dev.name,
        `${cfg.name} on ${dev.name} is administratively down`,
        'The interface has an address but is shut down.',
        cliFix(dev.name, `Run no shutdown on ${cfg.name}`, [`interface ${cfg.name}`, 'no shutdown', 'exit']),
      );
    }
  }
}

function detectSerial(net: Net, out: Finding[]): void {
  for (const cable of net.cables) {
    if (cable.type !== 'serial') {
      continue;
    }
    const dceEnd = cable.dceA ? cable.a : cable.b;
    const dev = net.dev(dceEnd.dev);
    if (!dev) {
      continue;
    }
    const cfg = net.cfgIf(dev, dceEnd.port);
    if (!cfg || cfg.clockRate) {
      continue;
    }
    push(
      out,
      `clock:${dev.name}:${cfg.name}`,
      'physical',
      'error',
      dev.name,
      `${cfg.name} on ${dev.name} is the DCE end but has no clock rate`,
      'Without a clock rate the serial line protocol stays down.',
      cliFix(dev.name, `Set clock rate 64000 on ${cfg.name}`, [`interface ${cfg.name}`, 'clock rate 64000', 'exit']),
    );
  }
}

function detectCables(net: Net, out: Finding[]): void {
  for (const cable of net.cables) {
    if (cable.type !== 'straight' && cable.type !== 'cross') {
      continue;
    }
    const first = net.dev(cable.a.dev);
    const second = net.dev(cable.b.dev);
    if (!first || !second || isSwitch(first.kind) || isSwitch(second.kind)) {
      continue;
    }
    const expected = net.autoCable(first, cable.a.port, second, cable.b.port);
    if (!expected || expected.type === cable.type) {
      continue;
    }
    const label = `${first.name} ${cable.a.port} to ${second.name} ${cable.b.port}`;
    push(
      out,
      `cable:${cable.id}`,
      'physical',
      'error',
      first.name,
      `Wrong copper cable type between ${first.name} and ${second.name}`,
      `The ${cable.type === 'straight' ? 'straight-through' : 'cross-over'} cable (${label}) cannot link these two devices, so the port stays down.`,
      {
        text: `Replace it with a ${expected.type === 'straight' ? 'straight-through' : 'cross-over'} cable`,
        commands: [`replace cable ${label}`],
        apply: (target: Net) => {
          const a = target.dev(cable.a.dev);
          const b = target.dev(cable.b.dev);
          if (!a || !b) {
            return;
          }
          target.disconnect(cable.id);
          target.connect('auto', { dev: a.id, port: cable.a.port }, { dev: b.id, port: cable.b.port });
        },
      },
    );
  }
}

function detectLinks(net: Net, out: Finding[]): void {
  for (const cable of net.cables) {
    if (cable.type === 'console') {
      continue;
    }
    const first = net.dev(cable.a.dev);
    const second = net.dev(cable.b.dev);
    if (!first || !second || isHost(first.kind) || isHost(second.kind)) {
      continue;
    }
    if (isSwitch(first.kind) || isSwitch(second.kind) || first.kind === 'hub' || second.kind === 'hub') {
      continue;
    }
    const left = net.cfgIf(first, cable.a.port);
    const right = net.cfgIf(second, cable.b.port);
    if (!left || !right || !addressed(left) || !addressed(right)) {
      continue;
    }
    const sameSubnet = sameNet(left.ip as string, right.ip as string, left.mask as string) && left.mask === right.mask;
    const duplicate = left.ip === right.ip;
    if (sameSubnet && !duplicate) {
      continue;
    }
    const partner = partnerAddress(left.ip as string, left.mask as string);
    if (!partner) {
      continue;
    }
    const lines = [`interface ${right.name}`, `ip address ${partner} ${left.mask}`, 'exit'];
    push(
      out,
      `link:${second.name}:${right.name}`,
      'addressing',
      'error',
      second.name,
      `${first.name} ${left.name} and ${second.name} ${right.name} are not in the same subnet`,
      `${left.ip} ${left.mask} and ${right.ip} ${right.mask} cannot talk directly across this cable.`,
      cliFix(second.name, `Set ${right.name} on ${second.name} to ${partner} ${left.mask}`, lines),
    );
  }
}

function switchComponents(net: Net): Dev[][] {
  const switches = net.devices.filter(dev => isSwitch(dev.kind));
  const seen = new Set<string>();
  const groups: Dev[][] = [];
  for (const start of switches) {
    if (seen.has(start.id)) {
      continue;
    }
    const group: Dev[] = [];
    const queue: Dev[] = [start];
    seen.add(start.id);
    while (queue.length > 0) {
      const curr = queue.shift() as Dev;
      group.push(curr);
      for (const cable of net.cables) {
        let otherId = '';
        if (cable.a.dev === curr.id) {
          otherId = cable.b.dev;
        } else if (cable.b.dev === curr.id) {
          otherId = cable.a.dev;
        }
        if (!otherId || seen.has(otherId)) {
          continue;
        }
        const other = net.dev(otherId);
        if (other && isSwitch(other.kind)) {
          seen.add(other.id);
          queue.push(other);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

function gatewayVlans(net: Net): Array<{ network: number; prefix: number; vlan: number }> {
  const result: Array<{ network: number; prefix: number; vlan: number }> = [];
  for (const dev of net.devices) {
    if (!isRouting(dev)) {
      continue;
    }
    for (const cfg of dev.cfg.ifs) {
      if (!addressed(cfg)) {
        continue;
      }
      let vlan = -1;
      if (cfg.type === 'sub' && cfg.vlan !== undefined && !cfg.vlanNative) {
        vlan = cfg.vlan;
      } else if (cfg.type === 'svi') {
        vlan = Number(cfg.name.replace(/\D/g, ''));
      }
      if (vlan < 0) {
        continue;
      }
      const prefix = maskToLen(cfg.mask as string);
      const parsed = parseIp(cfg.ip as string);
      if (prefix === null || parsed === null) {
        continue;
      }
      result.push({ network: netInt(parsed, prefix), prefix, vlan });
    }
  }
  return result;
}

function detectVlans(net: Net, out: Finding[]): void {
  const gateways = gatewayVlans(net);

  for (const group of switchComponents(net)) {
    const used = new Set<number>();
    for (const sw of group) {
      for (const port of sw.ports) {
        const cfg = net.cfgIf(sw, port.name);
        if (cfg && cfg.type === 'phys' && cfg.swMode === 'access' && net.cableAt(sw.id, port.name)) {
          used.add(cfg.accessVlan);
        }
      }
    }
    for (const dev of net.devices) {
      for (const cfg of dev.cfg.ifs) {
        if (cfg.type === 'sub' && cfg.vlan !== undefined && !cfg.vlanNative) {
          const parent = cfg.parent ? net.peerOf(dev.id, cfg.parent) : null;
          if (parent && group.some(sw => sw.id === parent.dev.id)) {
            used.add(cfg.vlan);
          }
        }
      }
    }
    used.delete(1);

    for (const sw of group) {
      for (const id of used) {
        if (sw.cfg.vlans[String(id)]) {
          continue;
        }
        let name = `VLAN${id}`;
        for (const other of group) {
          const known = other.cfg.vlans[String(id)];
          if (known) {
            name = known.name;
            break;
          }
        }
        push(
          out,
          `vlan:${sw.name}:${id}`,
          'layer2',
          'error',
          sw.name,
          `VLAN ${id} does not exist on ${sw.name}`,
          'Ports and trunks can only carry a VLAN that is created on the switch.',
          cliFix(sw.name, `Create VLAN ${id} (${name}) on ${sw.name}`, [`vlan ${id}`, `name ${name}`, 'exit']),
        );
      }
    }

    for (const sw of group) {
      for (const port of sw.ports) {
        const cfg = net.cfgIf(sw, port.name);
        if (!cfg || cfg.type !== 'phys' || cfg.swMode !== 'trunk' || !cfg.allowed) {
          continue;
        }
        if (!net.cableAt(sw.id, port.name)) {
          continue;
        }
        const blocked = [...used].filter(id => !allowsLocal(cfg.allowed, id));
        if (blocked.length === 0) {
          continue;
        }
        push(
          out,
          `allowed:${sw.name}:${cfg.name}`,
          'layer2',
          'error',
          sw.name,
          `Trunk ${cfg.name} on ${sw.name} does not allow VLAN ${blocked.join(', ')}`,
          `The allowed list (${cfg.allowed}) filters out VLANs that hosts are using.`,
          cliFix(sw.name, `Allow all VLANs on ${cfg.name}`, [`interface ${cfg.name}`, 'switchport trunk allowed vlan all', 'exit']),
        );
      }
    }
  }

  for (const cable of net.cables) {
    if (cable.type === 'console') {
      continue;
    }
    const first = net.dev(cable.a.dev);
    const second = net.dev(cable.b.dev);
    if (!first || !second) {
      continue;
    }
    const ends: Array<{ sw: Dev; port: string; peer: Dev; peerPort: string }> = [];
    if (isSwitch(first.kind)) {
      ends.push({ sw: first, port: cable.a.port, peer: second, peerPort: cable.b.port });
    }
    if (isSwitch(second.kind)) {
      ends.push({ sw: second, port: cable.b.port, peer: first, peerPort: cable.a.port });
    }
    for (const end of ends) {
      const mine = net.cfgIf(end.sw, end.port);
      if (!mine || mine.swMode === 'trunk' || mine.routed) {
        continue;
      }
      let needsTrunk = false;
      let reason = '';
      if (isSwitch(end.peer.kind)) {
        const theirs = net.cfgIf(end.peer, end.peerPort);
        if (theirs && theirs.swMode === 'trunk' && !theirs.routed) {
          needsTrunk = true;
          reason = `${end.peer.name} treats the other end as a trunk`;
        }
      } else if (end.peer.kind === 'router') {
        const hasSubs = end.peer.cfg.ifs.some(item => item.type === 'sub' && item.parent === end.peerPort);
        if (hasSubs) {
          needsTrunk = true;
          reason = `${end.peer.name} uses sub-interfaces on ${end.peerPort}`;
        }
      }
      if (!needsTrunk) {
        continue;
      }
      push(
        out,
        `trunk:${end.sw.name}:${mine.name}`,
        'layer2',
        'error',
        end.sw.name,
        `${mine.name} on ${end.sw.name} should be a trunk`,
        `${reason}, but the switch port is in access mode so only one VLAN passes.`,
        cliFix(end.sw.name, `Set ${mine.name} on ${end.sw.name} to trunk mode`, [`interface ${mine.name}`, 'switchport mode trunk', 'exit']),
      );
    }
  }

  const members: Array<{ host: Dev; sw: Dev; port: IfCfg; ip: string }> = [];
  for (const host of net.devices) {
    if (!isHost(host.kind)) {
      continue;
    }
    const nic = nicOf(net, host);
    if (!nic || nic.ip === '0.0.0.0') {
      continue;
    }
    const peer = net.peerOf(host.id, nic.name);
    if (!peer || !isSwitch(peer.dev.kind)) {
      continue;
    }
    const portCfg = net.cfgIf(peer.dev, peer.port);
    if (!portCfg || portCfg.swMode !== 'access') {
      continue;
    }
    members.push({ host, sw: peer.dev, port: portCfg, ip: nic.ip });
  }

  const groups = new Map<string, typeof members>();
  const expectedByGateway = new Map<string, number>();
  for (const member of members) {
    let key = '';
    for (const gateway of gateways) {
      const parsed = parseIp(member.ip) as number;
      if (netInt(parsed, gateway.prefix) === gateway.network) {
        key = `${gateway.network}/${gateway.prefix}`;
        expectedByGateway.set(key, gateway.vlan);
        break;
      }
    }
    if (!key) {
      const mask = nicOf(net, member.host)?.mask ?? '255.255.255.0';
      key = `${netOf(member.ip, mask)}/${maskToLen(mask)}`;
    }
    const list = groups.get(key) ?? [];
    list.push(member);
    groups.set(key, list);
  }

  for (const [key, list] of groups) {
    let expected = expectedByGateway.get(key);
    if (expected === undefined) {
      const counts = new Map<number, number>();
      for (const member of list) {
        counts.set(member.port.accessVlan, (counts.get(member.port.accessVlan) ?? 0) + 1);
      }
      let best = -1;
      let bestCount = 0;
      let tie = false;
      for (const [vlan, count] of counts) {
        if (count > bestCount) {
          best = vlan;
          bestCount = count;
          tie = false;
        } else if (count === bestCount) {
          tie = true;
        }
      }
      if (best === -1 || tie || bestCount < 2) {
        continue;
      }
      expected = best;
    }
    for (const member of list) {
      if (member.port.accessVlan === expected) {
        continue;
      }
      push(
        out,
        `access:${member.sw.name}:${member.port.name}`,
        'layer2',
        'error',
        member.sw.name,
        `${member.host.name} is in the wrong VLAN`,
        `${member.host.name} (${member.ip}) sits on ${member.sw.name} ${member.port.name} in VLAN ${member.port.accessVlan}, but its subnet belongs to VLAN ${expected}.`,
        cliFix(member.sw.name, `Put ${member.port.name} into VLAN ${expected}`, [
          `interface ${member.port.name}`,
          'switchport mode access',
          `switchport access vlan ${expected}`,
          'exit',
        ]),
      );
    }
  }
}

function allowsLocal(allowed: string, vlan: number): boolean {
  if (!allowed) {
    return true;
  }
  return allowed.split(',').some(part => {
    const [low, high] = part.split('-').map(Number);
    if (high === undefined) {
      return low === vlan;
    }
    return vlan >= low && vlan <= high;
  });
}

function detectHosts(net: Net, out: Finding[], plan?: Plan): void {
  const gatewayIfs: Array<{ ip: string; mask: string; dev: string }> = [];
  for (const dev of net.devices) {
    if (!isRouting(dev)) {
      continue;
    }
    for (const cfg of dev.cfg.ifs) {
      if (addressed(cfg)) {
        gatewayIfs.push({ ip: cfg.ip as string, mask: cfg.mask as string, dev: dev.name });
      }
    }
  }

  const hosts = net.devices.filter(dev => isHost(dev.kind) && dev.power);
  const keepers = new Map<string, Dev>();
  const planned = new Map<string, string>();
  if (plan) {
    for (const item of plan.hosts) {
      if (!item.dhcp && item.ip) {
        planned.set(item.key.toLowerCase(), item.ip);
      }
    }
  }
  const rankOf = (host: Dev, ip: string): number => {
    if (planned.get(host.name.toLowerCase()) === ip) {
      return 3;
    }
    if (host.svc) {
      return 2;
    }
    return 1;
  };

  for (const host of hosts) {
    const nic = physIf(host);
    if (!nic || !addressed(nic)) {
      continue;
    }
    const current = keepers.get(nic.ip as string);
    if (!current) {
      keepers.set(nic.ip as string, host);
      continue;
    }
    if (rankOf(host, nic.ip as string) > rankOf(current, nic.ip as string)) {
      keepers.set(nic.ip as string, host);
    }
  }

  for (const host of hosts) {
    const nic = physIf(host);
    if (!nic) {
      continue;
    }
    const leased = !nic.ip || nic.ip === '0.0.0.0';
    if (leased && host.cfg.hostDhcp) {
      push(
        out,
        `lease:${host.name}`,
        'hosts',
        'error',
        host.name,
        `${host.name} has no DHCP lease`,
        'The host is set to use DHCP but holds no address.',
        {
          text: `Renew the DHCP lease on ${host.name}`,
          commands: ['ipconfig /renew'],
          apply: (target: Net) => {
            const found = target.devByName(host.name);
            if (found) {
              dhcpAcquire(target, found);
            }
          },
        },
      );
      continue;
    }
    if (leased || !nic.mask) {
      continue;
    }
    const ip = nic.ip as string;
    const mask = nic.mask;

    const wanted = planned.get(host.name.toLowerCase());
    const owner = keepers.get(ip);
    if (owner !== undefined && owner.id !== host.id) {
      const replacement = wanted && wanted !== ip ? wanted : freeAddress(net, ip, mask);
      push(
        out,
        `dup:${host.name}`,
        'hosts',
        'error',
        host.name,
        `${host.name} and ${owner.name} use the same IP address ${ip}`,
        'Two hosts with the same address cause ARP conflicts and unreliable traffic.',
        replacement
          ? directFix(host.name, `Give ${host.name} the free address ${replacement}`, [`ip address ${replacement} ${mask}`], (dev, target) => {
              assignFree(target, dev, replacement, mask);
            })
          : null,
      );
    } else if (wanted && wanted !== ip) {
      push(
        out,
        `drift:${host.name}`,
        'hosts',
        'error',
        host.name,
        `${host.name} no longer has its planned address`,
        `The solution gives ${host.name} ${wanted}, but it now uses ${ip}.`,
        directFix(host.name, `Set ${host.name} back to ${wanted}`, [`ip address ${wanted} ${mask}`], (dev, target) => {
          assignFree(target, dev, wanted, mask);
        }),
      );
    }

    const candidates = gatewayIfs.filter(item => sameNet(ip, item.ip, item.mask));
    if (candidates.length === 0) {
      continue;
    }
    const choice = candidates[0];

    if (candidates.some(item => item.ip === ip)) {
      const replacement = freeAddress(net, ip, choice.mask);
      push(
        out,
        `gwdup:${host.name}`,
        'hosts',
        'error',
        host.name,
        `${host.name} uses the router address ${ip}`,
        'A host must not use the same address as its default gateway.',
        replacement
          ? directFix(host.name, `Give ${host.name} the free address ${replacement}`, [`ip address ${replacement} ${choice.mask}`], (dev, target) => {
              assignFree(target, dev, replacement, choice.mask);
            })
          : null,
      );
      continue;
    }

    if (mask !== choice.mask) {
      push(
        out,
        `mask:${host.name}`,
        'hosts',
        'error',
        host.name,
        `${host.name} has the wrong subnet mask`,
        `The host uses ${mask} but its gateway ${choice.ip} is on a network with mask ${choice.mask}.`,
        directFix(host.name, `Set the mask of ${host.name} to ${choice.mask}`, [`subnet mask ${choice.mask}`], dev => {
          const cfg = physIf(dev);
          if (cfg) {
            cfg.mask = choice.mask;
          }
        }),
      );
    }

    const gateway = host.cfg.hostGw;
    const valid = gateway !== undefined && candidates.some(item => item.ip === gateway);
    if (!valid) {
      push(
        out,
        `gw:${host.name}`,
        'hosts',
        'error',
        host.name,
        `${host.name} has the wrong default gateway`,
        gateway ? `${gateway} is not a router address in the subnet of ${ip}.` : 'No default gateway is configured, so the host cannot leave its subnet.',
        directFix(host.name, `Set the gateway of ${host.name} to ${choice.ip}`, [`default gateway ${choice.ip}`], dev => {
          dev.cfg.hostGw = choice.ip;
        }),
      );
    }
  }
}

interface Adjacent {
  from: Dev;
  to: Dev;
  fromIf: IfCfg;
  toIf: IfCfg;
}

function routerLinks(net: Net): Adjacent[] {
  const result: Adjacent[] = [];
  for (const cable of net.cables) {
    if (cable.type === 'console') {
      continue;
    }
    const first = net.dev(cable.a.dev);
    const second = net.dev(cable.b.dev);
    if (!first || !second || !isRouting(first) || !isRouting(second) || !first.power || !second.power) {
      continue;
    }
    const left = net.cfgIf(first, cable.a.port);
    const right = net.cfgIf(second, cable.b.port);
    if (!left || !right || !addressed(left) || !addressed(right)) {
      continue;
    }
    if (!sameNet(left.ip as string, right.ip as string, left.mask as string) || left.mask !== right.mask) {
      continue;
    }
    result.push({ from: first, to: second, fromIf: left, toIf: right });
    result.push({ from: second, to: first, fromIf: right, toIf: left });
  }
  return result;
}

function sameProtocol(first: Dev, second: Dev): boolean {
  if (first.cfg.ospf.length > 0 && second.cfg.ospf.length > 0) {
    return true;
  }
  if (first.cfg.eigrp.length > 0 && second.cfg.eigrp.length > 0) {
    return true;
  }
  return Boolean(first.cfg.rip) && Boolean(second.cfg.rip);
}

function detectProtocols(net: Net, out: Finding[]): void {
  const links = routerLinks(net);

  for (const dev of routingDevices(net)) {
    if (!hasProtocol(dev)) {
      continue;
    }
    const ospf = dev.cfg.ospf[0];
    const eigrp = dev.cfg.eigrp[0];
    const rip = dev.cfg.rip;

    for (const cfg of dev.cfg.ifs) {
      if (!addressed(cfg) || cfg.nat === 'outside' || cfg.type === 'lo') {
        continue;
      }
      const port = portOfIf(cfg);
      if (port !== null && cfg.type !== 'svi' && !net.cableAt(dev.id, port)) {
        continue;
      }
      const ip = cfg.ip as string;
      const mask = cfg.mask as string;

      const peerLink = links.find(item => item.from.id === dev.id && item.fromIf.name === cfg.name);
      if (peerLink && !sameProtocol(dev, peerLink.to)) {
        continue;
      }
      const peerRouter = port !== null && cfg.type === 'phys' ? net.peerOf(dev.id, port) : null;
      if (peerRouter && isRouting(peerRouter.dev) && !sameProtocol(dev, peerRouter.dev) && hasProtocol(peerRouter.dev)) {
        continue;
      }
      if (peerRouter && peerRouter.dev.kind === 'router' && !hasProtocol(peerRouter.dev)) {
        continue;
      }

      const network = netOf(ip, mask);
      const wildcard = wildcardFromMask(mask);

      if (ospf) {
        const covered = ospf.nets.some(item => wildMatch(ip, item.net, item.wild));
        if (!covered) {
          const area = ospf.nets.length > 0 ? ospf.nets[0].area : 0;
          push(
            out,
            `net:${dev.name}:ospf:${cfg.name}`,
            'protocol',
            'error',
            dev.name,
            `${dev.name} does not advertise ${network} in OSPF`,
            `Interface ${cfg.name} (${ip}) is not matched by any OSPF network statement, so neighbours never learn this subnet.`,
            cliFix(dev.name, `Add network ${network} ${wildcard} area ${area} to OSPF`, [
              `router ospf ${ospf.pid}`,
              `network ${network} ${wildcard} area ${area}`,
              'exit',
            ]),
          );
        }
        if (ospf.passive.includes(cfg.name) && peerLink && sameProtocol(dev, peerLink.to)) {
          push(
            out,
            `passive:${dev.name}:ospf:${cfg.name}`,
            'protocol',
            'error',
            dev.name,
            `${cfg.name} on ${dev.name} is passive in OSPF but faces another router`,
            'A passive interface sends no hello packets, so no OSPF neighbour can form on this link.',
            directFix(dev.name, `Remove passive-interface ${cfg.name} from OSPF`, [`no passive-interface ${cfg.name}`], target => {
              if (target.cfg.ospf[0]) {
                target.cfg.ospf[0].passive = target.cfg.ospf[0].passive.filter(item => item !== cfg.name);
              }
            }),
          );
        }
      }

      if (eigrp) {
        const covered = eigrp.nets.some(item => (item.wild ? wildMatch(ip, item.net, item.wild) : inNet(ip, item.net, classfulLen(item.net))));
        if (!covered) {
          push(
            out,
            `net:${dev.name}:eigrp:${cfg.name}`,
            'protocol',
            'error',
            dev.name,
            `${dev.name} does not advertise ${network} in EIGRP`,
            `Interface ${cfg.name} (${ip}) is not matched by any EIGRP network statement.`,
            cliFix(dev.name, `Add network ${network} ${wildcard} to EIGRP`, [
              `router eigrp ${eigrp.as}`,
              `network ${network} ${wildcard}`,
              'exit',
            ]),
          );
        }
        if (eigrp.passive.includes(cfg.name) && peerLink && sameProtocol(dev, peerLink.to)) {
          push(
            out,
            `passive:${dev.name}:eigrp:${cfg.name}`,
            'protocol',
            'error',
            dev.name,
            `${cfg.name} on ${dev.name} is passive in EIGRP but faces another router`,
            'A passive interface forms no EIGRP neighbours.',
            directFix(dev.name, `Remove passive-interface ${cfg.name} from EIGRP`, [`no passive-interface ${cfg.name}`], target => {
              if (target.cfg.eigrp[0]) {
                target.cfg.eigrp[0].passive = target.cfg.eigrp[0].passive.filter(item => item !== cfg.name);
              }
            }),
          );
        }
      }

      if (rip) {
        const covered = rip.nets.some(item => inNet(ip, item, classfulLen(item)));
        if (!covered) {
          const classful = fmtIp(netInt(parseIp(ip) as number, classfulLen(ip)));
          push(
            out,
            `net:${dev.name}:rip:${cfg.name}`,
            'protocol',
            'error',
            dev.name,
            `${dev.name} does not advertise ${network} in RIP`,
            `Interface ${cfg.name} (${ip}) is not matched by any RIP network statement.`,
            cliFix(dev.name, `Add network ${classful} to RIP`, ['router rip', `network ${classful}`, 'exit']),
          );
        }
        if (rip.passive.includes(cfg.name) && peerLink && sameProtocol(dev, peerLink.to)) {
          push(
            out,
            `passive:${dev.name}:rip:${cfg.name}`,
            'protocol',
            'error',
            dev.name,
            `${cfg.name} on ${dev.name} is passive in RIP but faces another router`,
            'A passive RIP interface sends no updates.',
            directFix(dev.name, `Remove passive-interface ${cfg.name} from RIP`, [`no passive-interface ${cfg.name}`], target => {
              if (target.cfg.rip) {
                target.cfg.rip.passive = target.cfg.rip.passive.filter(item => item !== cfg.name);
              }
            }),
          );
        }
      }
    }
  }
}

function regions(net: Net, links: Adjacent[]): Map<string, number> {
  const region = new Map<string, number>();
  const devices = routingDevices(net);
  let next = 0;
  for (const start of devices) {
    if (region.has(start.id)) {
      continue;
    }
    const queue: Dev[] = [start];
    region.set(start.id, next);
    while (queue.length > 0) {
      const curr = queue.shift() as Dev;
      for (const link of links) {
        if (link.from.id !== curr.id || region.has(link.to.id)) {
          continue;
        }
        if (link.fromIf.nat === 'outside' || link.toIf.nat === 'outside') {
          continue;
        }
        region.set(link.to.id, next);
        queue.push(link.to);
      }
    }
    next += 1;
  }
  return region;
}

function firstHopToward(links: Adjacent[], region: Map<string, number>, from: Dev, to: Dev): Adjacent | null {
  const parents = new Map<string, Adjacent>();
  const seen = new Set<string>([from.id]);
  const queue: Dev[] = [from];
  while (queue.length > 0) {
    const curr = queue.shift() as Dev;
    if (curr.id === to.id) {
      break;
    }
    for (const link of links) {
      if (link.from.id !== curr.id || seen.has(link.to.id)) {
        continue;
      }
      if (link.fromIf.nat === 'outside' || link.toIf.nat === 'outside') {
        continue;
      }
      if (region.get(link.to.id) !== region.get(from.id)) {
        continue;
      }
      seen.add(link.to.id);
      parents.set(link.to.id, link);
      queue.push(link.to);
    }
  }
  if (!parents.has(to.id)) {
    return null;
  }
  let curr = to.id;
  let hop = parents.get(curr) as Adjacent;
  while (hop.from.id !== from.id) {
    curr = hop.from.id;
    hop = parents.get(curr) as Adjacent;
  }
  return hop;
}

function detectRoutes(net: Net, out: Finding[]): void {
  const links = routerLinks(net);
  const region = regions(net, links);
  const info = routingInfo(net);

  for (const dev of routingDevices(net)) {
    const connected: IfCfg[] = dev.cfg.ifs.filter(item => addressed(item));
    for (const route of dev.cfg.statics) {
      if (!route.nh) {
        continue;
      }
      const reachable = connected.some(item => sameNet(route.nh as string, item.ip as string, item.mask as string) && item.ip !== route.nh);
      if (reachable) {
        continue;
      }
      push(
        out,
        `badroute:${dev.name}:${route.net}:${route.nh}`,
        'routes',
        'error',
        dev.name,
        `${dev.name} has a static route via an unreachable next hop`,
        `ip route ${route.net} ${route.mask} ${route.nh} is ignored because ${route.nh} is not in any connected subnet.`,
        directFix(dev.name, `Remove ip route ${route.net} ${route.mask} ${route.nh}`, [`no ip route ${route.net} ${route.mask} ${route.nh}`], target => {
          target.cfg.statics = target.cfg.statics.filter(item => !(item.net === route.net && item.mask === route.mask && item.nh === route.nh));
        }),
      );
    }
  }

  for (const dev of routingDevices(net)) {
    if (hasProtocol(dev)) {
      continue;
    }
    const table = info.routes.get(dev.id) ?? [];
    for (const other of routingDevices(net)) {
      if (other.id === dev.id || region.get(other.id) !== region.get(dev.id)) {
        continue;
      }
      for (const cfg of other.cfg.ifs) {
        if (!addressed(cfg) || cfg.nat === 'outside' || cfg.type === 'lo') {
          continue;
        }
        const prefix = maskToLen(cfg.mask as string) as number;
        const network = netOf(cfg.ip as string, cfg.mask as string);
        const found = lookup(table, network);
        if (found && found.len >= prefix) {
          continue;
        }
        if (found && found.len > 0 && found.code === 'C') {
          continue;
        }
        const hop = firstHopToward(links, region, dev, other);
        const fix = hop
          ? cliFix(dev.name, `Add ip route ${network} ${cfg.mask} ${hop.toIf.ip}`, [`ip route ${network} ${cfg.mask} ${hop.toIf.ip}`])
          : null;
        push(
          out,
          `noroute:${dev.name}:${network}/${prefix}`,
          'routes',
          'error',
          dev.name,
          `${dev.name} has no route to ${network}/${prefix}`,
          `${other.name} owns this subnet, but ${dev.name} has no static route or routing protocol entry for it.`,
          fix,
        );
      }
    }
  }

  for (const edge of routingDevices(net)) {
    if (edge.cfg.natRules.length === 0) {
      continue;
    }
    const outside = edge.cfg.ifs.find(item => item.nat === 'outside' && addressed(item));
    if (!outside) {
      continue;
    }
    const port = portOfIf(outside);
    const peer = port ? net.peerOf(edge.id, port) : null;
    let peerIp = '';
    if (peer) {
      const peerCfg = net.cfgIf(peer.dev, peer.port);
      if (peerCfg && addressed(peerCfg) && sameNet(peerCfg.ip as string, outside.ip as string, outside.mask as string)) {
        peerIp = peerCfg.ip as string;
      }
    }
    const edgeTable = info.routes.get(edge.id) ?? [];
    const hasDefault = edgeTable.some(item => item.len === 0);
    if (!hasDefault && peerIp) {
      push(
        out,
        `natdefault:${edge.name}`,
        'routes',
        'error',
        edge.name,
        `${edge.name} has no default route to the ISP`,
        'NAT is configured but there is no route towards the Internet.',
        cliFix(edge.name, `Add ip route 0.0.0.0 0.0.0.0 ${peerIp}`, [`ip route 0.0.0.0 0.0.0.0 ${peerIp}`]),
      );
    }

    for (const dev of routingDevices(net)) {
      if (dev.id === edge.id || region.get(dev.id) !== region.get(edge.id)) {
        continue;
      }
      const table = info.routes.get(dev.id) ?? [];
      if (table.some(item => item.len === 0)) {
        continue;
      }
      if (hasProtocol(edge) && sameProtocol(edge, dev)) {
        let fix: Fix | null = null;
        if (edge.cfg.ospf.length > 0) {
          fix = cliFix(edge.name, 'Add default-information originate to OSPF', [`router ospf ${edge.cfg.ospf[0].pid}`, 'default-information originate', 'exit']);
        } else if (edge.cfg.rip) {
          fix = cliFix(edge.name, 'Add default-information originate to RIP', ['router rip', 'default-information originate', 'exit']);
        } else if (edge.cfg.eigrp.length > 0) {
          fix = cliFix(edge.name, 'Redistribute the static default route into EIGRP', [`router eigrp ${edge.cfg.eigrp[0].as}`, 'redistribute static', 'exit']);
        }
        push(
          out,
          `defaultshare:${edge.name}`,
          'routes',
          'error',
          edge.name,
          `${dev.name} learns no default route from ${edge.name}`,
          'The edge router has a default route but does not share it with the routing protocol.',
          fix,
        );
        continue;
      }
      if (!hasProtocol(dev)) {
        const hop = firstHopToward(links, region, dev, edge);
        push(
          out,
          `defaultroute:${dev.name}`,
          'routes',
          'error',
          dev.name,
          `${dev.name} has no default route towards the edge router`,
          `Traffic for the Internet cannot leave through ${edge.name}.`,
          hop ? cliFix(dev.name, `Add ip route 0.0.0.0 0.0.0.0 ${hop.toIf.ip}`, [`ip route 0.0.0.0 0.0.0.0 ${hop.toIf.ip}`]) : null,
        );
      }
    }
  }
}

export function diagnose(net: Net, plan?: Plan): Finding[] {
  const out: Finding[] = [];
  detectPower(net, out);
  detectAdminDown(net, out);
  detectSerial(net, out);
  detectCables(net, out);
  detectLinks(net, out);
  detectVlans(net, out);
  detectHosts(net, out, plan);
  detectProtocols(net, out);
  detectRoutes(net, out);
  return out;
}

export function flushDynamicState(net: Net): void {
  for (const dev of net.devices) {
    dev.rt.arp = {};
    dev.rt.macTable = [];
    dev.rt.nat = [];
  }
  net.touch();
}

export async function autoFix(net: Net, onFix?: (finding: Finding) => void, plan?: Plan): Promise<RepairReport> {
  const applied: Finding[] = [];
  const attempts = new Map<string, number>();
  let rounds = 0;
  for (let round = 0; round < 8; round++) {
    const findings = diagnose(net, plan);
    const actionable = findings.filter(item => item.fix !== null && (attempts.get(item.id) ?? 0) < 2);
    if (actionable.length === 0) {
      return { rounds, applied, remaining: findings };
    }
    let phase: Phase = 'routes';
    for (const item of actionable) {
      if (PHASES.indexOf(item.phase) < PHASES.indexOf(phase)) {
        phase = item.phase;
      }
    }
    const batch = actionable.filter(item => item.phase === phase);
    for (const item of batch) {
      attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1);
      await (item.fix as Fix).apply(net);
      applied.push(item);
      if (onFix) {
        onFix(item);
      }
    }
    flushDynamicState(net);
    net.settle();
    rounds += 1;
  }
  return { rounds, applied, remaining: diagnose(net, plan) };
}

export { routingDevices, hasProtocol, sameProtocol, routerLinks };

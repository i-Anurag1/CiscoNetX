import { isHost, isSwitch } from '../model/catalog.ts';
import type { Net } from '../model/net.ts';
import type { Dev } from '../model/types.ts';
import { fmtIp, netInt, parseIp } from '../lib/ip.ts';
import { isRouting } from '../sim/routing.ts';
import { diagnose, freeAddress, hasProtocol, physIf, usedAddresses } from './doctor.ts';

export type FaultKind =
  | 'shutdown'
  | 'gateway'
  | 'mask'
  | 'route'
  | 'network'
  | 'vlan'
  | 'trunk'
  | 'clock'
  | 'cable'
  | 'power'
  | 'passive'
  | 'ip';

export const FAULT_KINDS: FaultKind[] = [
  'shutdown',
  'gateway',
  'mask',
  'route',
  'network',
  'vlan',
  'trunk',
  'clock',
  'cable',
  'power',
  'passive',
  'ip',
];

export const FAULT_LABELS: Record<FaultKind, string> = {
  shutdown: 'Shut down an interface',
  gateway: 'Wrong default gateway',
  mask: 'Wrong subnet mask',
  route: 'Delete a static route',
  network: 'Remove a routing network statement',
  vlan: 'Wrong or missing VLAN',
  trunk: 'Break a trunk link',
  clock: 'Remove a serial clock rate',
  cable: 'Swap in the wrong cable',
  power: 'Power off a device',
  passive: 'Make a link interface passive',
  ip: 'Wrong or duplicate IP address',
};

export interface Fault {
  kind: FaultKind;
  device: string;
  title: string;
  detail: string;
}

interface Candidate {
  fault: Fault;
  apply: () => void;
  undo: () => void;
}

export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const temp = copy[index];
    copy[index] = copy[swap];
    copy[swap] = temp;
  }
  return copy;
}

function addressed(ip: string | undefined, mask: string | undefined): boolean {
  return Boolean(ip) && Boolean(mask) && ip !== '0.0.0.0';
}

function shutdownCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
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
      if (!cfg || !cfg.adminUp) {
        continue;
      }
      result.push({
        fault: {
          kind: 'shutdown',
          device: dev.name,
          title: `${cfg.name} on ${dev.name} was shut down`,
          detail: `An engineer ran shutdown on ${cfg.name}, so the link is down.`,
        },
        apply: () => {
          cfg.adminUp = false;
        },
        undo: () => {
          cfg.adminUp = true;
        },
      });
    }
  }
  return result;
}

function staticHosts(net: Net): Dev[] {
  const result: Dev[] = [];
  for (const dev of net.devices) {
    if (!isHost(dev.kind) || !dev.power || dev.cfg.hostDhcp) {
      continue;
    }
    const nic = physIf(dev);
    if (!nic || !addressed(nic.ip, nic.mask)) {
      continue;
    }
    result.push(dev);
  }
  return result;
}

function gatewayCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const dev of staticHosts(net)) {
    const nic = physIf(dev);
    const original = dev.cfg.hostGw;
    if (!nic || !original) {
      continue;
    }
    const wrong = freeAddress(net, nic.ip as string, nic.mask as string);
    if (!wrong) {
      continue;
    }
    result.push({
      fault: {
        kind: 'gateway',
        device: dev.name,
        title: `${dev.name} points at the wrong default gateway`,
        detail: `The default gateway of ${dev.name} was changed from ${original} to ${wrong}.`,
      },
      apply: () => {
        dev.cfg.hostGw = wrong;
      },
      undo: () => {
        dev.cfg.hostGw = original;
      },
    });
  }
  return result;
}

function maskCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const dev of staticHosts(net)) {
    const nic = physIf(dev);
    if (!nic || !dev.cfg.hostGw) {
      continue;
    }
    const original = nic.mask as string;
    let wrong = '255.255.0.0';
    if (original === wrong) {
      wrong = '255.255.255.252';
    }
    result.push({
      fault: {
        kind: 'mask',
        device: dev.name,
        title: `${dev.name} has the wrong subnet mask`,
        detail: `The subnet mask of ${dev.name} was changed from ${original} to ${wrong}.`,
      },
      apply: () => {
        nic.mask = wrong;
      },
      undo: () => {
        nic.mask = original;
      },
    });
  }
  return result;
}

function routeCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const dev of net.devices) {
    if (!dev.power || !isRouting(dev)) {
      continue;
    }
    dev.cfg.statics.forEach(route => {
      result.push({
        fault: {
          kind: 'route',
          device: dev.name,
          title: `${dev.name} lost a static route`,
          detail: `ip route ${route.net} ${route.mask} ${route.nh ?? route.ifn ?? ''} was removed from ${dev.name}.`,
        },
        apply: () => {
          dev.cfg.statics = dev.cfg.statics.filter(item => item !== route);
        },
        undo: () => {
          dev.cfg.statics.push(route);
        },
      });
    });
  }
  return result;
}

function networkCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const dev of net.devices) {
    if (!dev.power || !isRouting(dev)) {
      continue;
    }
    const ospf = dev.cfg.ospf[0];
    if (ospf) {
      ospf.nets.forEach((entry, index) => {
        result.push({
          fault: {
            kind: 'network',
            device: dev.name,
            title: `${dev.name} stopped advertising ${entry.net} in OSPF`,
            detail: `network ${entry.net} ${entry.wild} area ${entry.area} was removed from router ospf ${ospf.pid}.`,
          },
          apply: () => {
            ospf.nets = ospf.nets.filter(item => item !== entry);
          },
          undo: () => {
            ospf.nets.splice(Math.min(index, ospf.nets.length), 0, entry);
          },
        });
      });
    }
    const eigrp = dev.cfg.eigrp[0];
    if (eigrp) {
      eigrp.nets.forEach((entry, index) => {
        result.push({
          fault: {
            kind: 'network',
            device: dev.name,
            title: `${dev.name} stopped advertising ${entry.net} in EIGRP`,
            detail: `network ${entry.net} was removed from router eigrp ${eigrp.as}.`,
          },
          apply: () => {
            eigrp.nets = eigrp.nets.filter(item => item !== entry);
          },
          undo: () => {
            eigrp.nets.splice(Math.min(index, eigrp.nets.length), 0, entry);
          },
        });
      });
    }
    const rip = dev.cfg.rip;
    if (rip) {
      rip.nets.forEach((entry, index) => {
        result.push({
          fault: {
            kind: 'network',
            device: dev.name,
            title: `${dev.name} stopped advertising ${entry} in RIP`,
            detail: `network ${entry} was removed from router rip.`,
          },
          apply: () => {
            rip.nets = rip.nets.filter(item => item !== entry);
          },
          undo: () => {
            rip.nets.splice(Math.min(index, rip.nets.length), 0, entry);
          },
        });
      });
    }
  }
  return result;
}

function vlanCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const sw of net.devices) {
    if (!sw.power || !isSwitch(sw.kind)) {
      continue;
    }
    const ids = Object.keys(sw.cfg.vlans)
      .map(Number)
      .filter(id => id !== 1);

    for (const port of sw.ports) {
      const cfg = net.cfgIf(sw, port.name);
      if (!cfg || cfg.type !== 'phys' || cfg.swMode !== 'access' || !net.cableAt(sw.id, port.name)) {
        continue;
      }
      const peer = net.peerOf(sw.id, port.name);
      if (!peer || !isHost(peer.dev.kind)) {
        continue;
      }
      const original = cfg.accessVlan;
      const options = ids.filter(id => id !== original);
      if (original !== 1) {
        options.push(1);
      }
      for (const wrong of options) {
        result.push({
          fault: {
            kind: 'vlan',
            device: sw.name,
            title: `${peer.dev.name} was moved into the wrong VLAN`,
            detail: `${port.name} on ${sw.name} changed from VLAN ${original} to VLAN ${wrong}.`,
          },
          apply: () => {
            cfg.accessVlan = wrong;
          },
          undo: () => {
            cfg.accessVlan = original;
          },
        });
      }
    }

    for (const id of ids) {
      const entry = sw.cfg.vlans[String(id)];
      result.push({
        fault: {
          kind: 'vlan',
          device: sw.name,
          title: `VLAN ${id} was deleted from ${sw.name}`,
          detail: `no vlan ${id} removed the VLAN, so its ports and trunks stop forwarding that traffic.`,
        },
        apply: () => {
          delete sw.cfg.vlans[String(id)];
        },
        undo: () => {
          sw.cfg.vlans[String(id)] = entry;
        },
      });
    }
  }
  return result;
}

function trunkCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const sw of net.devices) {
    if (!sw.power || !isSwitch(sw.kind)) {
      continue;
    }
    for (const port of sw.ports) {
      const cfg = net.cfgIf(sw, port.name);
      if (!cfg || cfg.type !== 'phys' || cfg.swMode !== 'trunk' || !net.cableAt(sw.id, port.name)) {
        continue;
      }
      const originalAllowed = cfg.allowed;
      result.push({
        fault: {
          kind: 'trunk',
          device: sw.name,
          title: `${port.name} on ${sw.name} is no longer a trunk`,
          detail: `The port was set to access mode, so only one VLAN crosses this link.`,
        },
        apply: () => {
          cfg.swMode = 'access';
        },
        undo: () => {
          cfg.swMode = 'trunk';
        },
      });
      result.push({
        fault: {
          kind: 'trunk',
          device: sw.name,
          title: `${port.name} on ${sw.name} filters VLANs`,
          detail: 'switchport trunk allowed vlan 1 now blocks every VLAN except VLAN 1.',
        },
        apply: () => {
          cfg.allowed = '1';
        },
        undo: () => {
          cfg.allowed = originalAllowed;
        },
      });
    }
  }
  return result;
}

function clockCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const cable of net.cables) {
    if (cable.type !== 'serial') {
      continue;
    }
    const end = cable.dceA ? cable.a : cable.b;
    const dev = net.dev(end.dev);
    if (!dev || !dev.power) {
      continue;
    }
    const cfg = net.cfgIf(dev, end.port);
    if (!cfg || !cfg.clockRate) {
      continue;
    }
    const original = cfg.clockRate;
    result.push({
      fault: {
        kind: 'clock',
        device: dev.name,
        title: `${cfg.name} on ${dev.name} lost its clock rate`,
        detail: 'The DCE side of the serial link has no clock rate, so the line protocol is down.',
      },
      apply: () => {
        cfg.clockRate = undefined;
      },
      undo: () => {
        cfg.clockRate = original;
      },
    });
  }
  return result;
}

function cableCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const cable of net.cables) {
    if (cable.type !== 'straight' && cable.type !== 'cross') {
      continue;
    }
    const first = net.dev(cable.a.dev);
    const second = net.dev(cable.b.dev);
    if (!first || !second || isSwitch(first.kind) || isSwitch(second.kind)) {
      continue;
    }
    const endA = { dev: cable.a.dev, port: cable.a.port };
    const endB = { dev: cable.b.dev, port: cable.b.port };
    const original = cable.type;
    const wrong = original === 'straight' ? 'cross' : 'straight';
    let currentId = cable.id;
    result.push({
      fault: {
        kind: 'cable',
        device: first.name,
        title: `Wrong cable between ${first.name} and ${second.name}`,
        detail: `A ${wrong === 'cross' ? 'cross-over' : 'straight-through'} cable replaced the correct one, so the port stays down.`,
      },
      apply: () => {
        net.disconnect(currentId);
        const made = net.connect(wrong, endA, endB);
        if (made.cable) {
          currentId = made.cable.id;
        }
      },
      undo: () => {
        net.disconnect(currentId);
        const made = net.connect(original, endA, endB);
        if (made.cable) {
          currentId = made.cable.id;
        }
      },
    });
  }
  return result;
}

function powerCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const dev of net.devices) {
    if (!dev.power || isHost(dev.kind) || dev.kind === 'hub') {
      continue;
    }
    result.push({
      fault: {
        kind: 'power',
        device: dev.name,
        title: `${dev.name} lost power`,
        detail: 'The device is switched off, so every link attached to it is down.',
      },
      apply: () => {
        net.setPower(dev, false);
      },
      undo: () => {
        net.setPower(dev, true);
      },
    });
  }
  return result;
}

function passiveCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  for (const dev of net.devices) {
    if (!dev.power || !isRouting(dev) || !hasProtocol(dev)) {
      continue;
    }
    for (const cfg of dev.cfg.ifs) {
      if (cfg.type !== 'phys' || !addressed(cfg.ip, cfg.mask)) {
        continue;
      }
      const peer = net.peerOf(dev.id, cfg.name);
      if (!peer || !isRouting(peer.dev) || !hasProtocol(peer.dev)) {
        continue;
      }
      const ospf = dev.cfg.ospf[0];
      const eigrp = dev.cfg.eigrp[0];
      const rip = dev.cfg.rip;
      let list: string[] | null = null;
      let name = '';
      if (ospf) {
        list = ospf.passive;
        name = 'OSPF';
      } else if (eigrp) {
        list = eigrp.passive;
        name = 'EIGRP';
      } else if (rip) {
        list = rip.passive;
        name = 'RIP';
      }
      if (!list || list.includes(cfg.name)) {
        continue;
      }
      const target = list;
      result.push({
        fault: {
          kind: 'passive',
          device: dev.name,
          title: `${cfg.name} on ${dev.name} is passive in ${name}`,
          detail: `passive-interface ${cfg.name} stops hellos, so no neighbour forms towards ${peer.dev.name}.`,
        },
        apply: () => {
          target.push(cfg.name);
        },
        undo: () => {
          const position = target.indexOf(cfg.name);
          if (position >= 0) {
            target.splice(position, 1);
          }
        },
      });
    }
  }
  return result;
}

function ipCandidates(net: Net): Candidate[] {
  const result: Candidate[] = [];
  const used = usedAddresses(net);

  for (const cable of net.cables) {
    if (cable.type === 'console') {
      continue;
    }
    const first = net.dev(cable.a.dev);
    const second = net.dev(cable.b.dev);
    if (!first || !second || !first.power || !second.power) {
      continue;
    }
    if (first.kind !== 'router' || second.kind !== 'router') {
      continue;
    }
    const cfg = net.cfgIf(second, cable.b.port);
    if (!cfg || !addressed(cfg.ip, cfg.mask)) {
      continue;
    }
    const original = cfg.ip as string;
    const parsed = parseIp(original);
    if (parsed === null) {
      continue;
    }
    const wrong = fmtIp((parsed + 0x00010000) >>> 0);
    if (used.has(wrong)) {
      continue;
    }
    result.push({
      fault: {
        kind: 'ip',
        device: second.name,
        title: `${cfg.name} on ${second.name} has an address in the wrong subnet`,
        detail: `The address changed from ${original} to ${wrong}, so ${first.name} can no longer reach it.`,
      },
      apply: () => {
        cfg.ip = wrong;
      },
      undo: () => {
        cfg.ip = original;
      },
    });
  }

  const hosts = staticHosts(net);
  for (const dev of hosts) {
    const nic = physIf(dev);
    if (!nic) {
      continue;
    }
    for (const other of hosts) {
      if (other.id === dev.id) {
        continue;
      }
      const otherNic = physIf(other);
      if (!otherNic || otherNic.mask !== nic.mask) {
        continue;
      }
      const parsedA = parseIp(nic.ip as string);
      const parsedB = parseIp(otherNic.ip as string);
      const prefixOk = parsedA !== null && parsedB !== null;
      if (!prefixOk) {
        continue;
      }
      const sameNetwork = netInt(parsedA, 24) === netInt(parsedB, 24);
      if (!sameNetwork) {
        continue;
      }
      const original = nic.ip as string;
      const stolen = otherNic.ip as string;
      result.push({
        fault: {
          kind: 'ip',
          device: dev.name,
          title: `${dev.name} and ${other.name} share the address ${stolen}`,
          detail: `${dev.name} was given ${stolen} instead of ${original}, which causes an address conflict.`,
        },
        apply: () => {
          nic.ip = stolen;
        },
        undo: () => {
          nic.ip = original;
        },
      });
      break;
    }
  }
  return result;
}

function candidatesFor(net: Net, kind: FaultKind): Candidate[] {
  if (kind === 'shutdown') {
    return shutdownCandidates(net);
  }
  if (kind === 'gateway') {
    return gatewayCandidates(net);
  }
  if (kind === 'mask') {
    return maskCandidates(net);
  }
  if (kind === 'route') {
    return routeCandidates(net);
  }
  if (kind === 'network') {
    return networkCandidates(net);
  }
  if (kind === 'vlan') {
    return vlanCandidates(net);
  }
  if (kind === 'trunk') {
    return trunkCandidates(net);
  }
  if (kind === 'clock') {
    return clockCandidates(net);
  }
  if (kind === 'cable') {
    return cableCandidates(net);
  }
  if (kind === 'power') {
    return powerCandidates(net);
  }
  if (kind === 'passive') {
    return passiveCandidates(net);
  }
  return ipCandidates(net);
}

export function availableFaults(net: Net): FaultKind[] {
  return FAULT_KINDS.filter(kind => candidatesFor(net, kind).length > 0);
}

export function injectFault(net: Net, seed: number, kind?: FaultKind): Fault | null {
  const random = makeRandom(seed);
  const kinds = kind ? [kind] : shuffled(FAULT_KINDS, random);
  const before = new Set(diagnose(net).map(item => item.id));

  for (const current of kinds) {
    const options = shuffled(candidatesFor(net, current), random);
    for (const option of options) {
      option.apply();
      net.touch();
      const fresh = diagnose(net).filter(item => !before.has(item.id));
      if (fresh.length > 0) {
        return option.fault;
      }
      option.undo();
      net.touch();
    }
  }
  return null;
}

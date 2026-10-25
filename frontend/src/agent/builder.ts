import {
  broadcastOf,
  firstUsable,
  hostAt,
  lastUsable,
  usableCount,
  type Cidr,
} from './ipam.ts';
import type {
  AddressRow,
  PlanCheck,
  PlanConfig,
  PlanDevice,
  PlanHost,
  PlanLink,
  PlanServer,
  PlanStep,
  Role,
  ShowCommand,
  SubnetRow,
} from './plan.ts';
import type { LabSpec } from './spec.ts';

export interface Counters {
  pc: number;
  server: number;
  check: number;
  switchCount: number;
  hubCount: number;
}

export interface Builder {
  spec: LabSpec;
  devices: PlanDevice[];
  links: PlanLink[];
  configs: PlanConfig[];
  hosts: PlanHost[];
  servers: PlanServer[];
  checks: PlanCheck[];
  show: ShowCommand[];
  subnets: SubnetRow[];
  addresses: AddressRow[];
  steps: PlanStep[];
  notes: string[];
  counters: Counters;
}

export interface Point {
  x: number;
  y: number;
}

export function gig(index: number): string {
  return `GigabitEthernet0/${index}`;
}

export function fast(index: number): string {
  return `FastEthernet0/${index}`;
}

export function serialPort(index: number): string {
  const slot = Math.floor(index / 2);
  const port = index % 2;
  return `Serial0/${slot}/${port}`;
}

export function createBuilder(spec: LabSpec): Builder {
  return {
    spec,
    devices: [],
    links: [],
    configs: [],
    hosts: [],
    servers: [],
    checks: [],
    show: [],
    subnets: [],
    addresses: [],
    steps: [],
    notes: [],
    counters: { pc: 0, server: 0, check: 0, switchCount: 0, hubCount: 0 },
  };
}

export interface DeviceInput {
  key: string;
  model: string;
  role: Role;
  x: number;
  y: number;
  group: string;
  modules?: Array<string | null>;
}

export function addDevice(ctx: Builder, input: DeviceInput): PlanDevice {
  const device: PlanDevice = {
    key: input.key,
    name: input.key,
    model: input.model,
    role: input.role,
    x: input.x,
    y: input.y,
    modules: input.modules ?? [],
    group: input.group,
  };
  ctx.devices.push(device);
  return device;
}

export function deviceOf(ctx: Builder, key: string): PlanDevice {
  const found = ctx.devices.find(item => item.key === key);
  if (!found) {
    throw new Error(`Unknown planned device ${key}`);
  }
  return found;
}

export function addLink(
  ctx: Builder,
  first: string,
  firstPort: string,
  second: string,
  secondPort: string,
  label: string,
  serial = false,
): number {
  ctx.links.push({ a: first, pa: firstPort, b: second, pb: secondPort, label, serial });
  return ctx.links.length - 1;
}

export function configOf(ctx: Builder, key: string, title: string): PlanConfig {
  let found = ctx.configs.find(item => item.key === key);
  if (!found) {
    found = { key, title, lines: [] };
    ctx.configs.push(found);
  }
  return found;
}

export function pushBlock(lines: string[], header: string, body: string[]): void {
  lines.push(header);
  for (const item of body) {
    lines.push(item);
  }
  lines.push('exit');
}

export function addCheck(ctx: Builder, check: Omit<PlanCheck, 'id'>): void {
  ctx.counters.check += 1;
  ctx.checks.push({ id: `c${ctx.counters.check}`, ...check });
}

export function addSubnet(
  ctx: Builder,
  name: string,
  cidr: Cidr,
  purpose: string,
  required: number | null,
): void {
  ctx.subnets.push({
    name,
    network: cidr.network,
    mask: cidr.mask,
    prefix: cidr.prefix,
    first: firstUsable(cidr),
    last: lastUsable(cidr),
    broadcast: broadcastOf(cidr),
    usable: usableCount(cidr.prefix),
    purpose,
    required,
  });
}

export function addAddress(
  ctx: Builder,
  device: string,
  iface: string,
  ip: string,
  mask: string,
  gateway: string,
  note: string,
): void {
  ctx.addresses.push({ device, iface, ip, mask, gateway, note });
}

export function addShow(ctx: Builder, key: string, command: string, why: string): void {
  ctx.show.push({ key, command, why });
}

export function addStep(ctx: Builder, title: string, detail: string): void {
  ctx.steps.push({ title, detail });
}

export interface LanLayout {
  gateway: string;
  serverIp: string;
  hostStart: number;
  capacity: number;
  poolMax: number;
}

export function lanLayout(cidr: Cidr): LanLayout {
  const usable = usableCount(cidr.prefix);
  let hostStart = 10;
  if (usable < 3) {
    hostStart = 2;
  } else if (usable < 30) {
    hostStart = 3;
  }
  const capacity = Math.max(0, usable - hostStart + 1);
  const poolMax = Math.max(1, Math.min(capacity, 100));
  return {
    gateway: hostAt(cidr, 1),
    serverIp: hostAt(cidr, 2),
    hostStart,
    capacity,
    poolMax,
  };
}

export function excludedRange(cidr: Cidr): [string, string] {
  const layout = lanLayout(cidr);
  return [hostAt(cidr, 1), hostAt(cidr, Math.max(1, layout.hostStart - 1))];
}

export function unitVector(dx: number, dy: number): Point {
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length === 0) {
    return { x: 0, y: 1 };
  }
  return { x: dx / length, y: dy / length };
}

export interface SegmentInput {
  lan: number;
  title: string;
  cidr: Cidr;
  gateway: string;
  router: { key: string; port: string } | null;
  hostCount: number;
  withServer: boolean;
  dhcpHosts: boolean;
  dns: string;
  origin: Point;
  dir: Point;
}

export interface SegmentResult {
  lan: number;
  switchKey: string;
  pcs: string[];
  server: string | null;
  serverIp: string;
  hostIps: string[];
  layout: LanLayout;
}

export function buildSegment(ctx: Builder, input: SegmentInput): SegmentResult {
  const layout = lanLayout(input.cidr);
  const hub = ctx.spec.hub && ctx.spec.family !== 'vlan';
  let count = input.hostCount;
  if (count > layout.capacity) {
    count = layout.capacity;
    ctx.notes.push(`${input.title} (${input.cidr.network}/${input.cidr.prefix}) only has room for ${count} PCs, so ${count} were drawn.`);
  }

  let switchKey = '';
  if (hub) {
    ctx.counters.hubCount += 1;
    switchKey = `HUB${ctx.counters.hubCount}`;
  } else {
    ctx.counters.switchCount += 1;
    switchKey = `SW${ctx.counters.switchCount}`;
  }

  const dir = input.dir;
  const sideways: Point = { x: -dir.y, y: dir.x };
  const switchX = input.origin.x + dir.x * 150;
  const switchY = input.origin.y + dir.y * 150;
  addDevice(ctx, {
    key: switchKey,
    model: hub ? 'Hub-PT' : '2960-24TT',
    role: hub ? 'hub' : 'switch',
    x: switchX,
    y: switchY,
    group: input.title,
  });

  if (input.router) {
    const uplinkPort = hub ? 'Port 0' : fast(24);
    addLink(ctx, input.router.key, input.router.port, switchKey, uplinkPort, `${input.title} uplink`);
  }

  const total = count + (input.withServer ? 1 : 0);
  const pcs: string[] = [];
  const hostIps: string[] = [];
  let serverKey: string | null = null;

  for (let index = 0; index < total; index++) {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const inRow = Math.min(4, total - row * 4);
    const offset = (column - (inRow - 1) / 2) * 95;
    const distance = 130 + row * 95;
    const x = switchX + dir.x * distance + sideways.x * offset;
    const y = switchY + dir.y * distance + sideways.y * offset;
    const switchPort = hub ? `Port ${index + 1}` : fast(index + 1);
    const isServer = input.withServer && index === count;

    if (isServer) {
      ctx.counters.server += 1;
      serverKey = `Server${ctx.counters.server}`;
      addDevice(ctx, { key: serverKey, model: 'Server-PT', role: 'server', x, y, group: input.title });
      addLink(ctx, switchKey, switchPort, serverKey, 'FastEthernet0', `${input.title} server`);
      ctx.hosts.push({
        key: serverKey,
        ip: layout.serverIp,
        mask: input.cidr.mask,
        gateway: input.gateway,
        dns: input.dns,
        dhcp: false,
        lan: input.lan,
      });
      addAddress(ctx, serverKey, 'FastEthernet0', layout.serverIp, input.cidr.mask, input.gateway || '-', 'static server address');
      continue;
    }

    ctx.counters.pc += 1;
    const key = `PC${ctx.counters.pc}`;
    const ip = hostAt(input.cidr, layout.hostStart + index);
    addDevice(ctx, { key, model: 'PC-PT', role: 'pc', x, y, group: input.title });
    addLink(ctx, switchKey, switchPort, key, 'FastEthernet0', `${input.title} host`);
    ctx.hosts.push({
      key,
      ip,
      mask: input.cidr.mask,
      gateway: input.gateway,
      dns: input.dns,
      dhcp: input.dhcpHosts,
      lan: input.lan,
    });
    addAddress(ctx, key, 'FastEthernet0', ip, input.cidr.mask, input.gateway || '-', input.dhcpHosts ? 'DHCP lease' : 'static address');
    pcs.push(key);
    hostIps.push(ip);
  }

  return {
    lan: input.lan,
    switchKey,
    pcs,
    server: serverKey,
    serverIp: layout.serverIp,
    hostIps,
    layout,
  };
}

export function relaxLayout(ctx: Builder): void {
  const gap = 88;
  for (let round = 0; round < 24; round++) {
    let moved = false;
    for (let left = 0; left < ctx.devices.length; left++) {
      for (let right = left + 1; right < ctx.devices.length; right++) {
        const first = ctx.devices[left];
        const second = ctx.devices[right];
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (distance >= gap) {
          continue;
        }
        if (distance < 0.01) {
          dx = 1;
          dy = 0;
          distance = 1;
        }
        const push = (gap - distance) / 2;
        const pushX = (dx / distance) * push;
        const pushY = (dy / distance) * push;
        first.x -= pushX;
        first.y -= pushY;
        second.x += pushX;
        second.y += pushY;
        moved = true;
      }
    }
    if (!moved) {
      break;
    }
  }
}

export function normalizeLayout(ctx: Builder): void {
  relaxLayout(ctx);
  if (ctx.devices.length === 0) {
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  for (const device of ctx.devices) {
    minX = Math.min(minX, device.x);
    minY = Math.min(minY, device.y);
  }
  for (const device of ctx.devices) {
    device.x = Math.round(device.x - minX + 70);
    device.y = Math.round(device.y - minY + 60);
  }
}

export function portRuns(numbers: number[]): Array<[number, number]> {
  const sorted = [...numbers].sort((left, right) => left - right);
  const runs: Array<[number, number]> = [];
  let start = -1;
  let prev = -1;
  for (const value of sorted) {
    if (start === -1) {
      start = value;
      prev = value;
      continue;
    }
    if (value === prev + 1) {
      prev = value;
      continue;
    }
    runs.push([start, prev]);
    start = value;
    prev = value;
  }
  if (start !== -1) {
    runs.push([start, prev]);
  }
  return runs;
}

export function webPage(hostname: string): string {
  return `<html><body><h1>Welcome to ${hostname}</h1><p>Served by the CiscoNetX lab web server.</p></body></html>`;
}

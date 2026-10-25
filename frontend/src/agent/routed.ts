import { fmtIp, parseIp } from '../lib/ip.ts';
import {
  blockSize,
  cidrText,
  hostAt,
  makeCidr,
  overlaps,
  parseCidr,
  prefixForHosts,
  usableCount,
  subnetSplit,
  vlsmAllocate,
  wildcardOf,
  type Cidr,
} from './ipam.ts';
import {
  addAddress,
  addCheck,
  addDevice,
  addLink,
  addShow,
  addStep,
  addSubnet,
  buildSegment,
  configOf,
  createBuilder,
  excludedRange,
  gig,
  lanLayout,
  normalizeLayout,
  pushBlock,
  serialPort,
  unitVector,
  webPage,
  type Builder,
  type Point,
  type SegmentResult,
} from './builder.ts';
import { aclView, chooseServerLan, OUTSIDE_LOCATION } from './aclrules.ts';
import { vivaFor } from './knowledge.ts';
import type { FailoverPlan, Plan, PlanServer } from './plan.ts';
import type { AclSpec, LabSpec, Routing, Shape } from './spec.ts';

interface Edge {
  a: number;
  b: number;
  serial: boolean;
}

interface Topology {
  routers: number;
  shape: Shape;
  edges: Edge[];
  owner: number[];
}

interface LanIf {
  lan: number;
  port: string;
  ip: string;
  cidr: Cidr;
}

interface WanIf {
  edge: number;
  port: string;
  ip: string;
  cidr: Cidr;
  peer: number;
  serial: boolean;
  dce: boolean;
}

interface RouterInfo {
  index: number;
  key: string;
  gigNext: number;
  serialNext: number;
  lanIfs: LanIf[];
  wanIfs: WanIf[];
  isp: { port: string; ip: string } | null;
  pos: Point;
  dir: Point;
}

const ISP_LINK = makeCidr('198.51.100.0', 30);
const OUTSIDE_LAN = makeCidr('203.0.113.0', 24);
const OUTSIDE_SERVER_IP = '203.0.113.10';
const OUTSIDE_GATEWAY = '203.0.113.1';
const GIG_PORTS = 3;
const SERIAL_PORTS = 4;

function edgesFor(count: number, shape: Shape): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  if (count < 2) {
    return edges;
  }
  if (shape === 'star') {
    for (let index = 1; index < count; index++) {
      edges.push([0, index]);
    }
    return edges;
  }
  for (let index = 0; index < count - 1; index++) {
    edges.push([index, index + 1]);
  }
  if (shape === 'ring' && count >= 3) {
    edges.push([0, count - 1]);
  }
  return edges;
}

function assignLans(lans: number, routers: number, nat: boolean): number[] | null {
  const owner: number[] = [];
  if (lans <= routers) {
    for (let index = 0; index < lans; index++) {
      if (lans === 1) {
        owner.push(0);
      } else {
        owner.push(Math.round((index * (routers - 1)) / (lans - 1)));
      }
    }
  } else {
    const base = Math.floor(lans / routers);
    const extra = lans % routers;
    for (let router = 0; router < routers; router++) {
      const share = base + (router < extra ? 1 : 0);
      for (let step = 0; step < share; step++) {
        owner.push(router);
      }
    }
  }

  const counts: number[] = new Array(routers).fill(0);
  for (const router of owner) {
    counts[router] += 1;
  }
  const capacity: number[] = [];
  for (let router = 0; router < routers; router++) {
    capacity.push(GIG_PORTS - (nat && router === 0 ? 1 : 0));
  }

  for (let guard = 0; guard < 200; guard++) {
    let over = -1;
    for (let router = 0; router < routers; router++) {
      if (counts[router] > capacity[router]) {
        over = router;
        break;
      }
    }
    if (over === -1) {
      return owner;
    }
    let target = -1;
    let best = Infinity;
    for (let router = 0; router < routers; router++) {
      if (router === over) {
        continue;
      }
      if (counts[router] < capacity[router] && counts[router] < best) {
        best = counts[router];
        target = router;
      }
    }
    if (target === -1) {
      return null;
    }
    let lan = owner.length - 1;
    while (lan >= 0 && owner[lan] !== over) {
      lan -= 1;
    }
    owner[lan] = target;
    counts[over] -= 1;
    counts[target] += 1;
  }
  return null;
}

function chooseMedia(
  edges: Array<[number, number]>,
  routers: number,
  owner: number[],
  nat: boolean,
  wantSerial: boolean,
): boolean[] | null {
  const gigUsed: number[] = new Array(routers).fill(0);
  const serialUsed: number[] = new Array(routers).fill(0);
  for (const router of owner) {
    gigUsed[router] += 1;
  }
  if (nat) {
    gigUsed[0] += 1;
  }
  const media: boolean[] = [];
  for (const [first, second] of edges) {
    const gigRoom = gigUsed[first] < GIG_PORTS && gigUsed[second] < GIG_PORTS;
    const serialRoom = serialUsed[first] < SERIAL_PORTS && serialUsed[second] < SERIAL_PORTS;
    let serial = false;
    if (wantSerial && serialRoom) {
      serial = true;
    } else if (gigRoom) {
      serial = false;
    } else if (serialRoom) {
      serial = true;
    } else {
      return null;
    }
    if (serial) {
      serialUsed[first] += 1;
      serialUsed[second] += 1;
    } else {
      gigUsed[first] += 1;
      gigUsed[second] += 1;
    }
    media.push(serial);
  }
  return media;
}

function planTopology(spec: LabSpec, notes: string[]): Topology | null {
  const shapes: Shape[] = [spec.shape];
  if (spec.shape === 'star') {
    shapes.push('ring');
  }
  if (spec.shape !== 'chain') {
    shapes.push('chain');
  }

  for (let count = spec.routers; count <= 12; count++) {
    for (const wanted of shapes) {
      const shape: Shape = count < 3 ? 'chain' : wanted;
      const pairs = edgesFor(count, shape);
      const owner = assignLans(spec.lans, count, spec.nat);
      if (!owner) {
        continue;
      }
      const media = chooseMedia(pairs, count, owner, spec.nat, spec.wan === 'serial');
      if (!media) {
        continue;
      }
      if (count > spec.routers) {
        notes.push(`${count} routers were used instead of ${spec.routers} because a Cisco 2911 has only ${GIG_PORTS} Gigabit ports and the lab needs more interfaces.`);
      }
      if (shape !== spec.shape && spec.routers >= 3 && count === spec.routers) {
        notes.push(`The ${spec.shape} topology needs more interfaces than a 2911 offers, so a ${shape} was used.`);
      }
      const edges: Edge[] = pairs.map(([a, b], index) => ({ a, b, serial: media[index] }));
      const swapped = edges.some(edge => !edge.serial) && spec.wan === 'serial';
      if (swapped) {
        notes.push('Some links use Gigabit Ethernet because the routers ran out of serial ports.');
      }
      const forced = edges.some(edge => edge.serial) && spec.wan !== 'serial';
      if (forced) {
        notes.push('Some links use serial cables because the routers ran out of Gigabit ports.');
      }
      return { routers: count, shape, edges, owner };
    }
  }
  return null;
}

function firstHops(count: number, edges: Edge[]): number[][] {
  const neighbors: number[][] = [];
  for (let index = 0; index < count; index++) {
    neighbors.push([]);
  }
  for (const edge of edges) {
    neighbors[edge.a].push(edge.b);
    neighbors[edge.b].push(edge.a);
  }
  for (const list of neighbors) {
    list.sort((left, right) => left - right);
  }

  const result: number[][] = [];
  for (let from = 0; from < count; from++) {
    const first: number[] = new Array(count).fill(-1);
    const seen: boolean[] = new Array(count).fill(false);
    const queue: number[] = [];
    seen[from] = true;
    for (const next of neighbors[from]) {
      seen[next] = true;
      first[next] = next;
      queue.push(next);
    }
    while (queue.length > 0) {
      const curr = queue.shift() as number;
      for (const next of neighbors[curr]) {
        if (!seen[next]) {
          seen[next] = true;
          first[next] = first[curr];
          queue.push(next);
        }
      }
    }
    result.push(first);
  }
  return result;
}

function edgeBetween(edges: Edge[], first: number, second: number): number {
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index];
    if ((edge.a === first && edge.b === second) || (edge.a === second && edge.b === first)) {
      return index;
    }
  }
  return -1;
}

function stillConnected(count: number, edges: Edge[], skip: number, from: number, to: number): boolean {
  const seen: boolean[] = new Array(count).fill(false);
  const queue: number[] = [from];
  seen[from] = true;
  while (queue.length > 0) {
    const curr = queue.shift() as number;
    if (curr === to) {
      return true;
    }
    for (let index = 0; index < edges.length; index++) {
      if (index === skip) {
        continue;
      }
      const edge = edges[index];
      let next = -1;
      if (edge.a === curr) {
        next = edge.b;
      } else if (edge.b === curr) {
        next = edge.a;
      }
      if (next !== -1 && !seen[next]) {
        seen[next] = true;
        queue.push(next);
      }
    }
  }
  return false;
}

function autoParent(requests: Array<{ index: number; hosts: number }>): Cidr {
  let total = 0;
  for (const request of requests) {
    total += blockSize(prefixForHosts(request.hosts));
  }
  const bits = Math.max(2, Math.ceil(Math.log2(total)));
  const base = bits > 16 ? '10.0.0.0' : '192.168.0.0';
  return makeCidr(base, Math.max(8, 32 - bits));
}

function defaultLans(count: number, taken: Cidr[]): Cidr[] {
  const result: Cidr[] = [];
  let third = 1;
  while (result.length < count && third < 250) {
    const candidate = makeCidr(`192.168.${third}.0`, 24);
    const clash = taken.some(item => overlaps(item, candidate)) || result.some(item => overlaps(item, candidate));
    if (!clash) {
      result.push(candidate);
    }
    third += 1;
  }
  return result;
}

function allocateLans(ctx: Builder, spec: LabSpec): Cidr[] {
  const lans = spec.lans;

  if (spec.hostRequirements.length > 0) {
    const requests = spec.hostRequirements.map((hosts, index) => ({ index, hosts }));
    const given = spec.networks.length > 0 ? parseCidr(spec.networks[0]) : null;
    if (given) {
      const attempt = vlsmAllocate(given, requests);
      if (attempt.error === null) {
        ctx.notes.push(`VLSM carved ${cidrText(given)} into ${requests.length} subnets, largest requirement first.`);
        return attempt.allocations.map(item => item.cidr);
      }
      ctx.notes.push(`${attempt.error} A larger block was used instead.`);
    }
    const parent = autoParent(requests);
    const outcome = vlsmAllocate(parent, requests);
    ctx.notes.push(`No address block was given, so ${cidrText(parent)} was divided with VLSM, largest requirement first.`);
    return outcome.allocations.map(item => item.cidr);
  }

  const parsed: Cidr[] = [];
  for (const text of spec.networks) {
    const cidr = parseCidr(text);
    if (cidr && cidr.prefix <= 30) {
      parsed.push(cidr);
    }
  }

  if (parsed.length >= 2) {
    const chosen = parsed.slice(0, lans);
    if (chosen.length < lans) {
      chosen.push(...defaultLans(lans - chosen.length, chosen));
    }
    return chosen;
  }

  if (parsed.length === 1) {
    if (lans === 1) {
      return [parsed[0]];
    }
    const pieces = subnetSplit(parsed[0], lans);
    if (pieces) {
      ctx.notes.push(`${cidrText(parsed[0])} was split into ${lans} equal subnets.`);
      return pieces;
    }
    ctx.notes.push(`${cidrText(parsed[0])} cannot be split into ${lans} subnets, so default subnets were used.`);
  }

  return defaultLans(lans, []);
}

function linkBase(lanCidrs: Cidr[]): string {
  const bases = ['10.0.0.0', '172.16.0.0', '10.200.0.0', '100.64.0.0'];
  for (const base of bases) {
    const block = makeCidr(base, 16);
    const clash = lanCidrs.some(item => overlaps(block, item));
    if (!clash) {
      return base;
    }
  }
  return '10.250.0.0';
}

function routerPlacement(count: number, shape: Shape): Array<{ pos: Point; dir: Point }> {
  const result: Array<{ pos: Point; dir: Point }> = [];
  if (count === 1) {
    result.push({ pos: { x: 0, y: 0 }, dir: { x: 0, y: 1 } });
    return result;
  }
  if (shape === 'chain') {
    for (let index = 0; index < count; index++) {
      result.push({ pos: { x: index * 380, y: 0 }, dir: { x: 0, y: 1 } });
    }
    return result;
  }
  if (shape === 'ring') {
    const radius = Math.max(250, count * 75);
    for (let index = 0; index < count; index++) {
      const angle = ((-90 + (360 * index) / count) * Math.PI) / 180;
      const pos = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
      result.push({ pos, dir: unitVector(pos.x, pos.y) });
    }
    return result;
  }
  result.push({ pos: { x: 0, y: 0 }, dir: { x: 0, y: 1 } });
  const spokes = count - 1;
  const radius = Math.max(320, spokes * 80);
  for (let index = 0; index < spokes; index++) {
    const angle = ((-90 + (360 * (index + 0.5)) / spokes) * Math.PI) / 180;
    const pos = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    result.push({ pos, dir: unitVector(pos.x, pos.y) });
  }
  return result;
}

function protocolLabel(routing: Routing): string {
  if (routing === 'static') {
    return 'static routes';
  }
  if (routing === 'none') {
    return 'no routing protocol';
  }
  return routing.toUpperCase();
}

function classfulBase(ip: string): string {
  const value = parseIp(ip) ?? 0;
  const first = Math.floor(value / 16777216);
  if (first < 128) {
    return fmtIp(Math.floor(value / 16777216) * 16777216);
  }
  if (first < 192) {
    return fmtIp(Math.floor(value / 65536) * 65536);
  }
  return fmtIp(Math.floor(value / 256) * 256);
}

function routeCodes(routing: Routing): string[] {
  if (routing === 'ospf') {
    return ['O'];
  }
  if (routing === 'rip') {
    return ['R'];
  }
  if (routing === 'eigrp') {
    return ['D'];
  }
  return ['S'];
}

function defaultCodes(routing: Routing): string[] {
  if (routing === 'ospf') {
    return ['O*E2'];
  }
  if (routing === 'rip') {
    return ['R'];
  }
  if (routing === 'eigrp') {
    return ['D EX'];
  }
  return ['S'];
}

function pairsToCheck(lans: number): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  if (lans <= 5) {
    for (let first = 0; first < lans; first++) {
      for (let second = first + 1; second < lans; second++) {
        pairs.push([first, second]);
      }
    }
    return pairs;
  }
  for (let first = 0; first < lans - 1; first++) {
    pairs.push([first, first + 1]);
  }
  for (let second = 2; second < lans; second++) {
    pairs.push([0, second]);
  }
  return pairs;
}

export function aclNumber(acl: AclSpec): string {
  return acl.style === 'standard' ? '10' : '101';
}

function serverRoomFix(spec: LabSpec): { spec: LabSpec; note: string | null } {
  if (spec.hostRequirements.length === 0) {
    return { spec, note: null };
  }
  const acl = spec.acl;
  const aclServer = acl !== null && acl.to === -1;
  const aclHttpToLan = acl !== null && acl.to >= 0 && acl.service === 'http';
  const wantsWeb = spec.dns || spec.http || aclServer || aclHttpToLan;
  const webOutside = spec.nat && wantsWeb && !aclHttpToLan;
  const insideServer = (wantsWeb && !webOutside) || spec.dhcp === 'server';
  if (!insideServer) {
    return { spec, note: null };
  }

  const forbidden = acl !== null && aclServer ? acl.from : -1;
  let target = 0;
  if (acl !== null && aclHttpToLan) {
    target = acl.to;
  } else {
    if (acl !== null && aclServer) {
      target = acl.from === 0 ? 1 : 0;
    }
    const roomy = spec.hostRequirements.some((hosts, index) => hosts >= 4 && index !== forbidden);
    if (roomy) {
      return { spec, note: null };
    }
  }
  if (target >= spec.hostRequirements.length || spec.hostRequirements[target] >= 4) {
    return { spec, note: null };
  }
  const requirements = [...spec.hostRequirements];
  requirements[target] = 4;
  return {
    spec: { ...spec, hostRequirements: requirements },
    note: `LAN ${target + 1} was given room for 4 hosts so the server fits next to the PCs.`,
  };
}

export function buildRouted(input: LabSpec): Plan {
  const fixed = serverRoomFix(input);
  const spec = fixed.spec;
  const ctx = createBuilder(spec);
  if (fixed.note) {
    ctx.notes.push(fixed.note);
  }
  const lanCidrs = allocateLans(ctx, spec);
  const lanCount = lanCidrs.length;
  const topology = planTopology({ ...spec, lans: lanCount }, ctx.notes);
  if (!topology) {
    throw new Error('This lab needs more router interfaces than the available models provide. Try fewer LANs or routers.');
  }

  const routerCount = topology.routers;
  let routing: Routing = spec.routing;
  if (routerCount > 1 && routing === 'none') {
    routing = 'ospf';
    ctx.notes.push('More than one router needs routing, so OSPF was used.');
  }
  if (routerCount === 1) {
    routing = 'none';
  }
  const dynamic = routing === 'ospf' || routing === 'rip' || routing === 'eigrp';

  const nat = spec.nat;
  const aclInput = spec.acl;
  let acl: AclSpec | null = aclInput ? { ...aclInput } : null;
  if (acl && acl.style === 'standard' && nat && acl.to === -1) {
    acl.style = 'extended';
    ctx.notes.push('A standard ACL cannot be applied before NAT translation, so an extended ACL was used to block the server.');
  }
  const aclHttpToLan = acl !== null && acl.to >= 0 && acl.service === 'http';
  const aclServer = acl !== null && acl.to === -1;

  let preferredLan = 0;
  if (acl) {
    if (acl.to === -1) {
      preferredLan = acl.from === 0 ? 1 : 0;
    } else if (acl.service === 'http') {
      preferredLan = acl.to;
    }
  }
  if (preferredLan >= lanCount) {
    preferredLan = 0;
  }
  const pinnedServerLan = acl !== null && acl.to >= 0 && acl.service === 'http';
  let serverLan = preferredLan;
  if (!pinnedServerLan) {
    serverLan = chooseServerLan(lanCidrs, preferredLan, acl !== null && acl.to === -1 ? acl.from : -1);
  }
  if (pinnedServerLan && acl && usableCount(lanCidrs[acl.to].prefix) < 4) {
    const moved = chooseServerLan(lanCidrs, acl.to, acl.from);
    if (moved !== acl.to) {
      ctx.notes.push(`LAN ${acl.to + 1} is too small to hold a server, so the web server and the ACL target moved to LAN ${moved + 1}.`);
      acl.to = moved;
      serverLan = moved;
    }
  }
  const view = aclView(acl, serverLan);

  const wantsWeb = spec.dns || spec.http || aclServer || aclHttpToLan;
  const webOutside = nat && wantsWeb && !aclHttpToLan;
  const webInside = wantsWeb && !webOutside;
  const dhcpServer = spec.dhcp === 'server';
  const insideServer = webInside || dhcpServer;
  let webIp = '';
  if (webOutside) {
    webIp = OUTSIDE_SERVER_IP;
  }

  const dnsIp = spec.dns && wantsWeb ? (webOutside ? OUTSIDE_SERVER_IP : lanLayout(lanCidrs[serverLan]).serverIp) : '';
  if (webInside) {
    webIp = lanLayout(lanCidrs[serverLan]).serverIp;
  }

  const placement = routerPlacement(routerCount, topology.shape);
  const infos: RouterInfo[] = [];
  for (let index = 0; index < routerCount; index++) {
    infos.push({
      index,
      key: `R${index + 1}`,
      gigNext: 0,
      serialNext: 0,
      lanIfs: [],
      wanIfs: [],
      isp: null,
      pos: placement[index].pos,
      dir: placement[index].dir,
    });
  }

  for (let lan = 0; lan < lanCount; lan++) {
    const info = infos[topology.owner[lan]];
    const port = gig(info.gigNext);
    info.gigNext += 1;
    info.lanIfs.push({ lan, port, ip: lanLayout(lanCidrs[lan]).gateway, cidr: lanCidrs[lan] });
  }

  const base = linkBase(lanCidrs);
  const baseValue = parseIp(base) ?? 0;
  const edgeLinkIndex: number[] = [];
  const edgeCidrs: Cidr[] = [];

  topology.edges.forEach((edge, index) => {
    const cidr = makeCidr(fmtIp(baseValue + index * 4), 30);
    edgeCidrs.push(cidr);
    const first = infos[edge.a];
    const second = infos[edge.b];
    let firstPort = '';
    let secondPort = '';
    if (edge.serial) {
      firstPort = serialPort(first.serialNext);
      first.serialNext += 1;
      secondPort = serialPort(second.serialNext);
      second.serialNext += 1;
    } else {
      firstPort = gig(first.gigNext);
      first.gigNext += 1;
      secondPort = gig(second.gigNext);
      second.gigNext += 1;
    }
    first.wanIfs.push({ edge: index, port: firstPort, ip: hostAt(cidr, 1), cidr, peer: edge.b, serial: edge.serial, dce: true });
    second.wanIfs.push({ edge: index, port: secondPort, ip: hostAt(cidr, 2), cidr, peer: edge.a, serial: edge.serial, dce: false });
  });

  if (nat) {
    const edgeInfo = infos[0];
    edgeInfo.isp = { port: gig(edgeInfo.gigNext), ip: hostAt(ISP_LINK, 2) };
    edgeInfo.gigNext += 1;
  }

  for (const info of infos) {
    const serialCount = info.serialNext;
    const modules: Array<string | null> = [null, null];
    if (serialCount > 0) {
      modules[0] = 'HWIC-2T';
    }
    if (serialCount > 2) {
      modules[1] = 'HWIC-2T';
    }
    addDevice(ctx, {
      key: info.key,
      model: '2911',
      role: 'router',
      x: info.pos.x,
      y: info.pos.y,
      group: 'Routers',
      modules,
    });
  }

  topology.edges.forEach((edge, index) => {
    const first = infos[edge.a];
    const second = infos[edge.b];
    const firstIf = first.wanIfs.find(item => item.edge === index) as WanIf;
    const secondIf = second.wanIfs.find(item => item.edge === index) as WanIf;
    const label = `${first.key} to ${second.key} (${edge.serial ? 'serial' : 'Ethernet'} WAN)`;
    const linkIndex = addLink(ctx, first.key, firstIf.port, second.key, secondIf.port, label, edge.serial);
    edgeLinkIndex.push(linkIndex);
  });

  const hostsPerLan = spec.hostsPerLan;
  const dhcpHosts = spec.dhcp !== 'none';
  const relayBlocked: boolean[] = lanCidrs.map((_, lan) => dhcpServer && view.dhcpRelayBlocked(lan, serverLan));
  if (relayBlocked.some(item => item)) {
    ctx.notes.push('The standard ACL also drops the DHCP relay packets of the blocked LAN, so its PCs use static addresses.');
  }
  const segments: SegmentResult[] = [];

  for (let lan = 0; lan < lanCount; lan++) {
    const info = infos[topology.owner[lan]];
    const lanIf = info.lanIfs.find(item => item.lan === lan) as LanIf;
    const slot = info.lanIfs.indexOf(lanIf);
    const siblings = info.lanIfs.length;
    const spread = siblings > 1 ? (slot - (siblings - 1) / 2) * 0.9 : 0;
    const sideways: Point = { x: -info.dir.y, y: info.dir.x };
    const dir = unitVector(info.dir.x + sideways.x * spread, info.dir.y + sideways.y * spread);
    const segment = buildSegment(ctx, {
      lan,
      title: `LAN ${lan + 1}`,
      cidr: lanCidrs[lan],
      gateway: lanIf.ip,
      router: { key: info.key, port: lanIf.port },
      hostCount: hostsPerLan,
      withServer: insideServer && lan === serverLan,
      dhcpHosts: dhcpHosts && !relayBlocked[lan],
      dns: dnsIp,
      origin: info.pos,
      dir,
    });
    segments.push(segment);
  }

  let ispKey = '';
  let outsideKey = '';
  if (nat) {
    const edgePos = infos[0].pos;
    let ispPos: Point = { x: edgePos.x - 380, y: edgePos.y };
    let outsidePos: Point = { x: edgePos.x - 700, y: edgePos.y };
    if (topology.shape === 'ring' && routerCount >= 3) {
      ispPos = { x: edgePos.x - 380, y: edgePos.y - 40 };
      outsidePos = { x: edgePos.x - 700, y: edgePos.y - 40 };
    }
    if (topology.shape === 'star' && routerCount >= 3) {
      ispPos = { x: edgePos.x, y: edgePos.y - 320 };
      outsidePos = { x: edgePos.x, y: edgePos.y - 560 };
    }
    ispKey = 'ISP';
    outsideKey = 'ExtServer';
    addDevice(ctx, { key: ispKey, model: '2911', role: 'isp', x: ispPos.x, y: ispPos.y, group: 'Internet' });
    addDevice(ctx, { key: outsideKey, model: 'Server-PT', role: 'server', x: outsidePos.x, y: outsidePos.y, group: 'Internet' });
    addLink(ctx, infos[0].key, (infos[0].isp as { port: string }).port, ispKey, gig(0), 'Edge router to ISP');
    addLink(ctx, ispKey, gig(1), outsideKey, 'FastEthernet0', 'ISP to outside server');
    ctx.hosts.push({
      key: outsideKey,
      ip: OUTSIDE_SERVER_IP,
      mask: OUTSIDE_LAN.mask,
      gateway: OUTSIDE_GATEWAY,
      dns: '',
      dhcp: false,
      lan: -1,
    });
  }

  const firstHosts: string[] = segments.map(item => item.pcs[0] ?? '');
  const lanName = (lan: number): string => `LAN ${lan + 1}`;
  const gatewayOf = (lan: number): LanIf => {
    const info = infos[topology.owner[lan]];
    return info.lanIfs.find(item => item.lan === lan) as LanIf;
  };

  const hops = firstHops(routerCount, topology.edges);
  const wanTo = (from: number, to: number): { mine: WanIf; theirs: WanIf } | null => {
    const edge = edgeBetween(topology.edges, from, to);
    if (edge === -1) {
      return null;
    }
    const mine = infos[from].wanIfs.find(item => item.edge === edge) as WanIf;
    const theirs = infos[to].wanIfs.find(item => item.edge === edge) as WanIf;
    return { mine, theirs };
  };

  const serverKey = segments[serverLan]?.server ?? null;
  const serverHttpHost = webOutside ? outsideKey : serverKey;
  const aclRouter = acl ? infos[topology.owner[acl.from]] : null;
  const aclFromIf = acl ? gatewayOf(acl.from) : null;
  let aclHostTarget = '';
  if (acl && acl.to === -1) {
    aclHostTarget = webOutside ? OUTSIDE_SERVER_IP : (serverKey ? lanLayout(lanCidrs[serverLan]).serverIp : '');
  }

  for (const info of infos) {
    const config = configOf(ctx, info.key, `${info.key} configuration`);
    const lines = config.lines;
    lines.push(`hostname ${info.key}`);

    for (const lanIf of info.lanIfs) {
      const body: string[] = [`description ${lanName(lanIf.lan)} gateway`, `ip address ${lanIf.ip} ${lanIf.cidr.mask}`];
      if (nat && info.index === 0) {
        body.push('ip nat inside');
      }
      if (dhcpServer && lanIf.lan !== serverLan && segments[serverLan]?.server) {
        body.push(`ip helper-address ${lanLayout(lanCidrs[serverLan]).serverIp}`);
      }
      if (acl && acl.style === 'extended' && lanIf.lan === acl.from) {
        body.push(`ip access-group ${aclNumber(acl)} in`);
      }
      if (acl && acl.style === 'standard') {
        const target = acl.to === -1 ? serverLan : acl.to;
        if (lanIf.lan === target) {
          body.push(`ip access-group ${aclNumber(acl)} out`);
        }
      }
      body.push('no shutdown');
      pushBlock(lines, `interface ${lanIf.port}`, body);
    }

    for (const wanIf of info.wanIfs) {
      const peerKey = infos[wanIf.peer].key;
      const body: string[] = [`description Link to ${peerKey}`, `ip address ${wanIf.ip} ${wanIf.cidr.mask}`];
      if (wanIf.serial && wanIf.dce) {
        body.push('clock rate 64000');
      }
      if (nat && info.index === 0) {
        body.push('ip nat inside');
      }
      body.push('no shutdown');
      pushBlock(lines, `interface ${wanIf.port}`, body);
    }

    if (info.isp) {
      pushBlock(lines, `interface ${info.isp.port}`, [
        'description Link to ISP',
        `ip address ${info.isp.ip} ${ISP_LINK.mask}`,
        'ip nat outside',
        'no shutdown',
      ]);
    }

    if (nat && info.index === 0) {
      for (const lanIf of infos.flatMap(item => item.lanIfs)) {
        lines.push(`access-list 1 permit ${lanIf.cidr.network} ${wildcardOf(lanIf.cidr.prefix)}`);
      }
      lines.push(`ip nat inside source list 1 interface ${(info.isp as { port: string }).port} overload`);
      lines.push(`ip route 0.0.0.0 0.0.0.0 ${hostAt(ISP_LINK, 1)}`);
    }

    if (acl && aclRouter && aclFromIf) {
      const number = aclNumber(acl);
      const fromCidr = lanCidrs[acl.from];
      if (acl.style === 'extended' && info.index === aclRouter.index) {
        let protocol = 'ip';
        let suffix = '';
        if (acl.service === 'icmp') {
          protocol = 'icmp';
        }
        if (acl.service === 'http') {
          protocol = 'tcp';
          suffix = ' eq 80';
        }
        let destination = '';
        if (acl.to === -1) {
          destination = `host ${aclHostTarget}`;
        } else {
          destination = `${lanCidrs[acl.to].network} ${wildcardOf(lanCidrs[acl.to].prefix)}`;
        }
        lines.push(`access-list ${number} deny ${protocol} ${fromCidr.network} ${wildcardOf(fromCidr.prefix)} ${destination}${suffix}`);
        lines.push(`access-list ${number} permit ip any any`);
      }
      if (acl.style === 'standard') {
        const target = acl.to === -1 ? serverLan : acl.to;
        if (info.index === topology.owner[target]) {
          lines.push(`access-list ${number} deny ${fromCidr.network} ${wildcardOf(fromCidr.prefix)}`);
          lines.push('access-list 10 permit any');
        }
      }
    }

    if (spec.dhcp === 'router') {
      for (const lanIf of info.lanIfs) {
        const [low, high] = excludedRange(lanIf.cidr);
        lines.push(`ip dhcp excluded-address ${low} ${high}`);
        const body: string[] = [
          `network ${lanIf.cidr.network} ${lanIf.cidr.mask}`,
          `default-router ${lanIf.ip}`,
        ];
        if (dnsIp) {
          body.push(`dns-server ${dnsIp}`);
        }
        pushBlock(lines, `ip dhcp pool LAN${lanIf.lan + 1}`, body);
      }
    }

    const connected: Array<{ network: string; prefix: number; ip: string; mask: string; port: string; lan: boolean }> = [];
    for (const lanIf of info.lanIfs) {
      connected.push({ network: lanIf.cidr.network, prefix: lanIf.cidr.prefix, ip: lanIf.ip, mask: lanIf.cidr.mask, port: lanIf.port, lan: true });
    }
    for (const wanIf of info.wanIfs) {
      connected.push({ network: wanIf.cidr.network, prefix: wanIf.cidr.prefix, ip: wanIf.ip, mask: wanIf.cidr.mask, port: wanIf.port, lan: false });
    }
    const passives = connected.filter(item => item.lan);
    const isEdge = nat && info.index === 0;

    if (routing === 'ospf') {
      const body: string[] = [`router-id ${info.index + 1}.${info.index + 1}.${info.index + 1}.${info.index + 1}`];
      for (const item of connected) {
        body.push(`network ${item.network} ${wildcardOf(item.prefix)} area 0`);
      }
      for (const item of passives) {
        body.push(`passive-interface ${item.port}`);
      }
      if (isEdge) {
        body.push('default-information originate');
      }
      pushBlock(lines, 'router ospf 1', body);
    }

    if (routing === 'rip') {
      const body: string[] = ['version 2', 'no auto-summary'];
      const seen = new Set<string>();
      for (const item of connected) {
        const classful = classfulBase(item.ip);
        if (!seen.has(classful)) {
          seen.add(classful);
          body.push(`network ${classful}`);
        }
      }
      for (const item of passives) {
        body.push(`passive-interface ${item.port}`);
      }
      if (isEdge) {
        body.push('default-information originate');
      }
      pushBlock(lines, 'router rip', body);
    }

    if (routing === 'eigrp') {
      const body: string[] = [];
      for (const item of connected) {
        body.push(`network ${item.network} ${wildcardOf(item.prefix)}`);
      }
      body.push('no auto-summary');
      for (const item of passives) {
        body.push(`passive-interface ${item.port}`);
      }
      if (isEdge) {
        body.push('redistribute static');
      }
      pushBlock(lines, 'router eigrp 100', body);
    }

    if (routing === 'static') {
      for (let lan = 0; lan < lanCount; lan++) {
        const owner = topology.owner[lan];
        if (owner === info.index) {
          continue;
        }
        const hop = hops[info.index][owner];
        if (hop === -1) {
          continue;
        }
        const link = wanTo(info.index, hop);
        if (!link) {
          continue;
        }
        lines.push(`ip route ${lanCidrs[lan].network} ${lanCidrs[lan].mask} ${link.theirs.ip}`);
      }
      if (nat && info.index !== 0) {
        const hop = hops[info.index][0];
        const link = hop === -1 ? null : wanTo(info.index, hop);
        if (link) {
          lines.push(`ip route 0.0.0.0 0.0.0.0 ${link.theirs.ip}`);
        }
      }
    }
  }

  if (nat) {
    const ispConfig = configOf(ctx, ispKey, 'ISP configuration');
    ispConfig.lines.push('hostname ISP');
    pushBlock(ispConfig.lines, `interface ${gig(0)}`, [
      'description Link to edge router',
      `ip address ${hostAt(ISP_LINK, 1)} ${ISP_LINK.mask}`,
      'no shutdown',
    ]);
    pushBlock(ispConfig.lines, `interface ${gig(1)}`, [
      'description Internet servers',
      `ip address ${OUTSIDE_GATEWAY} ${OUTSIDE_LAN.mask}`,
      'no shutdown',
    ]);
  }

  for (const segment of segments) {
    const switchConfig = configOf(ctx, segment.switchKey, `${segment.switchKey} configuration`);
    if (!segment.switchKey.startsWith('HUB')) {
      switchConfig.lines.push(`hostname ${segment.switchKey}`);
      pushBlock(switchConfig.lines, 'interface FastEthernet0/24', [`description Uplink to ${infos[topology.owner[segment.lan]].key}`]);
    }
  }

  const pools = lanCidrs.map((cidr, lan) => {
    const layout = lanLayout(cidr);
    return {
      name: `LAN${lan + 1}`,
      gateway: layout.gateway,
      dns: dnsIp || '0.0.0.0',
      start: hostAt(cidr, layout.hostStart),
      mask: cidr.mask,
      max: layout.poolMax,
    };
  });

  const records = spec.dns && wantsWeb ? [{ name: spec.hostname, ip: webIp }] : [];
  const servers: PlanServer[] = [];
  if (serverKey) {
    servers.push({
      key: serverKey,
      http: webInside,
      html: webPage(spec.hostname),
      dns: webInside && spec.dns,
      records: webInside ? records : [],
      dhcp: dhcpServer,
      pools: dhcpServer ? pools : [],
    });
  }
  if (nat) {
    servers.push({
      key: outsideKey,
      http: true,
      html: webPage(spec.hostname),
      dns: webOutside && spec.dns,
      records: webOutside ? records : [],
      dhcp: false,
      pools: [],
    });
  }
  ctx.servers.push(...servers);

  for (const info of infos) {
    for (const lanIf of info.lanIfs) {
      addAddress(ctx, info.key, lanIf.port, lanIf.ip, lanIf.cidr.mask, '-', `${lanName(lanIf.lan)} default gateway`);
    }
    for (const wanIf of info.wanIfs) {
      addAddress(ctx, info.key, wanIf.port, wanIf.ip, wanIf.cidr.mask, '-', `Link to ${infos[wanIf.peer].key}`);
    }
    if (info.isp) {
      addAddress(ctx, info.key, info.isp.port, info.isp.ip, ISP_LINK.mask, hostAt(ISP_LINK, 1), 'Link to ISP (NAT outside)');
    }
  }
  if (nat) {
    addAddress(ctx, ispKey, gig(0), hostAt(ISP_LINK, 1), ISP_LINK.mask, '-', 'Link to edge router');
    addAddress(ctx, ispKey, gig(1), OUTSIDE_GATEWAY, OUTSIDE_LAN.mask, '-', 'Internet servers gateway');
    addAddress(ctx, outsideKey, 'FastEthernet0', OUTSIDE_SERVER_IP, OUTSIDE_LAN.mask, OUTSIDE_GATEWAY, 'outside web/DNS server');
  }

  lanCidrs.forEach((cidr, lan) => {
    const required = spec.hostRequirements[lan] ?? null;
    const purpose = required === null ? `${lanName(lan)} on ${infos[topology.owner[lan]].key}` : `${lanName(lan)} needs ${required} hosts`;
    addSubnet(ctx, lanName(lan), cidr, purpose, required);
  });
  topology.edges.forEach((edge, index) => {
    addSubnet(ctx, `Link ${infos[edge.a].key}-${infos[edge.b].key}`, edgeCidrs[index], 'Point-to-point WAN link', null);
  });
  if (nat) {
    addSubnet(ctx, 'ISP link', ISP_LINK, 'Edge router to ISP (public)', null);
    addSubnet(ctx, 'Internet', OUTSIDE_LAN, 'Outside servers', null);
  }

  for (let lan = 0; lan < lanCount; lan++) {
    const host = firstHosts[lan];
    if (!host) {
      continue;
    }
    addCheck(ctx, {
      kind: 'ping',
      category: 'connectivity',
      label: `${host} reaches its gateway ${gatewayOf(lan).ip}`,
      from: host,
      toIp: gatewayOf(lan).ip,
      expect: 'pass',
    });
    const mates = segments[lan].pcs;
    if (mates.length >= 2) {
      addCheck(ctx, {
        kind: 'ping',
        category: 'layer2',
        label: `${host} reaches ${mates[1]} in the same LAN`,
        from: host,
        toKey: mates[1],
        expect: 'pass',
      });
    }
  }

  for (const [first, second] of pairsToCheck(lanCount)) {
    const from = firstHosts[first];
    const to = firstHosts[second];
    if (!from || !to) {
      continue;
    }
    const blocked = view.pairBlocked(first, second);
    addCheck(ctx, {
      kind: 'ping',
      category: blocked ? 'security' : 'connectivity',
      label: blocked ? `${from} (${lanName(first)}) is blocked from ${to} (${lanName(second)}) by the ACL` : `${from} (${lanName(first)}) reaches ${to} (${lanName(second)})`,
      from,
      toKey: to,
      expect: blocked ? 'fail' : 'pass',
    });
  }

  const pingTargets: Array<{ key: string; outside: boolean }> = [];
  if (serverKey) {
    pingTargets.push({ key: serverKey, outside: false });
  }
  if (nat) {
    pingTargets.push({ key: outsideKey, outside: true });
  }
  for (const target of pingTargets) {
    for (let lan = 0; lan < lanCount; lan++) {
      const host = firstHosts[lan];
      if (!host || host === target.key) {
        continue;
      }
      const blocked = target.outside
        ? view.serverBlocked(lan, 'ping', OUTSIDE_LOCATION, aclServer && webOutside)
        : view.serverBlocked(lan, 'ping', serverLan, aclServer && !webOutside);
      addCheck(ctx, {
        kind: 'ping',
        category: blocked ? 'security' : 'connectivity',
        label: blocked ? `${host} is blocked from the server by the ACL` : `${host} reaches the ${target.outside ? 'outside ' : ''}server`,
        from: host,
        toKey: target.key,
        expect: blocked ? 'fail' : 'pass',
      });
    }
  }

  if (wantsWeb && serverHttpHost) {
    const url = spec.dns ? `http://${spec.hostname}` : `http://${webIp}`;
    for (let lan = 0; lan < lanCount; lan++) {
      const host = firstHosts[lan];
      if (!host) {
        continue;
      }
      const blocked = webOutside
        ? view.serverBlocked(lan, 'http', OUTSIDE_LOCATION, aclServer)
        : view.serverBlocked(lan, 'http', serverLan, aclServer);
      addCheck(ctx, {
        kind: 'http',
        category: blocked ? 'security' : 'service',
        label: blocked ? `${host} cannot open ${url} (ACL)` : `${host} opens ${url}`,
        from: host,
        url,
        expect: blocked ? 'fail' : 'pass',
      });
    }
  }

  if (dhcpHosts) {
    for (let lan = 0; lan < lanCount; lan++) {
      const host = firstHosts[lan];
      if (!host || relayBlocked[lan]) {
        continue;
      }
      addCheck(ctx, {
        kind: 'dhcp',
        category: 'service',
        label: `${host} leased an address from ${cidrText(lanCidrs[lan])}`,
        from: host,
        prefix: cidrText(lanCidrs[lan]),
        expect: 'pass',
      });
    }
  }

  if (routerCount > 1) {
    const codes = routeCodes(routing);
    for (const info of infos) {
      for (let lan = 0; lan < lanCount; lan++) {
        if (topology.owner[lan] === info.index) {
          continue;
        }
        addCheck(ctx, {
          kind: 'route',
          category: 'routing',
          label: `${info.key} has a ${protocolLabel(routing)} route to ${cidrText(lanCidrs[lan])}`,
          from: info.key,
          prefix: cidrText(lanCidrs[lan]),
          codes,
          expect: 'pass',
        });
      }
    }
    if (nat) {
      for (const info of infos) {
        addCheck(ctx, {
          kind: 'route',
          category: 'routing',
          label: `${info.key} has a default route towards the Internet`,
          from: info.key,
          prefix: '0.0.0.0/0',
          codes: info.index === 0 ? ['S'] : defaultCodes(routing),
          expect: 'pass',
        });
      }
    }
  }

  for (const info of infos) {
    addShow(ctx, info.key, 'show ip interface brief', 'Every interface should be up/up with the planned address.');
    addShow(ctx, info.key, 'show ip route', 'Connected, learned and default routes in the routing table.');
    if (routing === 'ospf') {
      addShow(ctx, info.key, 'show ip ospf neighbor', 'OSPF neighbours should be in the FULL state.');
    }
    if (routing === 'eigrp') {
      addShow(ctx, info.key, 'show ip eigrp neighbors', 'EIGRP neighbours that agreed on the AS number.');
    }
    if (routing === 'rip' || routing === 'ospf' || routing === 'eigrp') {
      addShow(ctx, info.key, 'show ip protocols', 'Routing protocol settings and advertised networks.');
    }
  }
  if (nat) {
    addShow(ctx, infos[0].key, 'show ip nat translations', 'Inside local addresses mapped to the public interface address.');
  }
  if (acl && aclRouter) {
    addShow(ctx, aclRouter.key, 'show access-lists', 'ACL entries with hit counters proving the filter matched traffic.');
  }
  if (spec.dhcp === 'router') {
    for (const info of infos) {
      if (info.lanIfs.length > 0) {
        addShow(ctx, info.key, 'show ip dhcp binding', 'Addresses handed out by this router.');
      }
    }
  }

  let failover: FailoverPlan | null = null;
  if (spec.failover && routerCount >= 2) {
    const hostPair = (routerA: number, routerB: number): [string, string] | null => {
      for (let first = 0; first < lanCount; first++) {
        if (topology.owner[first] !== routerA || !firstHosts[first]) {
          continue;
        }
        for (let second = 0; second < lanCount; second++) {
          if (topology.owner[second] !== routerB || !firstHosts[second]) {
            continue;
          }
          if (!view.pairBlocked(first, second)) {
            return [firstHosts[first], firstHosts[second]];
          }
        }
      }
      return null;
    };

    const edgeFor = (routerA: number, routerB: number): number => {
      const direct = edgeBetween(topology.edges, routerA, routerB);
      if (direct !== -1) {
        return direct;
      }
      const next = hops[routerA][routerB];
      if (next === -1) {
        return -1;
      }
      return edgeBetween(topology.edges, routerA, next);
    };

    let chosen: { src: number; dst: number; edge: number; hosts: [string, string] } | null = null;

    if (spec.failLink.length === 2) {
      const left = spec.failLink[0] - 1;
      const right = spec.failLink[1] - 1;
      const direct = left < routerCount && right < routerCount ? edgeBetween(topology.edges, left, right) : -1;
      const hosts = direct !== -1 ? hostPair(left, right) : null;
      if (direct !== -1 && hosts) {
        chosen = { src: left, dst: right, edge: direct, hosts };
      } else {
        ctx.notes.push(`R${spec.failLink[0]} and R${spec.failLink[1]} are not directly linked or have no usable PCs, so a default link was used for the failure test.`);
      }
    }

    if (!chosen) {
      const candidates: Array<[number, number]> = [[topology.owner[0], topology.owner[lanCount - 1]]];
      for (let first = 0; first < routerCount; first++) {
        for (let second = routerCount - 1; second > first; second--) {
          candidates.push([first, second]);
        }
      }
      for (const [first, second] of candidates) {
        if (first === second) {
          continue;
        }
        const hosts = hostPair(first, second);
        const edge = edgeFor(first, second);
        if (hosts && edge !== -1) {
          chosen = { src: first, dst: second, edge, hosts };
          break;
        }
      }
    }

    if (chosen) {
      const linkIndex = edgeLinkIndex[chosen.edge];
      const canReroute = dynamic && stillConnected(routerCount, topology.edges, chosen.edge, chosen.src, chosen.dst);
      failover = {
        linkIndex,
        fromKey: ctx.links[linkIndex].a,
        toKey: ctx.links[linkIndex].b,
        srcHost: chosen.hosts[0],
        dstHost: chosen.hosts[1],
        canReroute,
      };
    } else {
      ctx.notes.push('No failover test was possible because no two PCs on different routers are allowed to talk to each other.');
    }
  }

  buildRoutedSteps(ctx, spec, routing, infos, topology, lanCidrs, webOutside, serverKey, acl, failover);
  normalizeLayout(ctx);

  return {
    spec,
    devices: ctx.devices,
    links: ctx.links,
    configs: ctx.configs,
    hosts: ctx.hosts,
    servers: ctx.servers,
    checks: ctx.checks,
    show: ctx.show,
    subnets: ctx.subnets,
    addresses: ctx.addresses,
    steps: ctx.steps,
    viva: vivaFor({ ...spec, routing, routers: routerCount }),
    notes: ctx.notes,
    failover,
  };
}

function buildRoutedSteps(
  ctx: Builder,
  spec: LabSpec,
  routing: Routing,
  infos: RouterInfo[],
  topology: Topology,
  lanCidrs: Cidr[],
  webOutside: boolean,
  serverKey: string | null,
  acl: AclSpec | null,
  failover: FailoverPlan | null,
): void {
  const routerCount = infos.length;
  const lanList = lanCidrs.map((cidr, lan) => `LAN ${lan + 1} ${cidrText(cidr)}`).join(', ');
  addStep(
    ctx,
    'Plan the addressing',
    `Give every LAN its own subnet (${lanList}). ${topology.edges.length > 0 ? 'Each router-to-router link gets a /30 so only two addresses are used. ' : ''}The first usable address of each LAN is the default gateway.`,
  );
  addStep(
    ctx,
    'Place and cable the devices',
    `Add ${routerCount} Cisco 2911 router${routerCount > 1 ? 's' : ''}, one ${spec.hub ? 'hub' : 'switch'} per LAN and ${spec.hostsPerLan} PC${spec.hostsPerLan > 1 ? 's' : ''} per LAN. Use straight-through cables for router-to-switch and switch-to-PC${topology.edges.some(edge => edge.serial) ? ', and serial cables for the WAN links (the first router of each link is the DCE side)' : ''}.`,
  );
  addStep(
    ctx,
    'Configure the router interfaces',
    'On every router set the interface addresses and enable them with no shutdown. Serial DCE ends also need a clock rate.',
  );
  if (routerCount > 1) {
    if (routing === 'static') {
      addStep(ctx, 'Add static routes', 'Each router gets one ip route per remote LAN pointing at the next router on the shortest path.');
    } else if (routing === 'ospf') {
      addStep(ctx, 'Enable OSPF', 'Advertise every connected network in area 0 on every router and make the LAN interfaces passive so no hellos leave towards PCs.');
    } else if (routing === 'rip') {
      addStep(ctx, 'Enable RIPv2', 'Use version 2 with no auto-summary, advertise the classful networks and make LAN interfaces passive.');
    } else if (routing === 'eigrp') {
      addStep(ctx, 'Enable EIGRP', 'Use AS 100 with network statements and no auto-summary on every router, with passive LAN interfaces.');
    }
  }
  if (spec.nat) {
    addStep(
      ctx,
      'Configure NAT overload',
      `Mark the inside interfaces with ip nat inside and the ISP link with ip nat outside, permit the LAN subnets in access-list 1 and run ip nat inside source list 1 interface ... overload. A default route sends everything else to the ISP${routerCount > 1 ? ', and the other routers learn it' : ''}.`,
    );
  }
  if (spec.dhcp === 'router') {
    addStep(ctx, 'Configure DHCP on the routers', 'Exclude the gateway addresses, then create one ip dhcp pool per LAN with the network, default-router and DNS.');
  }
  if (spec.dhcp === 'server' && serverKey) {
    addStep(ctx, 'Configure DHCP on the server', `Create one pool per LAN on ${serverKey} and add ip helper-address on every gateway outside the server LAN so broadcasts reach it.`);
  }
  if (spec.dns || spec.http) {
    addStep(ctx, 'Turn on the services', `Enable HTTP${spec.dns ? ' and a DNS record for ' + spec.hostname : ''} on the ${webOutside ? 'outside' : ''} server.`);
  }
  if (acl) {
    addStep(
      ctx,
      'Apply the access list',
      `${acl.style === 'extended' ? 'An extended ACL is placed on the inbound side of the source LAN gateway, so unwanted traffic is dropped as early as possible.' : 'A standard ACL only sees the source address, so it is placed on the outbound side of the interface closest to the destination.'} Finish with a permit so other traffic still works.`,
    );
  }
  addStep(ctx, 'Verify', 'Ping across the network (the first ping times out while ARP resolves), check the routing tables and test every service.');
  if (failover) {
    addStep(ctx, 'Test a link failure', `Shut the link between ${failover.fromKey} and ${failover.toKey}, confirm the path ${failover.canReroute ? 'moves to the backup route' : 'is lost because nothing else can carry it'}, then restore it.`);
  }
}

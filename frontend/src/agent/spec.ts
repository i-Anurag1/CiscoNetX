import { cidrText, parseCidr } from './ipam.ts';

export type Family = 'lan' | 'routed' | 'vlan';
export type Routing = 'none' | 'static' | 'rip' | 'ospf' | 'eigrp';
export type Shape = 'chain' | 'ring' | 'star';
export type WanKind = 'ethernet' | 'serial';
export type InterVlan = 'none' | 'roas' | 'svi';
export type DhcpMode = 'none' | 'router' | 'server';
export type AclService = 'any' | 'icmp' | 'http';
export type AclStyle = 'extended' | 'standard';

export interface VlanSpec {
  id: number;
  name: string;
  hosts: number;
}

export interface AclSpec {
  style: AclStyle;
  service: AclService;
  from: number;
  to: number;
}

export interface LabSpec {
  title: string;
  family: Family;
  routers: number;
  lans: number;
  hostsPerLan: number;
  shape: Shape;
  routing: Routing;
  wan: WanKind;
  hub: boolean;
  networks: string[];
  hostRequirements: number[];
  vlans: VlanSpec[];
  switches: number;
  interVlan: InterVlan;
  dhcp: DhcpMode;
  dns: boolean;
  http: boolean;
  nat: boolean;
  acl: AclSpec | null;
  failover: boolean;
  failLink: number[];
  hostname: string;
}

export const LIMITS = {
  routers: 6,
  lans: 8,
  hostsPerLan: 8,
  vlans: 6,
  switches: 2,
  networks: 8,
  requirements: 8,
  hostsRequirement: 4000,
};

export const DEFAULT_VLAN_NAMES = ['Sales', 'Engineering', 'HR', 'Finance', 'Admin', 'Guest'];

const FAMILIES: Family[] = ['lan', 'routed', 'vlan'];
const ROUTINGS: Routing[] = ['none', 'static', 'rip', 'ospf', 'eigrp'];
const SHAPES: Shape[] = ['chain', 'ring', 'star'];
const WANS: WanKind[] = ['ethernet', 'serial'];
const INTER_VLANS: InterVlan[] = ['none', 'roas', 'svi'];
const DHCP_MODES: DhcpMode[] = ['none', 'router', 'server'];
const ACL_SERVICES: AclService[] = ['any', 'icmp', 'http'];
const ACL_STYLES: AclStyle[] = ['extended', 'standard'];

export function defaultSpec(): LabSpec {
  return {
    title: '',
    family: 'lan',
    routers: 0,
    lans: 1,
    hostsPerLan: 2,
    shape: 'chain',
    routing: 'none',
    wan: 'ethernet',
    hub: false,
    networks: [],
    hostRequirements: [],
    vlans: [],
    switches: 1,
    interVlan: 'none',
    dhcp: 'none',
    dns: false,
    http: false,
    nat: false,
    acl: null,
    failover: false,
    failLink: [],
    hostname: 'www.lab.local',
  };
}

function pickEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  if (typeof value === 'string') {
    const lowered = value.toLowerCase() as T;
    if (allowed.includes(lowered)) {
      return lowered;
    }
  }
  return fallback;
}

function clampInt(value: unknown, low: number, high: number, fallback: number): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(high, Math.max(low, Math.round(number)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return fallback;
}

export function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 14);
  return cleaned.length ? cleaned : fallback;
}

function cleanHostname(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const cleaned = value.toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 60);
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(cleaned) ? cleaned : fallback;
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90);
}

function readVlans(value: unknown): VlanSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<number>();
  const result: VlanSpec[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = clampInt(record.id, 2, 1001, -1);
    if (id === -1 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({
      id,
      name: cleanName(record.name, `VLAN${id}`),
      hosts: clampInt(record.hosts, 1, 6, 2),
    });
    if (result.length >= LIMITS.vlans) {
      break;
    }
  }
  return result;
}

function readNetworks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const cidr = parseCidr(item);
    if (!cidr || cidr.prefix < 8 || cidr.prefix > 30) {
      continue;
    }
    const text = cidrText(cidr);
    if (!result.includes(text)) {
      result.push(text);
    }
    if (result.length >= LIMITS.networks) {
      break;
    }
  }
  return result;
}

function readRequirements(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: number[] = [];
  for (const item of value) {
    const count = clampInt(item, 1, LIMITS.hostsRequirement, -1);
    if (count !== -1) {
      result.push(count);
    }
    if (result.length >= LIMITS.requirements) {
      break;
    }
  }
  return result;
}

function readAcl(value: unknown): AclSpec | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    style: pickEnum(record.style, ACL_STYLES, 'extended'),
    service: pickEnum(record.service, ACL_SERVICES, 'icmp'),
    from: clampInt(record.from, 0, LIMITS.lans - 1, 1),
    to: clampInt(record.to, -1, LIMITS.lans - 1, 0),
  };
}

function readFailLink(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== 2) {
    return [];
  }
  const first = clampInt(value[0], 1, LIMITS.routers, -1);
  const second = clampInt(value[1], 1, LIMITS.routers, -1);
  if (first === -1 || second === -1 || first === second) {
    return [];
  }
  return [Math.min(first, second), Math.max(first, second)];
}

export function buildTitle(spec: LabSpec): string {
  const parts: string[] = [];
  if (spec.family === 'lan') {
    parts.push(spec.hub ? 'Hub-based LAN' : 'Switched LAN');
  } else if (spec.family === 'vlan') {
    parts.push(`${spec.vlans.length} VLANs`);
    if (spec.interVlan === 'roas') {
      parts.push('router-on-a-stick');
    } else if (spec.interVlan === 'svi') {
      parts.push('inter-VLAN routing on a Layer 3 switch');
    } else {
      parts.push('VLAN isolation');
    }
  } else if (spec.routers === 1) {
    parts.push(`Router connecting ${spec.lans} LAN${spec.lans === 1 ? '' : 's'}`);
  } else {
    const protocol = spec.routing === 'static' ? 'static routing' : spec.routing.toUpperCase();
    parts.push(`${protocol} across ${spec.routers} routers (${spec.shape})`);
  }
  if (spec.nat) {
    parts.push('NAT/PAT');
  }
  if (spec.acl) {
    parts.push(`${spec.acl.style} ACL`);
  }
  if (spec.dhcp !== 'none') {
    parts.push('DHCP');
  }
  if (spec.dns) {
    parts.push('DNS');
  }
  if (spec.http) {
    parts.push('web server');
  }
  return parts.join(' + ');
}

export function needsServer(spec: LabSpec): boolean {
  return spec.dns || spec.http || spec.dhcp === 'server' || (spec.acl !== null && (spec.acl.to === -1 || spec.acl.service === 'http'));
}

export function normalizeSpec(raw: unknown): { spec: LabSpec; warnings: string[] } {
  const warnings: string[] = [];
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const base = defaultSpec();

  const spec: LabSpec = {
    title: cleanTitle(input.title),
    family: pickEnum(input.family, FAMILIES, base.family),
    routers: clampInt(input.routers, 0, LIMITS.routers, base.routers),
    lans: clampInt(input.lans, 1, LIMITS.lans, base.lans),
    hostsPerLan: clampInt(input.hostsPerLan, 1, LIMITS.hostsPerLan, base.hostsPerLan),
    shape: pickEnum(input.shape, SHAPES, base.shape),
    routing: pickEnum(input.routing, ROUTINGS, base.routing),
    wan: pickEnum(input.wan, WANS, base.wan),
    hub: asBool(input.hub, base.hub),
    networks: readNetworks(input.networks),
    hostRequirements: readRequirements(input.hostRequirements),
    vlans: readVlans(input.vlans),
    switches: clampInt(input.switches, 1, LIMITS.switches, base.switches),
    interVlan: pickEnum(input.interVlan, INTER_VLANS, base.interVlan),
    dhcp: pickEnum(input.dhcp, DHCP_MODES, base.dhcp),
    dns: asBool(input.dns, base.dns),
    http: asBool(input.http, base.http),
    nat: asBool(input.nat, base.nat),
    acl: readAcl(input.acl),
    failover: asBool(input.failover, base.failover),
    failLink: readFailLink(input.failLink),
    hostname: cleanHostname(input.hostname, base.hostname),
  };

  if (spec.hostRequirements.length > 0) {
    spec.lans = spec.hostRequirements.length;
    if (spec.family === 'lan') {
      spec.family = 'routed';
    }
  }

  if (spec.family === 'lan' && (spec.nat || spec.acl)) {
    spec.family = 'routed';
    warnings.push('NAT and ACL labs need a router, so a router was added.');
  }

  if (spec.family === 'lan') {
    spec.routers = 0;
    spec.lans = 1;
    spec.routing = 'none';
    spec.vlans = [];
    spec.interVlan = 'none';
    spec.switches = 1;
  }

  if (spec.family === 'routed') {
    spec.routers = Math.max(1, spec.routers);
    spec.vlans = [];
    spec.interVlan = 'none';
    spec.switches = 1;
    if (spec.acl && spec.lans < 2) {
      spec.lans = 2;
    }
    if (spec.routers === 1) {
      spec.routing = 'none';
      spec.shape = 'chain';
      const hasPurpose = spec.nat || spec.dhcp !== 'none' || spec.dns || spec.http;
      if (spec.lans < 2 && !hasPurpose) {
        spec.lans = 2;
        warnings.push('A single router with one LAN has nothing to route, so a second LAN was added.');
      }
    } else {
      if (spec.routing === 'none') {
        spec.routing = 'ospf';
        warnings.push('No routing protocol was given, so OSPF was used.');
      }
      if (spec.shape !== 'chain' && spec.routers < 3) {
        spec.shape = 'chain';
        warnings.push('A ring or star needs at least 3 routers, so a chain was used.');
      }
    }
  }

  if (spec.family === 'vlan') {
    if (spec.acl && spec.interVlan === 'none') {
      spec.interVlan = 'roas';
      warnings.push('An ACL between VLANs needs inter-VLAN routing, so router-on-a-stick was used.');
    }
    if (spec.nat) {
      spec.nat = false;
      warnings.push('NAT is not combined with VLAN labs here; the NAT request was ignored.');
    }
    if (spec.vlans.length < 2) {
      const have = new Set(spec.vlans.map(item => item.id));
      let next = 10;
      while (spec.vlans.length < 2) {
        if (!have.has(next)) {
          spec.vlans.push({ id: next, name: DEFAULT_VLAN_NAMES[spec.vlans.length] ?? `VLAN${next}`, hosts: spec.hostsPerLan });
          have.add(next);
        }
        next += 10;
      }
      warnings.push('A VLAN lab needs at least two VLANs, so default VLANs were created.');
    }
    spec.routers = spec.interVlan === 'roas' ? 1 : 0;
    spec.lans = spec.vlans.length;
    spec.routing = 'none';
    spec.hub = false;
  }

  if (spec.family === 'lan' || spec.family === 'vlan') {
    if (spec.dhcp === 'router' && spec.family === 'lan') {
      spec.dhcp = 'server';
      warnings.push('A single switched LAN has no router, so DHCP is served by the server.');
    }
    if (spec.dhcp === 'router' && spec.family === 'vlan' && spec.interVlan === 'none') {
      spec.dhcp = 'server';
      warnings.push('Without inter-VLAN routing there is no router to host DHCP, so a server on the first VLAN is used.');
    }
  }

  if (spec.acl) {
    const acl = spec.acl;
    if (acl.from >= spec.lans) {
      acl.from = spec.lans - 1;
    }
    if (acl.to >= spec.lans) {
      acl.to = 0;
    }
    if (acl.to === acl.from) {
      acl.to = acl.from === 0 ? 1 : 0;
    }
    if (acl.to >= spec.lans) {
      spec.acl = null;
    }
  }

  if (spec.acl && spec.acl.style === 'standard' && spec.acl.service !== 'any') {
    warnings.push('A standard ACL can only match the source address, so all traffic from the source network is blocked, not only the named service.');
    spec.acl.service = 'any';
  }

  if (spec.failLink.length === 2) {
    if (spec.failLink[1] > spec.routers || spec.routers < 2) {
      spec.failLink = [];
    } else {
      spec.failover = true;
    }
  }

  if (spec.failover && (spec.routers < 3 || spec.routing === 'static' || spec.routing === 'none')) {
    warnings.push('A failover test needs 3 or more routers and a dynamic routing protocol; the failure is still demonstrated but traffic cannot re-route.');
  }

  if (!spec.title) {
    spec.title = buildTitle(spec);
  }

  return { spec, warnings };
}

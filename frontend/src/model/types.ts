export type Kind = 'router' | 'switch' | 'l3switch' | 'hub' | 'pc' | 'laptop' | 'server';
export type PortKind = 'FastEthernet' | 'GigabitEthernet' | 'Serial' | 'Console' | 'RS232';
export type CableType = 'straight' | 'cross' | 'console' | 'serial';
export interface Port { name: string; short: string; kind: PortKind; mac: string }
export interface End { dev: string; port: string }
export interface Cable { id: string; type: CableType; a: End; b: End; dceA?: boolean }

export interface IfCfg {
  name: string; type: 'phys' | 'sub' | 'svi' | 'lo'; parent?: string; adminUp: boolean;
  ip?: string; mask?: string; desc?: string; helper: string[]; aclIn?: string; aclOut?: string;
  nat?: 'inside' | 'outside';
  swMode: 'access' | 'trunk'; accessVlan: number; nativeVlan: number; allowed: string; routed: boolean; portfast: boolean;
  clockRate?: number; bandwidth?: number; delay?: number; ospfCost?: number; ospfPrio?: number;
  vlan?: number; vlanNative?: boolean; dhcp?: boolean;
}
export interface StaticRoute { net: string; mask: string; nh?: string; ifn?: string; ad: number }
export interface RipCfg { version: number; nets: string[]; passive: string[]; defOrig: boolean; redistStatic: boolean; redistConn: boolean }
export interface OspfCfg { pid: number; rid?: string; nets: { net: string; wild: string; area: number }[]; passive: string[]; defOrig: boolean; refBw: number; redistStatic: boolean; redistConn: boolean }
export interface EigrpCfg { as: number; nets: { net: string; wild?: string }[]; passive: string[]; autoSum: boolean; redistStatic: boolean; redistConn: boolean }
export interface AclAddr { any: boolean; ip: string; wild: string }
export interface PortM { op: 'eq' | 'gt' | 'lt' | 'neq' | 'range'; a: number; b?: number }
export interface AclEntry { action: 'permit' | 'deny'; proto: string; src: AclAddr; dst: AclAddr; sp?: PortM; dp?: PortM; hits: number }
export interface Acl { name: string; ext: boolean; entries: AclEntry[] }
export interface NatPool { name: string; start: string; end: string; mask: string }
export interface NatRule { acl: string; pool?: string; ifn?: string; overload: boolean }
export interface NatStatic { local: string; global: string }
export interface DhcpPool { name: string; net: string; mask: string; gw?: string; dns?: string }
export interface DevCfg {
  hostname: string; secret?: string; banner?: string; domainLookup: boolean; ipRouting: boolean; defaultGw?: string;
  ifs: IfCfg[]; statics: StaticRoute[]; rip?: RipCfg; ospf: OspfCfg[]; eigrp: EigrpCfg[];
  acls: Acl[]; natPools: NatPool[]; natRules: NatRule[]; natStatics: NatStatic[];
  dhcpPools: DhcpPool[]; dhcpExcluded: [string, string][]; vlans: Record<string, { name: string }>;
  conPw?: string; conLogin: boolean; vtyPw?: string; vtyLogin: boolean; stpPrio: number; cdp: boolean;
  // host-only
  hostGw?: string; hostDns?: string; hostDhcp: boolean;
}
export interface NatTrans { proto: string; inLocal: string; inGlobal: string; outLocal: string; outGlobal: string; lp: number; gp: number }
export interface Runtime {
  arp: Record<string, { mac: string; ifn: string }>;
  macTable: { vlan: number; mac: string; port: string }[];
  nat: NatTrans[]; binds: { ip: string; mac: string; pool: string }[];
  upSince: Record<string, number>;
}
export interface Svc {
  http: { on: boolean; html: string };
  dns: { on: boolean; records: { name: string; ip: string }[] };
  dhcp: { on: boolean; pools: { name: string; gw: string; dns: string; start: string; mask: string; max: number }[] };
}
export interface Dev {
  id: string; name: string; kind: Kind; model: string; x: number; y: number; power: boolean;
  ports: Port[]; modules: (string | null)[]; cfg: DevCfg; startup: DevCfg | null; rt: Runtime; svc?: Svc;
}
export interface Note { id: string; x: number; y: number; text: string }
export interface L3If { name: string; ip: string; mask: string; mac: string; up: boolean; port?: string; tag?: number | null; cfg: IfCfg; vlan?: number }
export interface PortPhy { conn: boolean; up: boolean; proto: boolean; stp: 'fwd' | 'lrn' | 'blk' | 'na'; color: 'none' | 'green' | 'amber' | 'red' }

import type { LabSpec } from './spec.ts';

export type Role = 'router' | 'isp' | 'switch' | 'l3switch' | 'hub' | 'pc' | 'server';

export interface PlanDevice {
  key: string;
  name: string;
  model: string;
  role: Role;
  x: number;
  y: number;
  modules: Array<string | null>;
  group: string;
}

export interface PlanLink {
  a: string;
  pa: string;
  b: string;
  pb: string;
  label: string;
  serial: boolean;
}

export interface PlanHost {
  key: string;
  ip: string;
  mask: string;
  gateway: string;
  dns: string;
  dhcp: boolean;
  lan: number;
}

export interface PlanConfig {
  key: string;
  title: string;
  lines: string[];
}

export interface PlanDhcpPool {
  name: string;
  gateway: string;
  dns: string;
  start: string;
  mask: string;
  max: number;
}

export interface PlanServer {
  key: string;
  http: boolean;
  html: string;
  dns: boolean;
  records: Array<{ name: string; ip: string }>;
  dhcp: boolean;
  pools: PlanDhcpPool[];
}

export type CheckKind = 'ping' | 'http' | 'route' | 'dhcp';
export type CheckCategory = 'connectivity' | 'service' | 'routing' | 'security' | 'layer2';

export interface PlanCheck {
  id: string;
  kind: CheckKind;
  category: CheckCategory;
  label: string;
  from: string;
  toKey?: string;
  toIp?: string;
  url?: string;
  prefix?: string;
  codes?: string[];
  expect: 'pass' | 'fail';
}

export interface ShowCommand {
  key: string;
  command: string;
  why: string;
}

export interface SubnetRow {
  name: string;
  network: string;
  mask: string;
  prefix: number;
  first: string;
  last: string;
  broadcast: string;
  usable: number;
  purpose: string;
  required: number | null;
}

export interface AddressRow {
  device: string;
  iface: string;
  ip: string;
  mask: string;
  gateway: string;
  note: string;
}

export interface FailoverPlan {
  linkIndex: number;
  fromKey: string;
  toKey: string;
  srcHost: string;
  dstHost: string;
  canReroute: boolean;
}

export interface PlanStep {
  title: string;
  detail: string;
}

export interface Viva {
  question: string;
  answer: string;
}

export interface Plan {
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
  viva: Viva[];
  notes: string[];
  failover: FailoverPlan | null;
}

export function formatConfig(lines: string[]): string {
  const blockOpeners = [/^interface /, /^router /, /^ip dhcp pool /, /^vlan \d+/, /^line /, /^ip access-list /];
  const output: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    if (line === 'exit') {
      inBlock = false;
      output.push('!');
      continue;
    }
    const opens = blockOpeners.some(pattern => pattern.test(line));
    if (opens) {
      inBlock = true;
      output.push(line);
      continue;
    }
    output.push(inBlock ? ` ${line}` : line);
  }
  return output.join('\n');
}

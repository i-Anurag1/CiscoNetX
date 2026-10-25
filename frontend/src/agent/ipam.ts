import { fmtIp, lenToMask, lenToMaskInt, parseIp, netInt } from '../lib/ip.ts';

export interface Cidr {
  network: string;
  prefix: number;
  mask: string;
}

export interface VlsmRequest {
  index: number;
  hosts: number;
}

export interface VlsmAllocation {
  index: number;
  hosts: number;
  cidr: Cidr;
}

export function parseCidr(text: string): Cidr | null {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const ip = parseIp(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || prefix < 0 || prefix > 32) {
    return null;
  }
  return { network: fmtIp(netInt(ip, prefix)), prefix, mask: lenToMask(prefix) };
}

export function makeCidr(network: string, prefix: number): Cidr {
  const ip = parseIp(network) ?? 0;
  return { network: fmtIp(netInt(ip, prefix)), prefix, mask: lenToMask(prefix) };
}

export function cidrText(cidr: Cidr): string {
  return `${cidr.network}/${cidr.prefix}`;
}

export function blockSize(prefix: number): number {
  return 2 ** (32 - prefix);
}

export function usableCount(prefix: number): number {
  if (prefix >= 31) {
    return prefix === 32 ? 1 : 2;
  }
  return blockSize(prefix) - 2;
}

export function hostAt(cidr: Cidr, offset: number): string {
  const base = parseIp(cidr.network) ?? 0;
  return fmtIp(base + offset);
}

export function broadcastOf(cidr: Cidr): string {
  const base = parseIp(cidr.network) ?? 0;
  return fmtIp(base + blockSize(cidr.prefix) - 1);
}

export function firstUsable(cidr: Cidr): string {
  return hostAt(cidr, cidr.prefix >= 31 ? 0 : 1);
}

export function lastUsable(cidr: Cidr): string {
  const base = parseIp(cidr.network) ?? 0;
  const top = base + blockSize(cidr.prefix) - 1;
  return fmtIp(cidr.prefix >= 31 ? top : top - 1);
}

export function wildcardOf(prefix: number): string {
  return fmtIp((~lenToMaskInt(prefix)) >>> 0);
}

export function prefixForHosts(hosts: number): number {
  const need = Math.max(1, Math.floor(hosts)) + 2;
  const bits = Math.max(2, Math.ceil(Math.log2(need)));
  return Math.max(8, 32 - bits);
}

export function contains(parent: Cidr, child: Cidr): boolean {
  if (child.prefix < parent.prefix) {
    return false;
  }
  const base = parseIp(child.network) ?? 0;
  return netInt(base, parent.prefix) === (parseIp(parent.network) ?? -1);
}

export function overlaps(first: Cidr, second: Cidr): boolean {
  return contains(first, second) || contains(second, first);
}

export function vlsmAllocate(
  parent: Cidr,
  requests: VlsmRequest[],
): { allocations: VlsmAllocation[]; error: string | null } {
  const order = [...requests].sort((left, right) => right.hosts - left.hosts || left.index - right.index);
  const start = parseIp(parent.network) ?? 0;
  const end = start + blockSize(parent.prefix);
  let cursor = start;
  const allocations: VlsmAllocation[] = [];

  for (const request of order) {
    const prefix = prefixForHosts(request.hosts);
    const size = blockSize(prefix);
    cursor = Math.ceil(cursor / size) * size;
    if (cursor + size > end) {
      return {
        allocations: [],
        error: `${cidrText(parent)} is too small for the requested host counts (${requests.map(item => item.hosts).join(', ')}).`,
      };
    }
    allocations.push({ index: request.index, hosts: request.hosts, cidr: makeCidr(fmtIp(cursor), prefix) });
    cursor += size;
  }

  allocations.sort((left, right) => left.index - right.index);
  return { allocations, error: null };
}

export function subnetSplit(parent: Cidr, parts: number): Cidr[] | null {
  if (parts < 1) {
    return null;
  }
  const extraBits = Math.ceil(Math.log2(parts));
  const prefix = parent.prefix + extraBits;
  if (prefix > 30) {
    return null;
  }
  const size = blockSize(prefix);
  const start = parseIp(parent.network) ?? 0;
  const result: Cidr[] = [];
  for (let step = 0; step < parts; step++) {
    result.push(makeCidr(fmtIp(start + step * size), prefix));
  }
  return result;
}

// IPv4 / MAC helpers. Pure functions, no dependencies.
export function parseIp(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) { const o = Number(m[i]); if (o > 255) return null; n = n * 256 + o; }
  return n;
}
export function fmtIp(n: number): string {
  return [Math.floor(n / 16777216) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
export const isIp = (s?: string | null): boolean => parseIp(s) !== null;
export function maskToLen(mask: string | undefined | null): number | null {
  const n = parseIp(mask);
  if (n === null) return null;
  let len = 0, seenZero = false;
  for (let i = 31; i >= 0; i--) {
    const bit = Math.floor(n / 2 ** i) & 1;
    if (bit) { if (seenZero) return null; len++; } else seenZero = true;
  }
  return len;
}
export function lenToMaskInt(len: number): number { return len <= 0 ? 0 : (0xffffffff << (32 - len)) >>> 0; }
export const lenToMask = (len: number): string => fmtIp(lenToMaskInt(len));
export function netInt(ip: number, len: number): number { return (ip & lenToMaskInt(len)) >>> 0; }
export function netOf(ip: string, mask: string): string {
  const a = parseIp(ip), l = maskToLen(mask);
  return a === null || l === null ? '' : fmtIp(netInt(a, l));
}
export function bcastOf(ip: string, mask: string): string {
  const a = parseIp(ip), l = maskToLen(mask);
  return a === null || l === null ? '' : fmtIp((netInt(a, l) | (~lenToMaskInt(l) >>> 0)) >>> 0);
}
export function sameNet(a: string, b: string, mask: string): boolean {
  const x = parseIp(a), y = parseIp(b), l = maskToLen(mask);
  return x !== null && y !== null && l !== null && netInt(x, l) === netInt(y, l);
}
export function inNet(ip: string, net: string, len: number): boolean {
  const x = parseIp(ip), n = parseIp(net);
  return x !== null && n !== null && netInt(x, len) === netInt(n, len);
}
export function wildMatch(ip: string, base: string, wild: string): boolean {
  const a = parseIp(ip), b = parseIp(base), w = parseIp(wild);
  if (a === null || b === null || w === null) return false;
  const keep = (~w) >>> 0;
  return ((a & keep) >>> 0) === ((b & keep) >>> 0);
}
export function wildToLen(wild: string): number | null {
  const w = parseIp(wild);
  return w === null ? null : maskToLen(fmtIp((~w) >>> 0));
}
export function classfulLen(ip: string): number {
  const first = Math.floor((parseIp(ip) ?? 0) / 16777216);
  return first < 128 ? 8 : first < 192 ? 16 : 24;
}
export function isUsableHost(ip: string, mask: string): boolean {
  const a = parseIp(ip), l = maskToLen(mask);
  if (a === null || l === null) return false;
  if (l >= 31) return true;
  const n = netInt(a, l), b = (n | (~lenToMaskInt(l) >>> 0)) >>> 0;
  return a !== n && a !== b;
}
export function ipCmp(a: string, b: string): number { return (parseIp(a) ?? 0) - (parseIp(b) ?? 0); }
export const BCAST_MAC = 'FFFF.FFFF.FFFF';
export function macFrom(n: number): string {
  const h = (0x0001a0000000 + n * 0x10001 + 0x4b3c91).toString(16).toUpperCase().padStart(12, '0').slice(-12);
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
}
export interface SubnetInfo {
  network: string; broadcast: string; mask: string; wildcard: string; prefix: number;
  first: string; last: string; hosts: number; cls: string; isPrivate: boolean;
}
export function subnetInfo(ip: string, prefix: number): SubnetInfo | null {
  const a = parseIp(ip);
  if (a === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const net = netInt(a, prefix), inv = (~lenToMaskInt(prefix)) >>> 0, bc = (net | inv) >>> 0;
  const hosts = prefix >= 31 ? (prefix === 32 ? 1 : 2) : Math.max(0, 2 ** (32 - prefix) - 2);
  const f = Math.floor(a / 16777216), s = (a >>> 16) & 255;
  const cls = f < 128 ? 'A' : f < 192 ? 'B' : f < 224 ? 'C' : f < 240 ? 'D' : 'E';
  const priv = f === 10 || (f === 172 && s >= 16 && s <= 31) || (f === 192 && s === 168);
  return { network: fmtIp(net), broadcast: fmtIp(bc), mask: lenToMask(prefix), wildcard: fmtIp(inv), prefix,
    first: prefix >= 31 ? fmtIp(net) : fmtIp(net + 1), last: prefix >= 31 ? fmtIp(bc) : fmtIp(bc - 1), hosts, cls, isPrivate: priv };
}

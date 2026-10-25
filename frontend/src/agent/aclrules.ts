import { usableCount, type Cidr } from './ipam.ts';
import type { AclSpec } from './spec.ts';

export type Traffic = 'ping' | 'http';

export const OUTSIDE_LOCATION = -3;

export interface AclView {
  pairBlocked: (first: number, second: number) => boolean;
  serverBlocked: (client: number, kind: Traffic, serverLocation: number, serverIsAclHost: boolean) => boolean;
  dhcpRelayBlocked: (lan: number, serverLan: number) => boolean;
}

function roundTripBlocked(
  acl: AclSpec | null,
  serverLan: number,
  client: number,
  server: number,
  kind: Traffic,
  serverIsAclHost: boolean,
): boolean {
  if (!acl) {
    return false;
  }

  if (acl.style === 'standard') {
    const target = acl.to >= 0 ? acl.to : serverLan;
    return (client === acl.from && server === target) || (server === acl.from && client === target);
  }

  const ping = kind === 'ping';
  const service = acl.service;
  const serviceMatches = service === 'any' || (ping && service === 'icmp') || (!ping && service === 'http');
  let destinationMatches = false;
  if (acl.to >= 0) {
    destinationMatches = server === acl.to;
  } else {
    destinationMatches = serverIsAclHost;
  }
  const requestDenied = client === acl.from && destinationMatches && serviceMatches;

  const replyMatches = service === 'any' || (ping && service === 'icmp');
  const replyDenied = acl.to >= 0 && server === acl.from && client === acl.to && replyMatches;

  return requestDenied || replyDenied;
}

export function aclView(acl: AclSpec | null, serverLan: number): AclView {
  return {
    pairBlocked(first: number, second: number): boolean {
      return roundTripBlocked(acl, serverLan, first, second, 'ping', false);
    },
    serverBlocked(client: number, kind: Traffic, serverLocation: number, serverIsAclHost: boolean): boolean {
      return roundTripBlocked(acl, serverLan, client, serverLocation, kind, serverIsAclHost);
    },
    dhcpRelayBlocked(lan: number, dhcpLan: number): boolean {
      if (!acl) {
        return false;
      }
      if (acl.style === 'standard') {
        const target = acl.to >= 0 ? acl.to : serverLan;
        return lan === acl.from && target === dhcpLan;
      }
      return acl.service === 'any' && acl.to >= 0 && dhcpLan === acl.from && lan === acl.to;
    },
  };
}

export function chooseServerLan(cidrs: Cidr[], preferred: number, forbidden: number): number {
  const roomFor = (index: number): boolean => {
    return index !== forbidden && usableCount(cidrs[index].prefix) >= 4;
  };
  if (preferred < cidrs.length && roomFor(preferred)) {
    return preferred;
  }
  let best = -1;
  let bestUsable = 0;
  for (let index = 0; index < cidrs.length; index++) {
    if (!roomFor(index)) {
      continue;
    }
    const usable = usableCount(cidrs[index].prefix);
    if (usable > bestUsable) {
      bestUsable = usable;
      best = index;
    }
  }
  if (best === -1) {
    return Math.min(preferred, cidrs.length - 1);
  }
  return best;
}

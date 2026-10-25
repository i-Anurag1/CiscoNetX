import { parseCidr, cidrText, subnetSplit } from './ipam.ts';
import {
  DEFAULT_VLAN_NAMES,
  LIMITS,
  defaultSpec,
  normalizeSpec,
  type AclService,
  type AclSpec,
  type DhcpMode,
  type InterVlan,
  type LabSpec,
  type Routing,
  type Shape,
  type VlanSpec,
} from './spec.ts';

export interface Understanding {
  ok: boolean;
  reason: string;
  spec: LabSpec;
  notes: string[];
  warnings: string[];
  assumptions: string[];
}

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  single: 1,
  both: 2,
  dual: 2,
  triple: 3,
  a: 1,
  an: 1,
};

const NUMBER_TOKEN = '(\\d{1,4}|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|single|both|dual|triple|an|a)';

const BLOCKERS = '(?:hosts?|pcs?|users?|computers?|laptops?|routers?|switch(?:es)?|lans?|vlans?|subnets?|networks?|links?|servers?|across|with|and|using|for|of|on|in|the|to|has|have|each|every|per|from|between|that|which|so|or)';

function tokenToNumber(token: string): number {
  const lowered = token.toLowerCase();
  if (/^\d+$/.test(lowered)) {
    return Number(lowered);
  }
  return WORD_NUMBERS[lowered] ?? 0;
}

function findCounts(text: string, nouns: string, allowArticle: boolean): number[] {
  const pattern = new RegExp(`\\b${NUMBER_TOKEN}[\\s-]+(?:(?!${BLOCKERS}\\b)[a-z0-9/]+[\\s-]+){0,2}?(?:${nouns})\\b`, 'g');
  const counts: number[] = [];
  let match = pattern.exec(text);
  while (match !== null) {
    const token = match[1].toLowerCase();
    const isArticle = token === 'a' || token === 'an';
    if (!isArticle || allowArticle) {
      counts.push(tokenToNumber(token));
    }
    match = pattern.exec(text);
  }
  return counts;
}

function firstIndex(text: string, patterns: Array<[RegExp, Routing]>): Routing | null {
  let best: { index: number; value: Routing } | null = null;
  for (const [pattern, value] of patterns) {
    const found = pattern.exec(text);
    if (found && (best === null || found.index < best.index)) {
      best = { index: found.index, value };
    }
  }
  return best ? best.value : null;
}

function readRouting(text: string): Routing | null {
  return firstIndex(text, [
    [/\bospf(?:v2)?\b|link[- ]state/, 'ospf'],
    [/\beigrp\b/, 'eigrp'],
    [/\brip(?:v1|v2| v2| version 2)?\b|distance[- ]vector/, 'rip'],
    [/static (?:route|routing|routes)|\bip route\b|default route/, 'static'],
  ]);
}

function readVlans(text: string): VlanSpec[] {
  const found: VlanSpec[] = [];
  const seen = new Set<number>();
  const pattern = /\bvlans?\s*(?:id\s*)?(\d{1,4})(?:\s*(?:\(|-|:|called|named|name|for)\s*([a-z][a-z0-9_-]{1,13}))?/g;
  let match = pattern.exec(text);
  while (match !== null) {
    const id = Number(match[1]);
    if (id >= 2 && id <= 1001 && !seen.has(id)) {
      seen.add(id);
      const rawName = match[2] ?? '';
      const stop = ['and', 'for', 'the', 'with', 'to', 'on', 'in', 'is', 'has', 'ids', 'id'];
      const name = rawName && !stop.includes(rawName) ? rawName.charAt(0).toUpperCase() + rawName.slice(1) : '';
      found.push({ id, name: name || `VLAN${id}`, hosts: 2 });
    }
    match = pattern.exec(text);
  }

  const listPattern = /\bvlans?\s+((?:\d{1,4}\s*(?:,|and|&)\s*)+\d{1,4})/g;
  let listMatch = listPattern.exec(text);
  while (listMatch !== null) {
    for (const piece of listMatch[1].split(/\s*(?:,|and|&)\s*/)) {
      const id = Number(piece);
      if (id >= 2 && id <= 1001 && !seen.has(id)) {
        seen.add(id);
        found.push({ id, name: `VLAN${id}`, hosts: 2 });
      }
    }
    listMatch = listPattern.exec(text);
  }

  const countMatches = findCounts(text, 'vlans?', false);
  if (found.length === 0 && countMatches.length > 0) {
    const wanted = Math.min(LIMITS.vlans, Math.max(2, countMatches[0]));
    for (let index = 0; index < wanted; index++) {
      const id = (index + 1) * 10;
      found.push({ id, name: DEFAULT_VLAN_NAMES[index] ?? `VLAN${id}`, hosts: 2 });
    }
  }

  const named = DEFAULT_VLAN_NAMES.filter(name => new RegExp(`\\b${name.toLowerCase()}\\b`).test(text));
  if (found.length > 0) {
    found.forEach((item, index) => {
      if (item.name === `VLAN${item.id}` && named[index]) {
        item.name = named[index];
      }
    });
  }
  found.sort((left, right) => left.id - right.id);
  return found.slice(0, LIMITS.vlans);
}

function readNetworks(text: string): string[] {
  const result: string[] = [];
  const cidrPattern = /\b(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/g;
  let match = cidrPattern.exec(text);
  while (match !== null) {
    const cidr = parseCidr(match[1]);
    if (cidr && cidr.prefix >= 8 && cidr.prefix <= 30) {
      const textForm = cidrText(cidr);
      if (!result.includes(textForm)) {
        result.push(textForm);
      }
    }
    match = cidrPattern.exec(text);
  }
  const maskPattern = /\b(\d{1,3}(?:\.\d{1,3}){3})\s+(?:mask\s+)?(255(?:\.\d{1,3}){3})\b/g;
  let maskMatch = maskPattern.exec(text);
  while (maskMatch !== null) {
    const bits = maskMatch[2].split('.').reduce((total, octet) => total + Number(octet).toString(2).replace(/0/g, '').length, 0);
    const cidr = parseCidr(`${maskMatch[1]}/${bits}`);
    if (cidr && cidr.prefix >= 8 && cidr.prefix <= 30) {
      const textForm = cidrText(cidr);
      if (!result.includes(textForm)) {
        result.push(textForm);
      }
    }
    maskMatch = maskPattern.exec(text);
  }
  return result.slice(0, LIMITS.networks);
}

function readHostRequirements(text: string): number[] {
  const numbers: number[] = [];
  const listPattern = /((?:\d{1,4}\s*(?:,|and|&|,\s*and)\s*)+\d{1,4})\s*(?:hosts?|users?|computers?|pcs?|devices?|workstations?)/g;
  let listMatch = listPattern.exec(text);
  while (listMatch !== null) {
    for (const piece of listMatch[1].split(/\s*(?:,\s*and|,|and|&)\s*/)) {
      if (piece.trim()) {
        numbers.push(Number(piece));
      }
    }
    listMatch = listPattern.exec(text);
  }

  if (numbers.length === 0) {
    const singlePattern = /(\d{1,4})\s*(?:hosts?|users?|computers?|workstations?)/g;
    let singleMatch = singlePattern.exec(text);
    while (singleMatch !== null) {
      numbers.push(Number(singleMatch[1]));
      singleMatch = singlePattern.exec(text);
    }
  }

  const wantsVlsm = /vlsm|variable[- ]length|subnet(?:s|ting)?\b.*\b(?:hosts|users)|(?:hosts|users)\b.*\bsubnet/.test(text);
  const large = numbers.some(value => value > 12);
  const enough = numbers.length >= 2 && wantsVlsm;
  if (numbers.length > 0 && (large || enough)) {
    return numbers.filter(value => value >= 1).slice(0, LIMITS.requirements);
  }
  return [];
}

function readShape(text: string): Shape | null {
  if (/hub[- ]and[- ]spoke|\bstar\b/.test(text)) {
    return 'star';
  }
  if (/\bring\b|triangle|full[- ]mesh|redundan|triangular/.test(text)) {
    return 'ring';
  }
  if (/\bchain\b|linear|in a row|daisy/.test(text)) {
    return 'chain';
  }
  return null;
}

function readDhcp(text: string, mentionsRouter: boolean): DhcpMode {
  if (!/\bdhcp\b/.test(text)) {
    return 'none';
  }
  if (/dhcp[^.]{0,40}(?:on|in|using|via|from|configured on|hosted on) (?:the |a |each )?router|router[^.]{0,30}(?:as|acts as|act as|configured as|serves?) (?:a |the )?dhcp|ip dhcp pool|router dhcp/.test(text)) {
    return 'router';
  }
  if (/dhcp[^.]{0,20}server|server[^.]{0,30}dhcp|helper[- ]address|\brelay\b/.test(text) && /\bserver\b/.test(text)) {
    return 'server';
  }
  if (/helper[- ]address|\brelay\b/.test(text)) {
    return 'server';
  }
  return mentionsRouter ? 'router' : 'server';
}

function readAcl(text: string, vlans: VlanSpec[], lans: number): AclSpec | null {
  const aclPattern = /\bacl\b|access[- ]?list|\b(?:block|deny|prohibit|prevent|restrict)\w*\b[^.]{0,60}\b(?:from|access|reach|ping|connect|traffic|communicat|talk)/;
  if (!aclPattern.test(text)) {
    return null;
  }
  const style = /standard/.test(text) ? 'standard' : 'extended';
  let service: AclService = 'any';
  if (/\bhttp\b|\bweb\b|\bwww\b|browse|browsing/.test(text)) {
    service = 'http';
  } else if (/\bping\b|icmp|echo/.test(text)) {
    service = 'icmp';
  }

  const references: Array<{ index: number; target: number }> = [];
  const lanPattern = /\blan\s*(\d{1,2})\b/g;
  let lanMatch = lanPattern.exec(text);
  while (lanMatch !== null) {
    references.push({ index: lanMatch.index, target: Math.min(lans, Math.max(1, Number(lanMatch[1]))) - 1 });
    lanMatch = lanPattern.exec(text);
  }
  const vlanPattern = /\bvlan\s*(\d{1,4})\b/g;
  let vlanMatch = vlanPattern.exec(text);
  while (vlanMatch !== null) {
    const position = vlans.findIndex(item => item.id === Number(vlanMatch![1]));
    if (position >= 0) {
      references.push({ index: vlanMatch.index, target: position });
    }
    vlanMatch = vlanPattern.exec(text);
  }
  vlans.forEach((item, position) => {
    const namePattern = new RegExp(`\\b${item.name.toLowerCase()}\\b`, 'g');
    let nameMatch = namePattern.exec(text);
    while (nameMatch !== null) {
      references.push({ index: nameMatch.index, target: position });
      nameMatch = namePattern.exec(text);
    }
  });
  const serverPattern = /\bserver\b/g;
  let serverMatch = serverPattern.exec(text);
  while (serverMatch !== null) {
    references.push({ index: serverMatch.index, target: -1 });
    serverMatch = serverPattern.exec(text);
  }
  references.sort((left, right) => left.index - right.index);

  const unique: Array<{ index: number; target: number }> = [];
  for (const reference of references) {
    if (!unique.some(item => item.target === reference.target)) {
      unique.push(reference);
    }
  }

  let from = lans - 1;
  let to = 0;
  if (unique.length >= 2) {
    from = unique[0].target;
    to = unique[1].target;
    const toBeforeFrom = /\baccess to\b.*\bfrom\b|\bto\b[^.]{0,30}\bfrom\b/.test(text) && !/\bfrom\b[^.]{0,40}\bto\b/.test(text);
    if (toBeforeFrom) {
      const swap = from;
      from = to;
      to = swap;
    }
    if (from === -1) {
      from = to === 0 ? Math.max(1, lans - 1) : 0;
    }
  } else if (unique.length === 1) {
    if (unique[0].target === -1) {
      to = -1;
    } else {
      from = unique[0].target;
      to = from === 0 ? -1 : 0;
    }
  }
  return { style, service, from: Math.max(0, from), to };
}

function describe(spec: LabSpec): string[] {
  const notes: string[] = [];
  if (spec.family === 'lan') {
    notes.push(`${spec.hub ? 'Hub' : 'Switch'} LAN with ${spec.hostsPerLan} PCs`);
  } else if (spec.family === 'vlan') {
    notes.push(`${spec.vlans.length} VLANs: ${spec.vlans.map(item => `${item.id} (${item.name})`).join(', ')}`);
    notes.push(`${spec.switches} switch${spec.switches > 1 ? 'es' : ''}${spec.switches > 1 ? ' joined by a trunk' : ''}`);
    const method = spec.interVlan === 'roas' ? 'router-on-a-stick' : spec.interVlan === 'svi' ? 'Layer 3 switch (SVIs)' : 'none (VLANs stay isolated)';
    notes.push(`Inter-VLAN routing: ${method}`);
  } else {
    notes.push(`${spec.routers} router${spec.routers > 1 ? 's' : ''}${spec.routers > 1 ? ` in a ${spec.shape}` : ''} serving ${spec.lans} LAN${spec.lans > 1 ? 's' : ''}`);
    if (spec.routers > 1) {
      notes.push(`Routing: ${spec.routing === 'static' ? 'static routes' : spec.routing.toUpperCase()}${spec.wan === 'serial' ? ' over serial WAN links' : ''}`);
    }
  }
  if (spec.family !== 'vlan') {
    notes.push(`${spec.hostsPerLan} PC${spec.hostsPerLan > 1 ? 's' : ''} per LAN`);
  }
  const services: string[] = [];
  if (spec.dhcp !== 'none') {
    services.push(`DHCP on ${spec.dhcp}`);
  }
  if (spec.dns) {
    services.push('DNS');
  }
  if (spec.http) {
    services.push('web server');
  }
  if (spec.nat) {
    services.push('NAT/PAT to an ISP');
  }
  if (spec.acl) {
    services.push(`${spec.acl.style} ACL (${spec.acl.service})`);
  }
  if (spec.failover) {
    services.push('link-failure test');
  }
  if (services.length) {
    notes.push(`Also: ${services.join(', ')}`);
  }
  if (spec.networks.length) {
    notes.push(`Requested networks: ${spec.networks.join(', ')}`);
  }
  if (spec.hostRequirements.length) {
    notes.push(`VLSM host requirements: ${spec.hostRequirements.join(', ')}`);
  }
  return notes;
}

export function parseQuestion(question: string): Understanding {
  const original = question.replace(/\s+/g, ' ').trim();
  const text = original.toLowerCase();
  const spec = defaultSpec();
  const assumptions: string[] = [];
  const warnings: string[] = [];

  const networkWords = /(router|switch|hub|pc\b|pcs\b|host|lan\b|lans\b|vlan|subnet|ospf|rip\b|eigrp|dhcp|dns|nat\b|pat\b|acl|access[- ]list|topology|ping|network|gateway|trunk|cidr|vlsm|packet tracer|cisco|ip address|static route|server)/;
  if (!networkWords.test(text)) {
    return {
      ok: false,
      reason: 'This does not look like a networking lab question. Mention devices or a task such as routers, switches, VLANs, OSPF, DHCP, NAT or ACL.',
      spec,
      notes: [],
      warnings,
      assumptions,
    };
  }

  if (/\bbgp\b/.test(text)) {
    warnings.push('BGP is not simulated by CiscoNetX; OSPF is used instead.');
  }
  if (/ipv6|ospfv3|\bnd\b/.test(text)) {
    warnings.push('IPv6 is not simulated; the lab is built with IPv4.');
  }
  if (/wireless|wi-?fi|access point/.test(text)) {
    warnings.push('Wireless devices are not available in CiscoNetX; wired LANs are used.');
  }
  if (/\bmpls\b|\bvpn\b|\bipsec\b/.test(text)) {
    warnings.push('MPLS and VPN features are not simulated; the routed core is built without them.');
  }
  if (/\bstp\b|spanning[- ]tree/.test(text)) {
    warnings.push('Spanning tree runs automatically on switches, but redundant switch loops are not generated by this agent.');
  }

  spec.networks = readNetworks(text);
  spec.hostRequirements = readHostRequirements(text);

  const splitMatch = /(?:into|divide|split)\s+(?:it\s+)?(?:into\s+)?(\d{1,2}|two|three|four|five|six|seven|eight)\s+(?:equal\s+)?(?:sub-?nets?|networks|lans)/.exec(text);
  if (splitMatch && spec.networks.length === 1 && spec.hostRequirements.length === 0) {
    const parent = parseCidr(spec.networks[0]);
    const parts = tokenToNumber(splitMatch[1]);
    const pieces = parent ? subnetSplit(parent, Math.min(parts, LIMITS.lans)) : null;
    if (pieces) {
      spec.networks = pieces.map(cidrText);
    }
  }

  const vlanMention = /\bvlans?\b|802\.1q|\btrunk(?:ing|s)?\b/.test(text);
  const routingWord = readRouting(text);
  const routerCounts = findCounts(text, 'routers?', true);
  const routerLabels = new Set((original.match(/\bR\d\b/g) ?? []).map(label => label.toUpperCase()));
  const mentionsRouter =
    routerCounts.length > 0 ||
    /\brout(?:er|ers|ing)\b|ospf|\brip\b|eigrp|gateway|\bnat\b|\bpat\b|\bacl\b|access[- ]list|triangle/.test(text);

  spec.hub = /\bhub\b/.test(text) && !/hub[- ]and[- ]spoke/.test(text);
  spec.wan = /\bserial\b|\bdce\b|\bdte\b|clock rate|\bwan\b link/.test(text) ? 'serial' : 'ethernet';
  spec.nat = /\bnat\b|\bpat\b|overload|network address translation|\bisp\b|internet access/.test(text);
  spec.dns = /\bdns\b|name resolution|domain name/.test(text);
  spec.http = /\bhttp\b|web ?server|web ?page|website|\bbrowse|\bwww\./.test(text);
  spec.dhcp = readDhcp(text, mentionsRouter && !(vlanMention && !/router/.test(text)));
  spec.failover = /fail(?:ure|over|s)?\b|link down|goes down|go down|re-?rout|reconverge|convergence|backup path|redundan|broken link|cut the link/.test(text);

  const hostnameMatch = /\b(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|[a-z0-9-]+\.(?:com|net|org|edu|local|in|io))\b/.exec(text);
  if (hostnameMatch) {
    spec.hostname = hostnameMatch[1].startsWith('www.') ? hostnameMatch[1] : `www.${hostnameMatch[1]}`;
    spec.dns = true;
    spec.http = true;
  }
  if (spec.dns && !spec.http) {
    spec.http = true;
    assumptions.push('A DNS lab needs something to resolve, so a web server was added.');
  }

  const hostCounts = findCounts(text, 'pcs?|hosts?|computers?|laptops?|workstations?|end[- ]devices?|clients?|users?|machines?|terminals?', false);
  const lanCounts = findCounts(text, 'lans?|subnets?|departments?|sites?|branches?|offices?', true);
  const switchCounts = findCounts(text, 'switch(?:es)?', true);
  const perLan = /\b(?:each|per|every)\b/.test(text);

  const shape = readShape(text);
  if (shape) {
    spec.shape = shape;
  }
  spec.routing = routingWord ?? (/\bbgp\b/.test(text) ? 'ospf' : 'none');

  const failMatch = /(?:link|connection|cable)\s+(?:between|from)\s+r(?:outer)?\s*(\d)\s*(?:and|to|&|-)\s*r(?:outer)?\s*(\d)|\br(\d)\s*[-–]\s*r(\d)\s+link/.exec(text);
  if (failMatch) {
    const first = Number(failMatch[1] ?? failMatch[3]);
    const second = Number(failMatch[2] ?? failMatch[4]);
    if (first >= 1 && second >= 1 && first !== second) {
      spec.failLink = [Math.min(first, second), Math.max(first, second)];
    }
  }

  if (vlanMention) {
    spec.family = 'vlan';
    spec.vlans = readVlans(text);
    const switchCount = switchCounts.length ? Math.max(...switchCounts) : 1;
    spec.switches = Math.min(LIMITS.switches, Math.max(1, switchCount));
    const wantsIsolation = /\b(?:no|without|not|never)\s+(?:any\s+|a\s+)?(?:inter[- ]?vlan|routing|router|layer[- ]?3)|\bisolat|\bcannot\s+(?:communicate|talk|ping|reach)|\bshould(?:\s+not|n't)\s+(?:communicate|talk|ping|reach)/.test(text);
    if (wantsIsolation && !/router[- ]on[- ]a[- ]stick|\broas\b|\bsvi\b|layer[- ]?3 switch/.test(text)) {
      spec.interVlan = 'none' as InterVlan;
    } else if (/router[- ]on[- ]a[- ]stick|\broas\b|sub-?interface|dot1q/.test(text)) {
      spec.interVlan = 'roas';
    } else if (/layer[- ]?3 switch|multilayer|\bl3 switch|\bsvi\b|3560/.test(text)) {
      spec.interVlan = 'svi';
    } else if (/inter[- ]?vlan|between (?:the )?vlans|across vlans|\bgateway\b|\brouter\b/.test(text)) {
      spec.interVlan = 'roas';
    } else {
      spec.interVlan = 'none' as InterVlan;
    }
    if (hostCounts.length) {
      const count = Math.min(6, Math.max(1, hostCounts[0]));
      for (const item of spec.vlans) {
        item.hosts = perLan || spec.vlans.length === 1 ? count : Math.max(1, Math.ceil(count / Math.max(1, spec.vlans.length)));
      }
    }
    spec.hostsPerLan = spec.vlans[0]?.hosts ?? 2;
  } else if (mentionsRouter || spec.nat || spec.hostRequirements.length || spec.networks.length > 1) {
    spec.family = 'routed';
    const labelCount = routerLabels.size;
    let routers = routerCounts.length ? Math.max(...routerCounts) : labelCount;
    if (!routers && /triangle|triangular/.test(text)) {
      routers = 3;
    }
    const lansGiven = lanCounts.length ? Math.max(...lanCounts) : 0;
    const eachRouterHasLan = /\b(?:each|every)\s+(?:router|site|branch|office)\b[^.]{0,50}\b(?:lan|subnet|network)s?\b|\b(?:each|every)\s+(?:of\s+(?:them|the\s+routers)\s+)?(?:router\s+)?(?:with|has|having|have|hosting|serving|connects?|connected to|gets?|owns?)\b[^.]{0,30}\b(?:lan|subnet)s?\b|\b(?:lan|subnet)s?\b[^.]{0,30}\b(?:on|behind|at)\s+(?:each|every)(?:\s+(?:router|site|branch|office))?\b|\b(?:lan|subnet)s?\s+(?:each|per\s+router|per\s+site)\b/.test(text);
    const dynamic = spec.routing === 'rip' || spec.routing === 'ospf' || spec.routing === 'eigrp';
    if (!routers) {
      if (dynamic || spec.failover) {
        routers = 3;
        assumptions.push('Number of routers was not given, so 3 routers were used.');
      } else if (spec.routing === 'static') {
        routers = lansGiven === 2 && /\ba router\b|\bone router\b|\bthe router\b/.test(text) ? 1 : 2;
        if (routers === 2) {
          assumptions.push('Number of routers was not given, so 2 routers were used.');
        }
      } else {
        routers = 1;
      }
    }
    if (routers < 2 && dynamic && !/\ba router\b|\bone router\b/.test(text)) {
      routers = 2;
    }
    const branchCounts = findCounts(text, 'branch(?:es)?(?: routers?| offices?| sites?)?|spokes?|remote (?:routers?|sites?|offices?)', true);
    const hasHub = /\bhq\b|head ?quarters?|head ?office|central (?:router|site|office)|main (?:router|site|office)|hub router|\bcore router/.test(text);
    const starWords = spec.shape === 'star' || /hub[- ]and[- ]spoke|\bstar\b/.test(text);
    if (branchCounts.length > 0 && hasHub && starWords) {
      routers = Math.max(...branchCounts) + 1;
      spec.shape = 'star';
      assumptions.push(`One headquarters router plus ${routers - 1} branch routers, so ${routers} routers were used.`);
    }
    spec.routers = Math.min(LIMITS.routers, Math.max(1, routers));
    if (spec.hostRequirements.length) {
      spec.lans = spec.hostRequirements.length;
    } else if (spec.networks.length > 1) {
      spec.lans = Math.min(LIMITS.lans, spec.networks.filter(item => parseCidr(item)!.prefix <= 29).length || spec.networks.length);
    } else if (eachRouterHasLan && spec.routers >= 2) {
      const perRouter = lansGiven > 0 ? lansGiven : 1;
      spec.lans = Math.min(LIMITS.lans, lansGiven >= spec.routers ? lansGiven : perRouter * spec.routers);
    } else if (lansGiven > 0) {
      spec.lans = Math.min(LIMITS.lans, Math.max(1, lansGiven));
    } else if (spec.routers === 1) {
      const purposeful = spec.nat || spec.dhcp !== 'none' || spec.dns || spec.http;
      spec.lans = purposeful && !/\b(?:two|2)\b/.test(text) ? 1 : 2;
    } else {
      spec.lans = spec.routers;
    }
    if (spec.failover && !shape && spec.routers >= 3 && spec.routing !== 'static') {
      spec.shape = 'ring';
      assumptions.push('A redundant ring was used so there is a second path when a link fails.');
    }
    if (spec.routers >= 2 && spec.routing === 'none') {
      assumptions.push('No routing protocol was named, so OSPF was chosen.');
      spec.routing = 'ospf';
    }
    if (spec.hostRequirements.length) {
      spec.hostsPerLan = 2;
      assumptions.push('Two representative PCs are drawn per subnet; the addressing follows the requested host counts.');
    } else if (hostCounts.length) {
      const count = Math.max(1, hostCounts[0]);
      spec.hostsPerLan = perLan || spec.lans <= 1 ? count : Math.max(1, Math.ceil(count / spec.lans));
    }
  } else {
    spec.family = 'lan';
    spec.routers = 0;
    spec.lans = 1;
    if (hostCounts.length) {
      spec.hostsPerLan = Math.max(1, Math.max(...hostCounts));
    } else {
      spec.hostsPerLan = 3;
      assumptions.push('Number of PCs was not given, so 3 PCs were used.');
    }
    if (spec.hub) {
      spec.hostsPerLan = Math.min(spec.hostsPerLan, 8);
    }
  }

  if (spec.dhcp === 'server' || spec.dns || spec.http) {
    assumptions.push('A server was added to provide the requested services.');
  }

  spec.acl = readAcl(text, spec.vlans, Math.max(spec.lans, 2));
  if (spec.acl && spec.family === 'routed' && spec.routers === 0) {
    spec.routers = 1;
  }

  spec.hostsPerLan = Math.min(LIMITS.hostsPerLan, spec.hostsPerLan);
  if (spec.hostsPerLan > LIMITS.hostsPerLan - 1 && /\b\d{2,}\s*(?:pcs?|hosts?|computers?)/.test(text)) {
    warnings.push(`At most ${LIMITS.hostsPerLan} PCs are drawn per LAN; the addressing still follows the requested sizes.`);
  }

  const normalized = normalizeSpec(spec);
  return {
    ok: true,
    reason: '',
    spec: normalized.spec,
    notes: describe(normalized.spec),
    warnings: [...warnings, ...normalized.warnings],
    assumptions,
  };
}

export function describeSpec(spec: LabSpec): string[] {
  return describe(spec);
}

import {
  addAddress,
  addCheck,
  addDevice,
  addLink,
  addShow,
  addStep,
  addSubnet,
  configOf,
  createBuilder,
  excludedRange,
  fast,
  gig,
  lanLayout,
  normalizeLayout,
  portRuns,
  pushBlock,
  webPage,
  type Builder,
} from './builder.ts';
import { aclView, chooseServerLan } from './aclrules.ts';
import { cidrText, hostAt, makeCidr, overlaps, parseCidr, subnetSplit, usableCount, wildcardOf, type Cidr } from './ipam.ts';
import { vivaFor } from './knowledge.ts';
import type { Plan, PlanServer } from './plan.ts';
import type { AclSpec, LabSpec } from './spec.ts';

interface HostSlot {
  key: string;
  vlan: number;
  switchIndex: number;
  port: number;
  server: boolean;
}

function vlanCidrs(ctx: Builder, spec: LabSpec): Cidr[] {
  const count = spec.vlans.length;
  const parsed: Cidr[] = [];
  for (const text of spec.networks) {
    const cidr = parseCidr(text);
    if (cidr && cidr.prefix <= 29) {
      parsed.push(cidr);
    }
  }
  if (parsed.length >= count) {
    return parsed.slice(0, count);
  }
  if (parsed.length === 1) {
    const pieces = subnetSplit(parsed[0], count);
    if (pieces) {
      ctx.notes.push(`${cidrText(parsed[0])} was split into ${count} subnets, one per VLAN.`);
      return pieces;
    }
  }
  const result: Cidr[] = [];
  spec.vlans.forEach((item, index) => {
    let third = item.id <= 254 ? item.id : (index + 1) * 10;
    let candidate = makeCidr(`192.168.${third}.0`, 24);
    while (result.some(existing => overlaps(existing, candidate)) && third < 254) {
      third += 1;
      candidate = makeCidr(`192.168.${third}.0`, 24);
    }
    result.push(candidate);
  });
  return result;
}

export function buildVlan(spec: LabSpec): Plan {
  const ctx = createBuilder(spec);
  const vlans = spec.vlans;
  const vlanTotal = vlans.length;
  const cidrs = vlanCidrs(ctx, spec);
  const interVlan = spec.interVlan;
  const routing = interVlan !== 'none';
  const acl: AclSpec | null = spec.acl ? { ...spec.acl } : null;

  let serverVlan = 0;
  if (acl) {
    if (acl.to === -1) {
      serverVlan = acl.from === 0 ? 1 : 0;
    } else if (acl.service === 'http') {
      serverVlan = acl.to;
    }
  }
  if (serverVlan >= vlanTotal) {
    serverVlan = 0;
  }
  const pinnedServerVlan = acl !== null && acl.to >= 0 && acl.service === 'http';
  if (!pinnedServerVlan) {
    serverVlan = chooseServerLan(cidrs, serverVlan, acl !== null && acl.to === -1 ? acl.from : -1);
  }
  if (pinnedServerVlan && acl && usableCount(cidrs[acl.to].prefix) < 4) {
    const moved = chooseServerLan(cidrs, acl.to, acl.from);
    if (moved !== acl.to) {
      ctx.notes.push(`VLAN ${vlans[acl.to].id} is too small to hold a server, so the web server and the ACL target moved to VLAN ${vlans[moved].id}.`);
      acl.to = moved;
      serverVlan = moved;
    }
  }
  const view = aclView(acl, serverVlan);

  const wantsWeb = spec.dns || spec.http || (acl !== null && (acl.to === -1 || acl.service === 'http'));
  const dhcpServer = spec.dhcp === 'server';
  const needServer = wantsWeb || dhcpServer;
  const serverLayout = lanLayout(cidrs[serverVlan]);
  const dnsIp = spec.dns ? serverLayout.serverIp : '';

  let hostTotal = needServer ? 1 : 0;
  for (const item of vlans) {
    hostTotal += item.hosts;
  }
  let switchCount = spec.switches;
  while (switchCount < 2 && hostTotal > 23 * switchCount) {
    switchCount += 1;
  }
  if (switchCount > spec.switches) {
    ctx.notes.push('A second switch was added because one 24-port switch cannot hold all the hosts.');
  }

  const dhcpFor = (vlan: number): boolean => {
    if (spec.dhcp === 'none') {
      return false;
    }
    if (spec.dhcp === 'router') {
      return routing;
    }
    if (view.dhcpRelayBlocked(vlan, serverVlan)) {
      return false;
    }
    return routing || vlan === serverVlan;
  };

  if (dhcpServer && !routing && vlanTotal > 1) {
    ctx.notes.push('Without inter-VLAN routing only the PCs in the server VLAN can reach the DHCP server, so the other VLANs use static addresses.');
  }

  const slots: HostSlot[] = [];
  const nextPort: number[] = new Array(switchCount).fill(1);
  let placed = 0;
  let pcNumber = 0;
  let serverKey: string | null = null;
  const takeSlot = (vlan: number, key: string, server: boolean): void => {
    const switchIndex = switchCount === 1 ? 0 : placed % 2;
    placed += 1;
    slots.push({ key, vlan, switchIndex, port: nextPort[switchIndex], server });
    nextPort[switchIndex] += 1;
  };
  vlans.forEach((item, vlan) => {
    for (let index = 0; index < item.hosts; index++) {
      pcNumber += 1;
      takeSlot(vlan, `PC${pcNumber}`, false);
    }
    if (needServer && vlan === serverVlan) {
      serverKey = 'Server1';
      takeSlot(vlan, 'Server1', true);
    }
  });

  const coreKey = interVlan === 'roas' ? 'R1' : interVlan === 'svi' ? 'MLS1' : '';
  const switchWidth = 620;
  const coreX = ((switchCount - 1) * switchWidth) / 2;
  if (coreKey) {
    addDevice(ctx, {
      key: coreKey,
      model: interVlan === 'roas' ? '2911' : '3560-24PS',
      role: interVlan === 'roas' ? 'router' : 'l3switch',
      x: coreX,
      y: 0,
      group: 'Core',
      modules: interVlan === 'roas' ? [null, null] : [],
    });
  }

  const switchKeys: string[] = [];
  for (let index = 0; index < switchCount; index++) {
    const key = `SW${index + 1}`;
    switchKeys.push(key);
    addDevice(ctx, { key, model: '2960-24TT', role: 'switch', x: index * switchWidth, y: 170, group: 'Access' });
  }

  if (coreKey) {
    const corePort = interVlan === 'roas' ? gig(0) : gig(1);
    addLink(ctx, coreKey, corePort, switchKeys[0], gig(1), `${coreKey} trunk to ${switchKeys[0]}`);
  }
  if (switchCount === 2) {
    addLink(ctx, switchKeys[0], gig(2), switchKeys[1], gig(2), 'Trunk between the switches');
  }

  const perSwitchCount: number[] = new Array(switchCount).fill(0);
  const hostIndexInVlan: number[] = new Array(vlanTotal).fill(0);
  const firstHosts: string[] = new Array(vlanTotal).fill('');
  const pcsByVlan: string[][] = vlans.map(() => []);

  for (const slot of slots) {
    const vlanItem = vlans[slot.vlan];
    const cidr = cidrs[slot.vlan];
    const layout = lanLayout(cidr);
    const gateway = routing ? layout.gateway : '';
    const sequence = perSwitchCount[slot.switchIndex];
    perSwitchCount[slot.switchIndex] += 1;
    const column = sequence % 6;
    const row = Math.floor(sequence / 6);
    const inRow = Math.min(6, Math.max(1, slotsOnSwitch(slots, slot.switchIndex) - row * 6));
    const x = slot.switchIndex * switchWidth + (column - (inRow - 1) / 2) * 92;
    const y = 170 + 150 + row * 100;
    const usesDhcp = dhcpFor(slot.vlan) && !slot.server;

    let ip = '';
    if (slot.server) {
      ip = layout.serverIp;
    } else {
      ip = hostAt(cidr, layout.hostStart + hostIndexInVlan[slot.vlan]);
      hostIndexInVlan[slot.vlan] += 1;
    }

    addDevice(ctx, {
      key: slot.key,
      model: slot.server ? 'Server-PT' : 'PC-PT',
      role: slot.server ? 'server' : 'pc',
      x,
      y,
      group: `VLAN ${vlanItem.id}`,
    });
    addLink(ctx, switchKeys[slot.switchIndex], fast(slot.port), slot.key, 'FastEthernet0', `VLAN ${vlanItem.id} ${vlanItem.name} host`);
    ctx.hosts.push({
      key: slot.key,
      ip,
      mask: cidr.mask,
      gateway,
      dns: dnsIp,
      dhcp: usesDhcp,
      lan: slot.vlan,
    });
    addAddress(
      ctx,
      slot.key,
      'FastEthernet0',
      ip,
      cidr.mask,
      gateway || '-',
      slot.server ? 'static server address' : usesDhcp ? 'DHCP lease' : 'static address',
    );
    if (!slot.server) {
      pcsByVlan[slot.vlan].push(slot.key);
      if (firstHosts[slot.vlan] === '') {
        firstHosts[slot.vlan] = slot.key;
      }
    }
  }

  const gatewayName = (vlan: number): string => {
    if (interVlan === 'roas') {
      return `${gig(0)}.${vlans[vlan].id}`;
    }
    return `Vlan${vlans[vlan].id}`;
  };

  switchKeys.forEach((key, switchIndex) => {
    const config = configOf(ctx, key, `${key} configuration`);
    const lines = config.lines;
    lines.push(`hostname ${key}`);
    for (const item of vlans) {
      pushBlock(lines, `vlan ${item.id}`, [`name ${item.name}`]);
    }
    vlans.forEach((item, vlan) => {
      const ports = slots.filter(slot => slot.switchIndex === switchIndex && slot.vlan === vlan).map(slot => slot.port);
      for (const [low, high] of portRuns(ports)) {
        const header = low === high ? `interface ${fast(low)}` : `interface range FastEthernet0/${low} - ${high}`;
        pushBlock(lines, header, ['switchport mode access', `switchport access vlan ${item.id}`]);
      }
    });
    if (switchIndex === 0 && coreKey) {
      pushBlock(lines, `interface ${gig(1)}`, [`description Trunk to ${coreKey}`, 'switchport mode trunk']);
    }
    if (switchCount === 2) {
      pushBlock(lines, `interface ${gig(2)}`, [`description Trunk to ${switchKeys[1 - switchIndex]}`, 'switchport mode trunk']);
    }
  });

  const aclNumber = acl ? (acl.style === 'standard' ? '10' : '101') : '';
  const serverIp = serverLayout.serverIp;
  if (coreKey) {
    const config = configOf(ctx, coreKey, `${coreKey} configuration`);
    const lines = config.lines;
    lines.push(`hostname ${coreKey}`);
    if (interVlan === 'svi') {
      lines.push('ip routing');
      for (const item of vlans) {
        pushBlock(lines, `vlan ${item.id}`, [`name ${item.name}`]);
      }
      pushBlock(lines, `interface ${gig(1)}`, ['switchport trunk encapsulation dot1q', 'switchport mode trunk', `description Trunk to ${switchKeys[0]}`]);
    } else {
      pushBlock(lines, `interface ${gig(0)}`, [`description Trunk to ${switchKeys[0]}`, 'no shutdown']);
    }

    vlans.forEach((item, vlan) => {
      const cidr = cidrs[vlan];
      const layout = lanLayout(cidr);
      const body: string[] = [`description ${item.name} gateway`];
      if (interVlan === 'roas') {
        body.push(`encapsulation dot1Q ${item.id}`);
      }
      body.push(`ip address ${layout.gateway} ${cidr.mask}`);
      if (dhcpServer && vlan !== serverVlan && serverKey) {
        body.push(`ip helper-address ${serverIp}`);
      }
      if (acl && acl.style === 'extended' && vlan === acl.from) {
        body.push(`ip access-group ${aclNumber} in`);
      }
      if (acl && acl.style === 'standard') {
        const target = acl.to === -1 ? serverVlan : acl.to;
        if (vlan === target) {
          body.push(`ip access-group ${aclNumber} out`);
        }
      }
      body.push('no shutdown');
      pushBlock(lines, `interface ${gatewayName(vlan)}`, body);
    });

    if (acl) {
      const fromCidr = cidrs[acl.from];
      if (acl.style === 'extended') {
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
          destination = `host ${serverIp}`;
        } else {
          destination = `${cidrs[acl.to].network} ${wildcardOf(cidrs[acl.to].prefix)}`;
        }
        lines.push(`access-list ${aclNumber} deny ${protocol} ${fromCidr.network} ${wildcardOf(fromCidr.prefix)} ${destination}${suffix}`);
        lines.push(`access-list ${aclNumber} permit ip any any`);
      } else {
        lines.push(`access-list ${aclNumber} deny ${fromCidr.network} ${wildcardOf(fromCidr.prefix)}`);
        lines.push(`access-list ${aclNumber} permit any`);
      }
    }

    if (spec.dhcp === 'router') {
      vlans.forEach((item, vlan) => {
        const cidr = cidrs[vlan];
        const layout = lanLayout(cidr);
        const [low, high] = excludedRange(cidr);
        lines.push(`ip dhcp excluded-address ${low} ${high}`);
        const body: string[] = [`network ${cidr.network} ${cidr.mask}`, `default-router ${layout.gateway}`];
        if (dnsIp) {
          body.push(`dns-server ${dnsIp}`);
        }
        pushBlock(lines, `ip dhcp pool VLAN${item.id}`, body);
      });
    }

    vlans.forEach((item, vlan) => {
      const cidr = cidrs[vlan];
      addAddress(ctx, coreKey, gatewayName(vlan), lanLayout(cidr).gateway, cidr.mask, '-', `${item.name} (VLAN ${item.id}) gateway`);
    });
  }

  const servers: PlanServer[] = [];
  if (serverKey) {
    const pools = cidrs
      .map((cidr, vlan) => ({ cidr, vlan }))
      .filter(item => routing || item.vlan === serverVlan)
      .map(item => {
        const layout = lanLayout(item.cidr);
        return {
          name: `VLAN${vlans[item.vlan].id}`,
          gateway: routing ? layout.gateway : '0.0.0.0',
          dns: dnsIp || '0.0.0.0',
          start: hostAt(item.cidr, layout.hostStart),
          mask: item.cidr.mask,
          max: layout.poolMax,
        };
      });
    servers.push({
      key: serverKey,
      http: wantsWeb,
      html: webPage(spec.hostname),
      dns: spec.dns,
      records: spec.dns ? [{ name: spec.hostname, ip: serverIp }] : [],
      dhcp: dhcpServer,
      pools: dhcpServer ? pools : [],
    });
  }
  ctx.servers.push(...servers);

  vlans.forEach((item, vlan) => {
    addSubnet(ctx, `VLAN ${item.id} (${item.name})`, cidrs[vlan], `${item.name} hosts${routing ? ' with the gateway on ' + (coreKey || 'the core') : ''}`, null);
  });

  vlans.forEach((item, vlan) => {
    const pcs = pcsByVlan[vlan];
    if (pcs.length >= 2) {
      addCheck(ctx, {
        kind: 'ping',
        category: 'layer2',
        label: `${pcs[0]} reaches ${pcs[1]} inside VLAN ${item.id}`,
        from: pcs[0],
        toKey: pcs[1],
        expect: 'pass',
      });
    }
    if (routing && firstHosts[vlan]) {
      addCheck(ctx, {
        kind: 'ping',
        category: 'connectivity',
        label: `${firstHosts[vlan]} reaches its gateway ${lanLayout(cidrs[vlan]).gateway}`,
        from: firstHosts[vlan],
        toIp: lanLayout(cidrs[vlan]).gateway,
        expect: 'pass',
      });
    }
  });

  for (let first = 0; first < vlanTotal; first++) {
    for (let second = first + 1; second < vlanTotal; second++) {
      const from = firstHosts[first];
      const to = firstHosts[second];
      if (!from || !to) {
        continue;
      }
      if (!routing) {
        addCheck(ctx, {
          kind: 'ping',
          category: 'layer2',
          label: `${from} (VLAN ${vlans[first].id}) cannot reach ${to} (VLAN ${vlans[second].id}) because the VLANs are isolated`,
          from,
          toKey: to,
          expect: 'fail',
        });
        continue;
      }
      const blocked = view.pairBlocked(first, second);
      addCheck(ctx, {
        kind: 'ping',
        category: blocked ? 'security' : 'connectivity',
        label: blocked
          ? `${from} (VLAN ${vlans[first].id}) is blocked from ${to} (VLAN ${vlans[second].id}) by the ACL`
          : `${from} (VLAN ${vlans[first].id}) reaches ${to} (VLAN ${vlans[second].id}) through inter-VLAN routing`,
        from,
        toKey: to,
        expect: blocked ? 'fail' : 'pass',
      });
    }
  }

  if (serverKey) {
    for (let vlan = 0; vlan < vlanTotal; vlan++) {
      const host = firstHosts[vlan];
      if (!host) {
        continue;
      }
      const reachable = routing || vlan === serverVlan;
      const blocked = reachable && view.serverBlocked(vlan, 'ping', serverVlan, acl !== null && acl.to === -1);
      const expectPass = reachable && !blocked;
      addCheck(ctx, {
        kind: 'ping',
        category: blocked ? 'security' : reachable ? 'connectivity' : 'layer2',
        label: expectPass ? `${host} reaches the server` : `${host} cannot reach the server${blocked ? ' (ACL)' : ' (different VLAN)'}`,
        from: host,
        toKey: serverKey,
        expect: expectPass ? 'pass' : 'fail',
      });
    }
  }

  if (wantsWeb && serverKey) {
    const url = spec.dns ? `http://${spec.hostname}` : `http://${serverIp}`;
    for (let vlan = 0; vlan < vlanTotal; vlan++) {
      const host = firstHosts[vlan];
      if (!host) {
        continue;
      }
      const reachable = routing || vlan === serverVlan;
      const blocked = reachable && view.serverBlocked(vlan, 'http', serverVlan, acl !== null && acl.to === -1);
      const expectPass = reachable && !blocked;
      addCheck(ctx, {
        kind: 'http',
        category: blocked ? 'security' : 'service',
        label: expectPass ? `${host} opens ${url}` : `${host} cannot open ${url}${blocked ? ' (ACL)' : ' (different VLAN)'}`,
        from: host,
        url,
        expect: expectPass ? 'pass' : 'fail',
      });
    }
  }

  vlans.forEach((item, vlan) => {
    const host = firstHosts[vlan];
    if (host && dhcpFor(vlan)) {
      addCheck(ctx, {
        kind: 'dhcp',
        category: 'service',
        label: `${host} leased an address from ${cidrText(cidrs[vlan])}`,
        from: host,
        prefix: cidrText(cidrs[vlan]),
        expect: 'pass',
      });
    }
  });

  if (coreKey) {
    vlans.forEach((item, vlan) => {
      addCheck(ctx, {
        kind: 'route',
        category: 'routing',
        label: `${coreKey} is directly connected to VLAN ${item.id} (${cidrText(cidrs[vlan])})`,
        from: coreKey,
        prefix: cidrText(cidrs[vlan]),
        codes: ['C'],
        expect: 'pass',
      });
    });
    addShow(ctx, coreKey, 'show ip interface brief', 'Every gateway interface should be up/up.');
    addShow(ctx, coreKey, 'show ip route', 'One connected route per VLAN proves each gateway is active.');
    if (acl) {
      addShow(ctx, coreKey, 'show access-lists', 'ACL entries with hit counters.');
    }
    if (spec.dhcp === 'router') {
      addShow(ctx, coreKey, 'show ip dhcp binding', 'Addresses handed out by the gateway.');
    }
  }
  for (const key of switchKeys) {
    addShow(ctx, key, 'show vlan brief', 'Each VLAN lists the access ports assigned to it.');
    addShow(ctx, key, 'show interfaces trunk', 'Trunk ports carry the VLANs between devices.');
    addShow(ctx, key, 'show mac address-table', 'MAC addresses learned per VLAN.');
  }

  const vlanList = vlans.map(item => `${item.id} (${item.name})`).join(', ');
  addStep(
    ctx,
    'Plan the VLANs and subnets',
    `Create VLANs ${vlanList}. Each VLAN is its own broadcast domain and gets its own subnet: ${vlans.map((item, vlan) => `VLAN ${item.id} ${cidrText(cidrs[vlan])}`).join(', ')}.`,
  );
  addStep(
    ctx,
    'Build the topology',
    `Place ${switchCount} access switch${switchCount > 1 ? 'es' : ''}${coreKey ? ` and ${interVlan === 'roas' ? 'a router' : 'a Layer 3 switch'}` : ''}, connect the PCs to the switch ports and trunk the uplink${switchCount > 1 ? 's' : ''}.`,
  );
  addStep(
    ctx,
    'Configure the switches',
    'Create each VLAN with its name, put the host ports in the right VLAN with switchport mode access, and set the uplinks to switchport mode trunk.',
  );
  if (interVlan === 'roas') {
    addStep(ctx, 'Configure router-on-a-stick', 'Bring up the physical interface, then create one sub-interface per VLAN with encapsulation dot1Q and the gateway address.');
  } else if (interVlan === 'svi') {
    addStep(ctx, 'Configure the Layer 3 switch', 'Enable ip routing and create one SVI (interface vlan N) per VLAN with the gateway address.');
  } else {
    addStep(ctx, 'Keep the VLANs isolated', 'No router or Layer 3 interface is added, so hosts in different VLANs cannot reach each other even on the same switch.');
  }
  if (acl) {
    addStep(ctx, 'Apply the access list', `Block the requested traffic with ${acl.style === 'extended' ? 'an extended ACL on the inbound side of the source VLAN gateway' : 'a standard ACL on the outbound side of the destination VLAN gateway'}, then permit everything else.`);
  }
  addStep(ctx, 'Verify', 'Ping inside each VLAN, then across VLANs. Cross-VLAN pings work only when inter-VLAN routing is configured and not blocked by an ACL.');

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
    viva: vivaFor(spec),
    notes: ctx.notes,
    failover: null,
  };
}

function slotsOnSwitch(slots: HostSlot[], switchIndex: number): number {
  let count = 0;
  for (const slot of slots) {
    if (slot.switchIndex === switchIndex) {
      count += 1;
    }
  }
  return count;
}

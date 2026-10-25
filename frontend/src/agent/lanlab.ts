import { cidrText, hostAt, makeCidr, parseCidr, type Cidr } from './ipam.ts';
import {
  addCheck,
  addShow,
  addStep,
  addSubnet,
  buildSegment,
  configOf,
  createBuilder,
  lanLayout,
  normalizeLayout,
  webPage,
} from './builder.ts';
import { vivaFor } from './knowledge.ts';
import type { Plan, PlanServer } from './plan.ts';
import type { LabSpec } from './spec.ts';

export function buildLan(spec: LabSpec): Plan {
  const ctx = createBuilder(spec);
  let cidr: Cidr = makeCidr('192.168.1.0', 24);
  if (spec.networks.length > 0) {
    const given = parseCidr(spec.networks[0]);
    if (given && given.prefix <= 29) {
      cidr = given;
    }
  }

  const wantsWeb = spec.dns || spec.http;
  const dhcpServer = spec.dhcp === 'server';
  const needServer = wantsWeb || dhcpServer;
  const layout = lanLayout(cidr);
  const dnsIp = spec.dns ? layout.serverIp : '';

  const segment = buildSegment(ctx, {
    lan: 0,
    title: 'LAN 1',
    cidr,
    gateway: '',
    router: null,
    hostCount: spec.hostsPerLan,
    withServer: needServer,
    dhcpHosts: spec.dhcp !== 'none',
    dns: dnsIp,
    origin: { x: 0, y: -150 },
    dir: { x: 0, y: 1 },
  });

  const switchConfig = configOf(ctx, segment.switchKey, `${segment.switchKey} configuration`);
  if (!segment.switchKey.startsWith('HUB')) {
    switchConfig.lines.push(`hostname ${segment.switchKey}`);
  } else {
    ctx.configs.splice(ctx.configs.indexOf(switchConfig), 1);
  }

  const serverKey = segment.server;
  const servers: PlanServer[] = [];
  if (serverKey) {
    const pools = [
      {
        name: 'LAN1',
        gateway: '0.0.0.0',
        dns: dnsIp || '0.0.0.0',
        start: hostAt(cidr, layout.hostStart),
        mask: cidr.mask,
        max: layout.poolMax,
      },
    ];
    servers.push({
      key: serverKey,
      http: wantsWeb,
      html: webPage(spec.hostname),
      dns: spec.dns,
      records: spec.dns ? [{ name: spec.hostname, ip: layout.serverIp }] : [],
      dhcp: dhcpServer,
      pools: dhcpServer ? pools : [],
    });
  }
  ctx.servers.push(...servers);

  addSubnet(ctx, 'LAN 1', cidr, `Single ${spec.hub ? 'hub' : 'switch'} LAN`, null);

  const pcs = segment.pcs;
  if (pcs.length >= 2) {
    for (let index = 1; index < pcs.length; index++) {
      addCheck(ctx, {
        kind: 'ping',
        category: 'layer2',
        label: `${pcs[0]} reaches ${pcs[index]}`,
        from: pcs[0],
        toKey: pcs[index],
        expect: 'pass',
      });
    }
    if (pcs.length > 2) {
      addCheck(ctx, {
        kind: 'ping',
        category: 'layer2',
        label: `${pcs[pcs.length - 1]} reaches ${pcs[1]}`,
        from: pcs[pcs.length - 1],
        toKey: pcs[1],
        expect: 'pass',
      });
    }
  }

  if (serverKey) {
    for (const pc of pcs.slice(0, 3)) {
      addCheck(ctx, {
        kind: 'ping',
        category: 'connectivity',
        label: `${pc} reaches the server`,
        from: pc,
        toKey: serverKey,
        expect: 'pass',
      });
    }
  }

  if (wantsWeb && serverKey) {
    const url = spec.dns ? `http://${spec.hostname}` : `http://${layout.serverIp}`;
    for (const pc of pcs.slice(0, 3)) {
      addCheck(ctx, {
        kind: 'http',
        category: 'service',
        label: `${pc} opens ${url}`,
        from: pc,
        url,
        expect: 'pass',
      });
    }
  }

  if (spec.dhcp !== 'none') {
    for (const pc of pcs.slice(0, 3)) {
      addCheck(ctx, {
        kind: 'dhcp',
        category: 'service',
        label: `${pc} leased an address from ${cidrText(cidr)}`,
        from: pc,
        prefix: cidrText(cidr),
        expect: 'pass',
      });
    }
  }

  if (!segment.switchKey.startsWith('HUB')) {
    addShow(ctx, segment.switchKey, 'show mac address-table', 'The switch learns one MAC address per connected device.');
    addShow(ctx, segment.switchKey, 'show vlan brief', 'All ports belong to the default VLAN 1.');
  }

  addStep(
    ctx,
    'Plan the addressing',
    `Use ${cidrText(cidr)} for the whole LAN. Every device is in the same subnet, so no gateway is needed.`,
  );
  addStep(
    ctx,
    'Build the LAN',
    `Place one ${spec.hub ? 'hub' : 'switch'}, ${pcs.length} PC${pcs.length > 1 ? 's' : ''}${serverKey ? ' and a server' : ''}. Connect each device with a straight-through cable.`,
  );
  if (spec.hub) {
    ctx.notes.push('A hub repeats every frame to all ports, so all PCs share one collision domain.');
  }
  addStep(
    ctx,
    'Assign IP settings',
    spec.dhcp !== 'none'
      ? `Turn on DHCP on the server with a pool starting at ${hostAt(cidr, layout.hostStart)}, and let the PCs obtain their addresses automatically.`
      : `Give each PC a static address from ${hostAt(cidr, layout.hostStart)} upwards with mask ${cidr.mask}.`,
  );
  if (serverKey && wantsWeb) {
    addStep(ctx, 'Turn on the services', `Enable HTTP${spec.dns ? ` and add a DNS record ${spec.hostname} -> ${layout.serverIp}` : ''} on ${serverKey}.`);
  }
  addStep(ctx, 'Verify', 'Ping between the PCs. The first ping times out while ARP resolves; the following ones succeed.');

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

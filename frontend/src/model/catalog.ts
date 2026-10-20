import type { Kind, Port, PortKind } from './types.ts';
export interface ModelDef { id: string; label: string; kind: Kind; cat: 'router' | 'switch' | 'hub' | 'end'; base: string; desc: string; slots: number }
export const MODELS: ModelDef[] = [
  { id: '1941', label: '1941', kind: 'router', cat: 'router', base: 'Router', slots: 2, desc: 'Cisco 1941 Integrated Services Router (2x GigabitEthernet, 2 HWIC slots)' },
  { id: '2901', label: '2901', kind: 'router', cat: 'router', base: 'Router', slots: 2, desc: 'Cisco 2901 Integrated Services Router (2x GigabitEthernet, 2 HWIC slots)' },
  { id: '2911', label: '2911', kind: 'router', cat: 'router', base: 'Router', slots: 2, desc: 'Cisco 2911 Integrated Services Router (3x GigabitEthernet, 2 HWIC slots)' },
  { id: '2811', label: '2811', kind: 'router', cat: 'router', base: 'Router', slots: 2, desc: 'Cisco 2811 Router (2x FastEthernet, 2 HWIC slots)' },
  { id: 'PT-Router', label: 'PT-Router', kind: 'router', cat: 'router', base: 'Router', slots: 2, desc: 'Generic router (2x FastEthernet, 2 HWIC slots)' },
  { id: '2960-24TT', label: '2960', kind: 'switch', cat: 'switch', base: 'Switch', slots: 0, desc: 'Catalyst 2960-24TT (24x FastEthernet, 2x GigabitEthernet)' },
  { id: '2950-24', label: '2950-24', kind: 'switch', cat: 'switch', base: 'Switch', slots: 0, desc: 'Catalyst 2950-24 (24x FastEthernet)' },
  { id: '3560-24PS', label: '3560-24PS', kind: 'l3switch', cat: 'switch', base: 'Multilayer Switch', slots: 0, desc: 'Catalyst 3560-24PS multilayer switch (routing, SVIs)' },
  { id: 'Hub-PT', label: 'Hub-PT', kind: 'hub', cat: 'hub', base: 'Hub', slots: 0, desc: 'Generic 10-port hub' },
  { id: 'PC-PT', label: 'PC', kind: 'pc', cat: 'end', base: 'PC', slots: 0, desc: 'Generic desktop PC' },
  { id: 'Laptop-PT', label: 'Laptop', kind: 'laptop', cat: 'end', base: 'Laptop', slots: 0, desc: 'Generic laptop' },
  { id: 'Server-PT', label: 'Server', kind: 'server', cat: 'end', base: 'Server', slots: 0, desc: 'Generic server (HTTP, DNS, DHCP)' },
];
export const modelOf = (id: string): ModelDef => MODELS.find(m => m.id === id) ?? MODELS[0];
export const SERIAL_MODULE = 'HWIC-2T';
export function shortName(n: string): string {
  return n.replace('FastEthernet', 'Fa').replace('GigabitEthernet', 'Gig').replace('Serial', 'Se').replace('Loopback', 'Lo').replace('Vlan', 'Vl');
}
export function makePorts(model: string, modules: (string | null)[]): Omit<Port, 'mac'>[] {
  const m = modelOf(model); const out: Omit<Port, 'mac'>[] = [];
  const add = (name: string, kind: PortKind) => out.push({ name, short: shortName(name), kind });
  if (m.kind === 'router') {
    if (model === '1941' || model === '2901') { add('GigabitEthernet0/0', 'GigabitEthernet'); add('GigabitEthernet0/1', 'GigabitEthernet'); }
    else if (model === '2911') { for (let i = 0; i < 3; i++) add(`GigabitEthernet0/${i}`, 'GigabitEthernet'); }
    else { add('FastEthernet0/0', 'FastEthernet'); add('FastEthernet0/1', 'FastEthernet'); }
    modules.forEach((mod, s) => { if (mod === SERIAL_MODULE) { add(`Serial0/${s}/0`, 'Serial'); add(`Serial0/${s}/1`, 'Serial'); } });
    add('Console', 'Console');
  } else if (m.kind === 'switch' || m.kind === 'l3switch') {
    for (let i = 1; i <= 24; i++) add(`FastEthernet0/${i}`, 'FastEthernet');
    if (model !== '2950-24') { add('GigabitEthernet0/1', 'GigabitEthernet'); add('GigabitEthernet0/2', 'GigabitEthernet'); }
    add('Console', 'Console');
  } else if (m.kind === 'hub') {
    for (let i = 0; i < 10; i++) out.push({ name: `Port ${i}`, short: `P${i}`, kind: 'FastEthernet' });
  } else {
    add('FastEthernet0', 'FastEthernet');
    if (m.kind !== 'server') out.push({ name: 'RS 232', short: 'RS232', kind: 'RS232' });
  }
  return out;
}
export const isEth = (k: PortKind): boolean => k === 'FastEthernet' || k === 'GigabitEthernet';
export const isSwitch = (k: Kind): boolean => k === 'switch' || k === 'l3switch';
export const isHost = (k: Kind): boolean => k === 'pc' || k === 'laptop' || k === 'server';
export const PALETTE = [
  { id: 'router', label: 'Routers', cat: 'router' }, { id: 'switch', label: 'Switches', cat: 'switch' },
  { id: 'hub', label: 'Hubs', cat: 'hub' }, { id: 'end', label: 'End Devices', cat: 'end' },
] as const;
export const CABLES = [
  { id: 'auto', label: 'Automatically Choose Connection Type' }, { id: 'console', label: 'Console' },
  { id: 'straight', label: 'Copper Straight-Through' }, { id: 'cross', label: 'Copper Cross-Over' },
  { id: 'serialdce', label: 'Serial DCE' }, { id: 'serialdte', label: 'Serial DTE' },
] as const;

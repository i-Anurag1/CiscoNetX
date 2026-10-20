const API = ((import.meta as any).env?.VITE_API_URL || '').replace(/\/$/, '');
export interface ApiResult<T = any> { ok: boolean; data?: T; error?: string; status?: number }
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<ApiResult<T>> {
  try {
    const r = await fetch(API + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const d = (data as any)?.detail; const msg = Array.isArray(d) ? d.map((x: any) => `${(x.loc || []).slice(1).join('.')}: ${x.msg}`).join('; ') : typeof d === 'string' ? d : `HTTP ${r.status}`;
      return { ok: false, error: msg, status: r.status };
    }
    return { ok: true, data: data as T, status: r.status };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name !== 'TimeoutError' ? 'Backend is offline — start it with: uvicorn app.main:app --port 8000' : 'Backend did not respond in time.' };
  }
}
export interface LabDef { id: string; title: string; group: string; path: string; fields: { key: string; label: string; value: string }[]; params: (v: Record<string, string>) => Record<string, string | number | number[]> }
const num = (s: string, d = 0): number => (s.trim() === '' || Number.isNaN(Number(s)) ? d : Number(s));
const list = (s: string): number[] => s.split(',').map(x => x.trim()).filter(Boolean).map(Number).filter(x => !Number.isNaN(x));
/** The lab endpoints take query-string parameters (repeated keys for lists), not JSON bodies. */
export function postQuery<T = any>(path: string, params: Record<string, string | number | number[]>): Promise<ApiResult<T>> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (Array.isArray(v)) v.forEach(x => q.append(k, String(x))); else q.append(k, String(v)); }
  return api<T>(`${path}?${q.toString()}`, {}, 'POST');
}
export const LABS: LabDef[] = [
  { id: 'subnet', title: 'Subnet calculator', group: 'IP', path: '/api/v1/lab/subnet', fields: [{ key: 'network', label: 'Network / IP', value: '192.168.10.0' }, { key: 'prefix', label: 'Prefix', value: '26' }], params: v => ({ network: v.network, prefix: num(v.prefix, 24) }) },
  { id: 'crc', title: 'CRC error detection', group: 'Data link', path: '/api/v1/lab/crc', fields: [{ key: 'data', label: 'Data', value: 'HELLO' }], params: v => ({ data: v.data }) },
  { id: 'hamming', title: 'Hamming code', group: 'Data link', path: '/api/v1/lab/hamming', fields: [{ key: 'data', label: 'Data bits', value: '1011' }], params: v => ({ data: v.data }) },
  { id: 'checksum', title: 'Internet checksum', group: 'Data link', path: '/api/v1/lab/checksum', fields: [{ key: 'data', label: 'Data', value: 'CiscoNetX' }], params: v => ({ data: v.data }) },
  { id: 'tcp', title: 'TCP congestion model', group: 'Transport', path: '/api/v1/lab/tcp', fields: [{ key: 'loss', label: 'Loss probability (0-1)', value: '0.1' }, { key: 'rounds', label: 'Rounds', value: '20' }], params: v => ({ loss: num(v.loss, 0.1), rounds: num(v.rounds, 20) }) },
  { id: 'arq', title: 'ARQ (stop-and-wait / Go-Back-N / Selective Repeat)', group: 'Data link', path: '/api/v1/lab/arq-v2', fields: [{ key: 'protocol', label: 'Protocol (stop_and_wait | go_back_n | selective_repeat)', value: 'go_back_n' }, { key: 'frames', label: 'Frames', value: '10' }, { key: 'window', label: 'Window', value: '4' }, { key: 'losses', label: 'Lost frames (comma separated)', value: '3,6' }], params: v => ({ protocol: v.protocol, frames: num(v.frames, 10), window: num(v.window, 4), losses: list(v.losses), seed: 42 }) },
];

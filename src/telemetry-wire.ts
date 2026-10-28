import { TOOL_NAMES, OUTCOMES, DURATIONS, FEATURES } from './tool-instrumentation.js';
import { WINRM_REASONS } from './winrm-reason.js';
const TOOLS = new Set<string>(TOOL_NAMES);
const allowed = (entries: Record<string, unknown>, keys: readonly string[]) => Object.keys(entries).length > 0 && Object.entries(entries).every(([key, count]) => keys.includes(key) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0);
export function validMetrics(value: unknown): boolean {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).length > TOOLS.size) return false;
  return Object.entries(value).every(([name, row]) => {
    if (!TOOLS.has(name) || !object(row) || Object.keys(row).sort().join(',') !== ('winrmReasons' in row ? 'durations,features,outcomes,winrmReasons' : 'durations,features,outcomes') || !object(row.outcomes) || !object(row.durations) || !object(row.features)) return false;
    if (!allowed(row.outcomes, OUTCOMES) || !allowed(row.durations, DURATIONS) || !allowed(row.features, FEATURES)) return false;
    const total = (r: Record<string, unknown>) => Object.values(r).reduce<number>((n, v) => n + (v as number), 0);
    if ('winrmReasons' in row && (name !== 'winrm_exec' || !object(row.winrmReasons) || !allowed(row.winrmReasons, WINRM_REASONS) || total(row.winrmReasons) !== total(row.outcomes))) return false;
    return Number.isSafeInteger(total(row.outcomes)) && total(row.outcomes) === total(row.durations) && total(row.outcomes) === total(row.features);
  });
}
const OS = new Set(['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// User opt-in tokens must be canonical random UUIDv4, never account-derived labels.
export const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validQueuedEvent(value: unknown, eventId: string): boolean {
  if (!object(value) || value.eventId !== eventId || !UUID.test(eventId)) return false;
  if ((value.event === 'tool_metrics' && value.schemaVersion !== 2) || (value.event !== 'tool_metrics' && value.schemaVersion !== 1)) return false;
  if (value.event !== 'startup' && value.event !== 'tool_counts' && value.event !== 'tool_metrics') return false;
  const keys = ['event', 'eventId', 'hostId', 'os', 'schemaVersion', 'ts', 'version'];
  if ('userId' in value) { if (typeof value.userId !== 'string' || !USER_ID.test(value.userId)) return false; keys.push('userId'); }
  if ('cohort' in value) { if (value.cohort !== 'external_self_declared') return false; keys.push('cohort'); }
  if (value.event === 'tool_counts') keys.push('counts');
  if (value.event === 'tool_metrics') keys.push('metrics');
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) return false;
  if (typeof value.hostId !== 'string' || !UUID.test(value.hostId) || typeof value.version !== 'string' || !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value.version)) return false;
  if (typeof value.os !== 'string' || !OS.has(value.os) || typeof value.ts !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.ts) || !Number.isFinite(Date.parse(value.ts)) || new Date(value.ts).toISOString() !== value.ts) return false;
  if (value.event === 'startup') return true;
  if (value.event === 'tool_metrics') return validMetrics(value.metrics);
  return object(value.counts) && Object.keys(value.counts).length > 0 && Object.entries(value.counts).every(([key, count]) => TOOLS.has(key) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0);
}
export async function readAcknowledgement(response: Response, eventId: string): Promise<void> {
  if (response.status !== 202 || !response.body) { await response.body?.cancel(); throw Error('not acknowledged'); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024) throw Error('oversized acknowledgement');
      chunks.push(next.value);
    }
    const ack: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(ack) || ack.ok !== true || ack.eventId !== eventId || Object.keys(ack).sort().join(',') !== 'eventId,ok') throw Error('wrong acknowledgement');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

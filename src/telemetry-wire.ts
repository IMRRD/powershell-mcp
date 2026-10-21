const TOOLS = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program']);
const OS = new Set(['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function validQueuedEvent(value: unknown, eventId: string): boolean {
  if (!object(value) || value.schemaVersion !== 1 || value.eventId !== eventId || !UUID.test(eventId)) return false;
  if (value.event !== 'startup' && value.event !== 'tool_counts') return false;
  const keys = ['event', 'eventId', 'hostId', 'os', 'schemaVersion', 'ts', 'version'];
  if (value.event === 'tool_counts') keys.push('counts');
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) return false;
  if (typeof value.hostId !== 'string' || !UUID.test(value.hostId) || typeof value.version !== 'string' || !/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(value.version)) return false;
  if (typeof value.os !== 'string' || !OS.has(value.os) || typeof value.ts !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.ts) || !Number.isFinite(Date.parse(value.ts)) || new Date(value.ts).toISOString() !== value.ts) return false;
  return value.event === 'startup' || (object(value.counts) && Object.keys(value.counts).length > 0 && Object.entries(value.counts).every(([key, count]) => TOOLS.has(key) && typeof count === 'number' && Number.isSafeInteger(count) && count > 0));
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

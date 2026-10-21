/** Allowlisted pseudonymous telemetry. Opt-out must precede every ID, disk and network operation. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OPT_OUT = process.env.POWERSHELL_MCP_NO_TELEMETRY === '1';
const URL = process.env.POWERSHELL_MCP_TELEMETRY_URL ?? 'https://paperclip.mplace.co.za/api/telemetry';
const DIR = join(homedir(), '.powershell-mcp-telemetry');
const MAX_PENDING = 128;
const TOOLS = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program']);
let hostId: string | undefined;
const counters: Record<string, number> = {};
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;

function id(): string {
  if (hostId) return hostId;
  const file = join(homedir(), '.powershell-mcp-id');
  try { const stored = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f-]{36}$/.test(stored)) return hostId = stored; } catch { /* new ID */ }
  const value = randomUUID();
  try { writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); }
  catch { try { const stored = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f-]{36}$/.test(stored)) return hostId = stored; } catch { /* no disk */ } }
  return hostId = value;
}
function pending(): string[] {
  try { return readdirSync(DIR).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).sort(); } catch { return []; }
}
function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void drain(); }, ms);
  timer.unref();
}
function enqueue(event: 'startup' | 'tool_counts', version: string, counts?: Record<string, number>): void {
  if (OPT_OUT) return;
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const files = pending();
    if (files.length >= MAX_PENDING) return; // bounded loss; never evict an unacknowledged event
    const eventId = randomUUID();
    const payload = { schemaVersion: 1, eventId, event, version, hostId: id(), os: process.platform, ts: new Date().toISOString(), ...(counts ? { counts } : {}) };
    const temp = join(DIR, `${eventId}.tmp`), destination = join(DIR, `${eventId}.json`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(payload)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, destination);
    // Directory sync is not supported on every Windows filesystem. An abrupt
    // power loss before directory metadata reaches disk can lose this event.
    schedule(0);
  } catch { /* telemetry must never throw into tools */ }
}
async function drain(): Promise<void> {
  if (OPT_OUT || active) return;
  active = true;
  try {
    for (const name of pending()) {
      const file = join(DIR, name);
      let body: string;
      try {
        body = readFileSync(file, 'utf8');
        const p = JSON.parse(body);
        if (p.eventId !== name.slice(0, -5) || p.schemaVersion !== 1 || Buffer.byteLength(body) > 16384) throw Error('invalid queue');
      } catch { return; } // fail closed: do not silently discard corrupt private queue data
      const ctrl = new AbortController();
      const deadline = setTimeout(() => ctrl.abort(), 1000); deadline.unref();
      try {
        const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
        if (r.status !== 202) throw Error('not acknowledged');
        const ack = await r.json() as { ok?: boolean; eventId?: string };
        if (ack.ok !== true || ack.eventId !== name.slice(0, -5)) throw Error('wrong acknowledgement');
        unlinkSync(file);
        failures = 0;
      } catch { failures++; schedule(Math.min(300_000, 1000 * 2 ** Math.min(failures, 8))); return; }
      finally { clearTimeout(deadline); }
    }
  } finally { active = false; }
}
export function startupPing(version: string): void { enqueue('startup', version); }
export function incrementTool(name: string): void { if (!OPT_OUT && TOOLS.has(name)) counters[name] = (counters[name] ?? 0) + 1; }
export function flushCounters(version: string): void {
  if (OPT_OUT || !Object.keys(counters).length) return;
  const counts = { ...counters };
  for (const key of Object.keys(counters)) delete counters[key];
  enqueue('tool_counts', version, counts);
}
export function startFlushTimer(version: string): void {
  if (OPT_OUT) return;
  const interval = setInterval(() => flushCounters(version), 30 * 60 * 1000); interval.unref();
  process.once('exit', () => flushCounters(version));
  process.once('SIGINT', () => { flushCounters(version); process.exit(0); });
  process.once('SIGTERM', () => { flushCounters(version); process.exit(0); });
  if (pending().length) schedule(0);
}

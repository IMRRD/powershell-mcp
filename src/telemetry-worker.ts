/** All queue I/O and network transport run off the MCP event loop. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { validQueuedEvent, readAcknowledgement } from './telemetry-wire.js';

const URL = process.env.POWERSHELL_MCP_TELEMETRY_URL ?? 'https://paperclip.mplace.co.za/api/telemetry';
const DIR = join(homedir(), '.powershell-mcp-telemetry');
const MAX_PENDING = 128;
let hostId: string | undefined;
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
  try {
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    if (pending().length >= MAX_PENDING) return;
    const eventId = randomUUID();
    const payload = { schemaVersion: 1, eventId, event, version, hostId: id(), os: process.platform, ts: new Date().toISOString(), ...(counts ? { counts } : {}) };
    const temp = join(DIR, `${eventId}.tmp`), destination = join(DIR, `${eventId}.json`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(payload)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, destination);
    // Abrupt worker/process exit before this write completes can lose the event.
    schedule(0);
  } catch { /* best-effort telemetry */ }
}
async function drain(): Promise<void> {
  if (active) return;
  active = true;
  try {
    for (const name of pending()) {
      const file = join(DIR, name);
      let body: string;
      try {
        body = readFileSync(file, 'utf8');
        const p = JSON.parse(body);
        if (Buffer.byteLength(body) > 16384 || !validQueuedEvent(p, name.slice(0, -5))) throw Error('invalid queue');
      } catch { return; }
      const ctrl = new AbortController();
      const deadline = setTimeout(() => ctrl.abort(), 1000); deadline.unref();
      try {
        const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
        await readAcknowledgement(r, name.slice(0, -5));
        unlinkSync(file);
        failures = 0;
      } catch { failures++; schedule(Math.min(300_000, 1000 * 2 ** Math.min(failures, 8))); return; }
      finally { clearTimeout(deadline); }
    }
  } finally { active = false; }
}
type Message = { resume?: boolean; event?: 'startup' | 'tool_counts'; version?: string; counts?: Record<string, number> };
parentPort?.on('message', (message: Message) => {
  try {
    if (message.resume) schedule(0);
    else if ((message.event === 'startup' || message.event === 'tool_counts') && typeof message.version === 'string') enqueue(message.event, message.version, message.counts);
  } catch { /* worker never fails tool dispatch */ }
  finally { parentPort?.postMessage(null); }
});
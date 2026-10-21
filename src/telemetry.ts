/** Allowlisted pseudonymous telemetry. Opt-out must precede every ID, disk and network operation. */
import { Worker } from 'node:worker_threads';

const OPT_OUT = process.env.POWERSHELL_MCP_NO_TELEMETRY === '1';
const MAX_PENDING = 128;
const TOOLS = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program']);
const counters: Record<string, number> = {};
let worker: Worker | undefined;
let outstanding = 0;
let dropped = 0;
let failures = 0;
export function telemetryStatus(): Readonly<{ outstanding: number; dropped: number; failures: number }> {
  return { outstanding, dropped, failures };
}
function ensureWorker(): Worker | undefined {
  if (OPT_OUT) return;
  if (worker) return worker;
  try {
    const instance = new Worker(new URL('./telemetry-worker.js', import.meta.url), { execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')) });
    instance.unref();
    worker = instance;
    instance.on('message', (status: { dropped?: number }) => { if (worker === instance) { if (Number.isSafeInteger(status?.dropped) && status.dropped! > 0) dropped += status.dropped!; outstanding = Math.max(0, outstanding - 1); if (!outstanding) instance.unref(); } });
    const failed = () => {
      if (worker !== instance) return;
      worker = undefined;
      dropped += outstanding;
      outstanding = 0;
      failures++;
    };
    instance.on('error', failed);
    instance.on('exit', failed);
    return instance;
  } catch { failures++; return; }
}
function submit(message: object): void {
  if (OPT_OUT) return;
  if (outstanding >= MAX_PENDING) { dropped++; return; }
  const target = ensureWorker();
  if (!target) { dropped++; return; }
  try { target.ref(); target.postMessage(message); outstanding++; }
  catch { dropped++; failures++; }
}
function enqueue(event: 'startup' | 'tool_counts', version: string, counts?: Record<string, number>): void {
  submit({ event, version, counts });
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
  submit({ resume: true });
}

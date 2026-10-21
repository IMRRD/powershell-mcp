/** Allowlisted pseudonymous telemetry. Opt-out must precede every ID, disk and network operation. */
import { Worker } from 'node:worker_threads';
import { TOOL_NAMES, OUTCOMES, DURATIONS, FEATURES, type ToolName, type Outcome, type Duration, type Feature } from './tool-instrumentation.js';

const OPT_OUT = process.env.POWERSHELL_MCP_NO_TELEMETRY === '1';
const MAX_PENDING = 128;
const TOOLS = new Set<string>(TOOL_NAMES);
const counters: Record<string, number> = {};
type Metric = { outcomes: Record<string, number>; durations: Record<string, number>; features: Record<string, number> };
const metrics: Record<string, Metric> = {};
const bump = (axis: Record<string, number>, key: string) => { axis[key] = (axis[key] ?? 0) + 1; };
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
function enqueue(event: 'startup' | 'tool_counts' | 'tool_metrics', version: string, counts?: Record<string, number>, batch?: Record<string, Metric>): void {
  submit({ event, version, ...(counts ? { counts } : {}), ...(batch ? { metrics: batch } : {}) });
}
export function startupPing(version: string): void { enqueue('startup', version); }
export function incrementTool(name: string): void { if (!OPT_OUT && TOOLS.has(name)) counters[name] = (counters[name] ?? 0) + 1; }
export function recordTool(name: ToolName, outcome: Outcome, duration: Duration, feature: Feature): void {
  if (OPT_OUT || !TOOLS.has(name) || !OUTCOMES.includes(outcome) || !DURATIONS.includes(duration) || !FEATURES.includes(feature)) return;
  incrementTool(name);
  const row = metrics[name] ??= { outcomes: {}, durations: {}, features: {} };
  bump(row.outcomes, outcome); bump(row.durations, duration); bump(row.features, feature);
}
export function flushCounters(version: string): void {
  if (OPT_OUT) return;
  if (Object.keys(counters).length) {
    const counts = { ...counters };
    for (const key of Object.keys(counters)) delete counters[key];
    enqueue('tool_counts', version, counts);
  }
  if (Object.keys(metrics).length) {
    const batch = { ...metrics };
    for (const key of Object.keys(metrics)) delete metrics[key];
    enqueue('tool_metrics', version, undefined, batch);
  }
}
export function startFlushTimer(version: string): void {
  if (OPT_OUT) return;
  const interval = setInterval(() => flushCounters(version), 30 * 60 * 1000); interval.unref();
  // beforeExit permits the worker's local persistence ACK to finish; exit cannot.
  process.once('beforeExit', () => flushCounters(version));
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.once(signal, () => {
      flushCounters(version);
      const deadline = setTimeout(() => {
        dropped += outstanding;
        process.stderr.write(`telemetry: local persistence deadline exceeded; ${outstanding} unconfirmed message(s), ${dropped} dropped\n`);
        process.exit(code);
      }, 2000);
      const wait = () => {
        if (outstanding) { setTimeout(wait, 10); return; }
        clearTimeout(deadline);
        process.exit(code);
      };
      wait();
    });
  }
  submit({ resume: true });
}

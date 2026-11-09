import { randomUUID } from 'node:crypto';
import { RestrictedDiagnosticsStore } from './diagnostics-store.js';
import { diagnosticPair, DIAGNOSTIC_TOOLS, INSTALLATION, type DiagnosticTool } from './diagnostics-schema.js';

let disabled = false;
let pending = 0;
let dropped = 0;
let tail: Promise<void> = Promise.resolve();
let attempts: number[] = [];
function configuration(): { directory: string; installation: string } | undefined {
  if (disabled || process.platform !== 'win32' || process.env.POWERSHELL_MCP_DIAGNOSTICS !== '1') return;
  const directory = process.env.POWERSHELL_MCP_DIAGNOSTICS_DIR;
  const installation = process.env.POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION;
  if (directory && installation && INSTALLATION.test(installation)) return { directory, installation };
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  // Do not execute caller-defined getters, stringify objects, or inspect messages/stacks.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
export function beginDiagnostic(tool: string): ((elapsed: number, result: unknown, failure?: unknown, failed?: boolean) => void) | undefined {
  const config = configuration();
  if (!config || !DIAGNOSTIC_TOOLS.includes(tool as DiagnosticTool)) return;
  const now = performance.now();
  attempts = attempts.filter(time => now - time < 60000);
  if (pending >= 8 || attempts.length >= 6) { dropped++; return; }
  attempts.push(now);
  const id = randomUUID(); // independent of public telemetry and result/execution identities
  let finished = false;
  return (elapsed, result, failure, failed = false) => {
    if (finished) return;
    finished = true;
    if (pending >= 8 || JSON.stringify(configuration()) !== JSON.stringify(config)) { dropped++; return; }
    let type: unknown = own(own(result, 'structuredContent'), 'terminationStatus');
    let code: unknown = null;
    if (failed) {
      type = failure instanceof TypeError ? 'TypeError' : failure instanceof RangeError ? 'RangeError' : failure instanceof SyntaxError ? 'SyntaxError' : failure instanceof Error ? 'Error' : 'other_exception';
      code = own(failure, 'errno');
    }
    const pair = diagnosticPair(tool as DiagnosticTool, id, elapsed, type, code);
    pending++;
    tail = tail.then(async () => {
      try {
        if (JSON.stringify(configuration()) !== JSON.stringify(config)) { dropped++; return; }
        const reply = await new RestrictedDiagnosticsStore(config.directory, config.installation).append(pair);
        if (reply.status !== 'ok') dropped++;
      } catch { dropped++; }
      finally { pending--; }
    });
  };
}
/** Immediate process-local capture kill switch; queued captures are discarded. Persistent disable/revoke uses the store API. */
export function disableDiagnostics(): void { disabled = true; }
export function diagnosticsStatus(): Readonly<{ pending: number; dropped: number }> { return { pending, dropped }; }
export async function drainDiagnostics(): Promise<void> { await tail; }

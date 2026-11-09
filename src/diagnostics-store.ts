import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORRELATION, INSTALLATION, DIAGNOSTICS_POLICY, validDiagnosticPair, type DiagnosticPair } from './diagnostics-schema.js';

export type StoreStatus = 'ok' | 'inactive' | 'denied' | 'limited' | 'unavailable' | 'invalid';
export interface StoreReply { status: StoreStatus; pairs?: DiagnosticPair[]; nextAfter?: string | null }
/** Operator API only. Never registered as an MCP tool; no networking or telemetry dependency. */
export class RestrictedDiagnosticsStore {
  constructor(private readonly directory: string, private readonly installation: string) {}
  consent(policy: typeof DIAGNOSTICS_POLICY): Promise<StoreReply> {
    if (policy !== DIAGNOSTICS_POLICY) return Promise.resolve({ status: 'invalid' });
    return this.invoke('consent', { policy });
  }
  append(pair: unknown): Promise<StoreReply> {
    if (!validDiagnosticPair(pair)) return Promise.resolve({ status: 'invalid' });
    // Copy now: caller mutation must not race asynchronous stdin delivery.
    return this.invoke('append', { pair: structuredClone(pair) });
  }
  read(limit = 16, after?: string): Promise<StoreReply> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16 || (after !== undefined && !CORRELATION.test(after))) return Promise.resolve({ status: 'invalid' });
    return this.invoke('read', { limit, ...(after === undefined ? {} : { after }) });
  }
  disable(): Promise<StoreReply> { return this.invoke('disable'); }
  revoke(): Promise<StoreReply> { return this.invoke('revoke'); }
  private async invoke(operation: string, extra: object = {}): Promise<StoreReply> {
    if (process.platform !== 'win32') return { status: 'unavailable' };
    if (!isAbsolute(this.directory) || !INSTALLATION.test(this.installation)) return { status: 'invalid' };
    const request = JSON.stringify({ operation, directory: this.directory, installation: this.installation, ...extra });
    if (Buffer.byteLength(request) > 4096) return { status: 'invalid' };
    return new Promise(resolve => {
      let settled = false;
      const finish = (reply: StoreReply) => { if (!settled) { settled = true; resolve(reply); } };
      try {
        const child = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../scripts/restricted-diagnostics.ps1', import.meta.url))],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', bytes = 0;
        const timer = setTimeout(() => { child.kill(); finish({ status: 'unavailable' }); }, 5000);
        child.stdout.on('data', (part: Buffer) => {
          bytes += part.length;
          if (bytes > 32768) { child.kill(); finish({ status: 'unavailable' }); }
          else output += part.toString('utf8');
        });
        child.on('error', () => { clearTimeout(timer); finish({ status: 'unavailable' }); });
        child.stdin.on('error', () => { /* EPIPE is reported by close, never raw diagnostics. */ });
        child.on('close', code => {
          clearTimeout(timer);
          try {
            if (code !== 0 || bytes > 32768) throw Error();
            const reply: unknown = JSON.parse(output);
            if (!reply || typeof reply !== 'object' || Array.isArray(reply)) throw Error();
            const data = reply as StoreReply;
            if (!['ok', 'inactive', 'denied', 'limited', 'unavailable', 'invalid'].includes(data.status)) throw Error();
            if (operation === 'read' && data.status === 'ok') {
              if (Object.keys(data).sort().join(',') !== 'nextAfter,pairs,status' || !Array.isArray(data.pairs) ||
                data.pairs.length > 16 || !data.pairs.every(validDiagnosticPair) ||
                (data.nextAfter !== null && (typeof data.nextAfter !== 'string' || !CORRELATION.test(data.nextAfter)))) throw Error();
            } else if (Object.keys(data).join(',') !== 'status') throw Error();
            finish(data);
          } catch { finish({ status: 'unavailable' }); }
        });
        child.stdin.end(request);
      } catch { finish({ status: 'unavailable' }); }
    });
  }
}

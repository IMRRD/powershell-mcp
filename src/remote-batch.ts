import { randomBytes } from 'node:crypto';
import { runSsh, type SshHop } from './ssh.js';
import { runWinRm, WinRmDispatchDeadlineError } from './winrm.js';
import { configuredProvider, resolveCredential, sanitizeCredentialResult } from './credentials.js';
import { hostTrust } from './host-trust.js';

export type BatchTarget = {
  transport: 'ssh' | 'winrm'; host: string; command: string; username?: string;
  port?: number; privateKeyPath?: string; passphrase?: string; password?: string; credentialRef?: string;
  hostKeyPins?: string[]; jumps?: SshHop[]; useSsl?: boolean; authentication?: 'Default' | 'Negotiate' | 'Kerberos' | 'Basic' | 'CredSSP';
  parameters?: Record<string, unknown>;
};
export type BatchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'unknown';
export interface BatchRecord { index: number; host: string; transport: BatchTarget['transport']; status: BatchStatus; result?: unknown; reason?: string }
export interface BatchSnapshot { id: string; status: 'running' | 'completed' | 'partial' | 'cancelled'; results: BatchRecord[] }
export interface BatchRequest { targets: BatchTarget[]; concurrency: number; timeoutMs: number }
type Outcome = { status: 'completed' | 'failed' | 'timeout' | 'unknown'; output?: unknown; reason?: string };

export async function executeBatchTarget(target: BatchTarget, timeoutMs: number): Promise<Outcome> {
  const started = Date.now();
  const auth = await resolveCredential({ credentialRef: target.credentialRef, transport: target.transport, host: target.host, port: target.transport === 'ssh' ? target.port ?? 22 : target.useSsl ? 5986 : 5985, principal: target.username ?? '', username: target.username, password: target.password, passphrase: target.passphrase, privateKeyPath: target.privateKeyPath }, configuredProvider());
  if (target.transport === 'ssh') {
    if (target.jumps && (!Array.isArray(target.jumps) || target.jumps.length > 4)) throw Error("Invalid jump route");
    hostTrust({ host: target.host, port: target.port, hostKeyPins: target.hostKeyPins, knownHostsPath: process.env.POWERSHELL_MCP_KNOWN_HOSTS });
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return { status: 'unknown', reason: 'Invocation deadline elapsed before dispatch; remote execution unverified' };
    const r = await runSsh({ host: target.host, username: target.username!, command: target.command, port: target.port, privateKeyPath: target.privateKeyPath, passphrase: target.passphrase, password: target.password, ...auth, hostKeyPins: target.hostKeyPins, jumps: target.jumps, knownHostsPath: process.env.POWERSHELL_MCP_KNOWN_HOSTS, deadlineAt: started + timeoutMs, maxOutputBytes: 65536, logOutput: false });
    const safe = sanitizeCredentialResult(r, { ...auth, password: auth.password ?? target.password, passphrase: auth.passphrase ?? target.passphrase });
    return { status: r.timedOut ? 'timeout' : r.error || r.exitCode !== 0 ? 'failed' : 'completed', output: safe };
  }
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining <= 0) return { status: 'unknown', reason: 'Invocation deadline elapsed before dispatch; remote execution unverified' };
  let r;
  try { r = await runWinRm({ computerName: target.host, command: target.command, parameters: target.parameters, username: target.username, password: target.password, ...auth, useSsl: target.useSsl, authentication: target.authentication, timeoutMs: remaining, dispatchDeadlineAt: started + timeoutMs, maxOutputBytes: 65536, logOutput: false }); }
  catch (error) {
    if (error instanceof WinRmDispatchDeadlineError) return { status: 'unknown', reason: error.message };
    throw error;
  }
  const safe = sanitizeCredentialResult(r, { ...auth, password: auth.password ?? target.password, passphrase: auth.passphrase ?? target.passphrase });
  return { status: r.timedOut ? 'timeout' : r.invocationStatus === 'completed' ? 'completed' : 'failed', output: safe };
}

type Job = { records: BatchRecord[]; pending: (BatchTarget | undefined)[]; cancelled: boolean; live: number; settledAt?: number };
const MAX_JOBS = 32, MAX_TARGETS = 256, MAX_OUTPUT = 2 * 1024 * 1024, RETENTION_MS = 60_000;
export class RemoteBatchStore {
  private jobs = new Map<string, Job>();
  private live = 0;
  constructor(private readonly execute: (target: BatchTarget, timeoutMs: number) => Promise<Outcome> = executeBatchTarget,
    private readonly now: () => number = Date.now) {}
  private prune() {
    for (const [id, job] of this.jobs) if (job.settledAt !== undefined && this.now() - job.settledAt >= RETENTION_MS) this.jobs.delete(id);
  }
  private finish(job: Job) {
    if (!job.live && !job.records.some(r => r.status === 'queued') && job.settledAt === undefined) job.settledAt = this.now();
  }
  start(request: BatchRequest): string {
    if (!request.targets.length || request.targets.length > 32 || !Number.isInteger(request.concurrency) || request.concurrency < 1 || request.concurrency > 8 || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 900000) throw Error('Invalid batch bounds');
    for (const t of request.targets) {
      if (!t.host || !t.command || !['ssh','winrm'].includes(t.transport) || (t.transport === 'ssh' && (!t.username || !Number.isInteger(t.port ?? 22) || (t.port ?? 22) < 1 || (t.port ?? 22) > 65535)) || (t.transport === 'winrm' && t.port !== undefined)) throw Error('Invalid target');
    }
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 1_048_576) throw Error('Batch input capacity exhausted');
    this.prune();
    const count = [...this.jobs.values()].reduce((n, j) => n + j.records.length, 0);
    if (this.jobs.size >= MAX_JOBS || count + request.targets.length > MAX_TARGETS || this.live >= 8) throw Error('Batch capacity exhausted');
    const id = randomBytes(24).toString('hex');
    const job: Job = { records: request.targets.map((t, index): BatchRecord => ({ index, host: t.host, transport: t.transport, status: 'queued' })), pending: [...request.targets], cancelled: false, live: 0 };
    this.jobs.set(id, job);
    const { timeoutMs, concurrency } = request;
    let cursor = 0;
    const worker = async () => {
      while (!job.cancelled && cursor < job.records.length) {
        while (this.live >= 8 && !job.cancelled) await new Promise(resolve => setTimeout(resolve, 10));
        if (job.cancelled) break;
        const index = cursor++;
        const record = job.records[index]; record.status = 'running';
        const target = job.pending[index]!; job.pending[index] = undefined;
        job.live++; this.live++;
        const timer = setTimeout(() => {
          if (record.status === 'running') { record.status = 'unknown'; record.reason = 'Invocation deadline elapsed; remote termination not proven'; }
        }, timeoutMs);
        try {
          const outcome = await this.execute(target, timeoutMs);
          if (record.status === 'running') {
            const value = outcome.output === undefined ? undefined : Buffer.byteLength(JSON.stringify(outcome.output), 'utf8');
            const used = [...this.jobs.values()].reduce((n, j) => n + j.records.reduce((m, r) => m + (r.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(r.result), 'utf8')), 0), 0);
            record.status = outcome.status;
            if (value !== undefined && value + used <= MAX_OUTPUT) record.result = outcome.output;
            else if (value !== undefined) { record.status = 'unknown'; record.reason = 'Aggregate output capacity exceeded; remote state unverified'; }
            record.reason ??= outcome.reason;
          }
        } catch { if (record.status === 'running') { record.status = 'unknown'; record.reason = 'Target invocation failed; remote execution state unverified'; } }
        finally { clearTimeout(timer); job.live--; this.live--; this.finish(job); }
      }
      this.finish(job);
    };
    for (let i = 0; i < Math.min(concurrency, job.records.length); i++) void worker();
    return id;
  }
  status(id: string): BatchSnapshot | undefined {
    this.prune();
    const job = this.jobs.get(id); if (!job) return undefined;
    const results = job.records.map(r => ({ ...r }));
    const active = results.some(r => r.status === 'running' || r.status === 'queued');
    return { id, status: active ? 'running' : job.cancelled ? 'cancelled' : results.some(r => r.status !== 'completed') ? 'partial' : 'completed', results };
  }
  cancel(id: string): BatchSnapshot | undefined {
    this.prune();
    const job = this.jobs.get(id); if (!job) return undefined;
    job.cancelled = true;
    for (const record of job.records) {
      if (record.status === 'queued') { record.status = 'cancelled'; record.reason = 'Never started'; job.pending[record.index] = undefined; }
      else if (record.status === 'running') { record.status = 'unknown'; record.reason = 'Cancellation requested; remote termination not proven'; }
    }
    this.finish(job);
    return this.status(id);
  }
}
export const remoteBatchStore = new RemoteBatchStore();

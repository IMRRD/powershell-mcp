import type { SpawnSyncReturns } from 'node:child_process';

const errorCodes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EAGAIN', 'ENOMEM', 'ENOBUFS', 'ETIMEDOUT', 'UNKNOWN']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGILL', 'SIGBUS', 'SIGPIPE', 'SIGHUP']);

// Failure messages must never serialize spawnargs, exception messages, or raw
// streams: the diagnostic fixture deliberately includes sensitive-looking text.
export function supervisorSpawnDiagnostics(result: SpawnSyncReturns<string>, elapsedMs: number): string {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  let stdoutRecord = result.stdout ? 'other' : 'empty';
  try {
    const record = JSON.parse(result.stdout);
    if (record && Object.keys(record).sort().join(',') === 'event,nonce,reason'
      && record.event === 'unknown' && record.nonce === 'a'.repeat(48)
      && ['stdout_drain_failed', 'stderr_drain_failed'].includes(record.reason)) {
      stdoutRecord = record.reason;
    }
  } catch { /* Empty, partial, and non-JSON output remain distinct from proof. */ }
  return JSON.stringify({
    status: result.status,
    errorCode: !result.error ? null : code && errorCodes.has(code) ? code : 'other',
    signal: result.signal === null ? null : signals.has(result.signal) ? result.signal : 'other',
    elapsedMs: Math.round(elapsedMs),
    stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
    stderrBytes: Buffer.byteLength(result.stderr ?? ''),
    stdoutRecord,
  });
}

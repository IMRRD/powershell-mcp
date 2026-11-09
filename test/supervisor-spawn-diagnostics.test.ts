import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { supervisorSpawnDiagnostics } from './helpers/supervisor-spawn-diagnostics.js';

const record = { event: 'unknown', nonce: 'a'.repeat(48), reason: 'stdout_drain_failed' };

it('retains missing-executable evidence without serializing the command or error message', () => {
  const started = performance.now();
  const result = spawnSync(`${process.execPath}.missing-supervisor-fixture`, ['private-command'], {
    encoding: 'utf8', windowsHide: true, timeout: 1000,
  });
  expect(result.status).toBeNull();
  expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT');
  const diagnostic = JSON.parse(supervisorSpawnDiagnostics(result, performance.now() - started));
  expect(diagnostic).toEqual({
    status: null, errorCode: 'ENOENT', signal: null, elapsedMs: expect.any(Number),
    stdoutBytes: 0, stderrBytes: 0, stdoutRecord: 'empty',
  });
});

it('distinguishes emitted drain proof from process completion on a real bounded timeout', () => {
  const started = performance.now();
  const result = spawnSync(process.execPath, ['-e', `
    require('node:fs').writeSync(1, ${JSON.stringify(JSON.stringify(record))});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  `], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const diagnostic = JSON.parse(supervisorSpawnDiagnostics(result, performance.now() - started));
  expect(diagnostic).toEqual({
    status: null, errorCode: 'ETIMEDOUT', signal: 'SIGTERM', elapsedMs: expect.any(Number),
    stdoutBytes: Buffer.byteLength(JSON.stringify(record)), stderrBytes: 0, stdoutRecord: 'stdout_drain_failed',
  });
  expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(5000);
});

it('retains successful completion and only recognizes the exact drain record', () => {
  const result = spawnSync(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(record))})`],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  expect(JSON.parse(supervisorSpawnDiagnostics(result, 25))).toEqual({
    status: 0, errorCode: null, signal: null, elapsedMs: 25,
    stdoutBytes: Buffer.byteLength(JSON.stringify(record)), stderrBytes: 0, stdoutRecord: 'stdout_drain_failed',
  });
  for (const output of ['partial {', JSON.stringify({ ...record, nonce: 'b'.repeat(48) }),
    JSON.stringify({ ...record, reason: 'unrecognized' }), JSON.stringify({ ...record, extra: true })]) {
    expect(JSON.parse(supervisorSpawnDiagnostics({ ...result, stdout: output }, 25)).stdoutRecord).toBe('other');
  }
  // A null status and a deadline-sized duration alone must not invent a timeout.
  expect(JSON.parse(supervisorSpawnDiagnostics({ ...result, status: null, signal: 'SIGKILL' }, 15000)))
    .toEqual({ status: null, errorCode: null, signal: 'SIGKILL', elapsedMs: 15000,
      stdoutBytes: Buffer.byteLength(JSON.stringify(record)), stderrBytes: 0, stdoutRecord: 'stdout_drain_failed' });
});

it('withholds exception details, streams, arguments, and unrecognized metadata', () => {
  const sensitive = ['synthetic', 'private', 'fixture'].join('-');
  const result = spawnSync(process.execPath, ['-e', `
    process.stdout.write(${JSON.stringify(sensitive)});
    process.stderr.write(${JSON.stringify(sensitive)});
    process.exitCode = 7;
  `], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  const diagnostic = JSON.parse(supervisorSpawnDiagnostics(result, 12));
  expect(diagnostic).toEqual({ status: 7, errorCode: null, signal: null, elapsedMs: 12,
    stdoutBytes: Buffer.byteLength(sensitive), stderrBytes: Buffer.byteLength(sensitive), stdoutRecord: 'other' });
  // Native errors can carry the complete argument vector. None belongs in a
  // failure message, including unexpected code/signal values from a test double.
  const withError = { ...result, error: Object.assign(new Error(sensitive), { code: sensitive, spawnargs: [sensitive] }),
    signal: sensitive as NodeJS.Signals };
  expect(JSON.parse(supervisorSpawnDiagnostics(withError, 12))).toEqual({
    ...diagnostic, errorCode: 'other', signal: 'other',
  });
  expect(JSON.parse(supervisorSpawnDiagnostics({ ...withError, error: new Error(sensitive) }, 12)).errorCode).toBe('other');
});

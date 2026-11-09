import { beforeEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn());
vi.mock('../src/powershell.js', () => ({ runPowerShell: launch }));

import { runWinRm } from '../src/winrm.js';
import { executeBatchTarget } from '../src/remote-batch.js';
import { fromProcess } from '../src/result.js';
import { sanitizeCredentialResult } from '../src/credentials.js';
import type { PsResult } from '../src/powershell.js';

const target = { transport: 'winrm' as const, host: 'synthetic.invalid', command: 'synthetic command' };
const body = { status: 'completed', output: 'synthetic payload', observedBytes: 17,
  capturedBytes: 17, omittedBytes: 0, truncated: false, records: [], recordsTruncated: false };
type Mutation = { result?: Partial<PsResult>; body?: unknown; wrongFrame?: boolean };
function respond(mutation: Mutation = {}) {
  launch.mockImplementation(async (_script, options) => {
    const input = JSON.parse(Buffer.from(options.stdin, 'base64').toString());
    const frame = mutation.wrongFrame ? 'b'.repeat(48) : input.frame;
    return { stdout: `WINRM-RESULT:${frame}:${Buffer.from(JSON.stringify(mutation.body ?? body)).toString('base64')}`,
      stderr: '', exitCode: 0, durationMs: 1, shell: 'synthetic', timedOut: false, truncated: false,
      ...mutation.result };
  });
}

describe('direct and batch WinRM completion contract (local transport double)', () => {
  beforeEach(() => { launch.mockReset(); respond(); });

  it('establishes a valid frame through both callers before completion mutations', async () => {
    const direct = fromProcess(await runWinRm({ computerName: target.host, command: target.command }), 'winrm', target.host);
    const batch = await executeBatchTarget(target, 10000);
    expect(direct).toMatchObject({ stdout: body.output, terminationStatus: 'completed', terminationCertainty: 'unknown',
      exitCode: null, detail: { localExitCode: 0, winrmReason: 'completed' } });
    expect(batch).toMatchObject({ status: 'completed', output: { stdout: body.output, exitCode: 0,
      invocationStatus: 'completed', winrmReason: 'completed' } });
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['missing exit proof', { result: { exitCode: null } }, 'local_host_error', 'failed', 'transport_error'],
    ['nonzero local exit', { result: { exitCode: 7 } }, 'local_host_error', 'failed', 'transport_error'],
    ['local protocol failure', { result: { protocolError: true } }, 'local_host_error', 'failed', 'transport_error'],
    ['local launch failure', { result: { spawnError: 'synthetic failure' } }, 'local_launch_error', 'failed', 'transport_error'],
    ['cancellation', { result: { cancelled: true } }, 'cancelled', 'failed', 'cancelled'],
    ['timeout before cancellation and protocol failure', { result: { timedOut: true, cancelled: true, protocolError: true } }, 'timeout', 'timeout', 'timeout'],
    ['wrong nonce', { wrongFrame: true }, 'frame_invalid', 'failed', 'transport_error'],
    ['truncated frame', { result: { truncated: true } }, 'frame_invalid', 'failed', 'transport_error'],
    ['invalid body', { body: { status: 'completed', output: body.output } }, 'frame_body_invalid', 'failed', 'transport_error'],
  ] as const)('discards payload after %s in both callers', async (_name, mutation, reason, batchStatus, directStatus) => {
    respond(mutation);
    const decoded = sanitizeCredentialResult(await runWinRm({ computerName: target.host, command: target.command }), {});
    const direct = fromProcess(decoded, 'winrm', target.host);
    const batch = await executeBatchTarget(target, 10000);
    expect(decoded).toMatchObject({ stdout: '', invocationStatus: 'transport_error', winrmReason: reason });
    expect(decoded.stdoutCapture).toBeUndefined();
    expect(decoded.errorRecords).toBeUndefined();
    expect(decoded.log).toBeUndefined();
    expect(direct).toMatchObject({ stdout: '', exitCode: null, terminationCertainty: 'unknown',
      terminationStatus: directStatus, detail: { winrmReason: reason } });
    expect(batch).toMatchObject({ status: batchStatus, output: { stdout: '', invocationStatus: 'transport_error', winrmReason: reason } });
    expect(JSON.stringify(batch)).not.toContain(body.output);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('preserves the generic transport boundary despite cause-like diagnostic text', async () => {
    respond({ body: { status: 'transport_error', output: 'PRIVATE authentication access endpoint', reason: 'remoting_transport_exception' } });
    const direct = fromProcess(await runWinRm({ computerName: target.host, command: target.command }), 'winrm', target.host);
    const batch = await executeBatchTarget(target, 10000);
    expect(direct).toMatchObject({ terminationStatus: 'transport_error', terminationCertainty: 'unknown',
      exitCode: null, detail: { localExitCode: 0, winrmReason: 'remoting_transport_exception' } });
    expect(batch).toMatchObject({ status: 'failed', output: { invocationStatus: 'transport_error', winrmReason: 'remoting_transport_exception' } });
  });
});

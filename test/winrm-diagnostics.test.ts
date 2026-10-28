import { describe, it, expect } from 'vitest';
import { decodeWinRmResult } from '../src/winrm.js';
import { fromProcess, toolResult } from '../src/result.js';
import { instrumentTool } from '../src/tool-instrumentation.js';
import { validMetrics } from '../src/telemetry-wire.js';
import { sanitizeCredentialResult } from '../src/credentials.js';

const frame = 'a'.repeat(48);
const raw = { stdout: '', stderr: '', exitCode: 0, durationMs: 1, shell: 'synthetic', timedOut: false, truncated: false };
const encoded = (body: unknown) => ({ ...raw, stdout: `WINRM-RESULT:${frame}:${Buffer.from(JSON.stringify(body)).toString('base64')}` });
const transport = { status: 'transport_error', output: 'PRIVATE authentication access endpoint', reason: 'invoke_exception' };
describe('bounded WinRM failure boundaries', () => {
  it('carries only fixed reasons through result and exactly one recorder call', async () => {
    const result = fromProcess(decodeWinRmResult(encoded(transport), frame), 'winrm', 'PRIVATE');
    expect(result.detail.winrmReason).toBe('invoke_exception');
    const rows: unknown[][] = [];
    await instrumentTool('winrm_exec', async () => toolResult(result, 'PRIVATE'), (...r) => rows.push(r))({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['winrm_exec', 'error', expect.any(String), 'remote', 'invoke_exception']);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  });
  it('retains unknown for old frames and never infers causes from output', () => {
    const { reason, ...old } = transport;
    expect(decodeWinRmResult(encoded(old), frame).winrmReason).toBe('unknown');
  });
  it('preserves allowlisted root metadata through credential redaction while scrubbing remote text', () => {
    const decoded = decodeWinRmResult(encoded(transport), frame);
    const safe = sanitizeCredentialResult({ ...decoded, nested: { winrmReason: 'invoke_exception' } }, { password: 'invoke_exception' });
    expect(safe.winrmReason).toBe('invoke_exception');
    expect(safe.nested.winrmReason).toBe('[REDACTED]');
    expect(sanitizeCredentialResult({ winrmReason: 'PRIVATE' }, {}).winrmReason).toBe('unknown');
  });
  it('refuses payload success when the local supervisor reports protocol failure', () => {
    const body = { status: 'completed', output: 'synthetic', observedBytes: 9, capturedBytes: 9, omittedBytes: 0, truncated: false, records: [], recordsTruncated: false };
    expect(decodeWinRmResult(encoded(body), frame).invocationStatus).toBe('completed');
    const rejected = decodeWinRmResult({ ...encoded(body), protocolError: true }, frame);
    expect(rejected.invocationStatus).toBe('transport_error');
    expect(rejected.stdout).toBe('');
    expect(rejected.stdoutCapture).toBeUndefined();
  });
  it.each(['authentication', 'PRIVATE', {}, null, 'completed'])('rejects forged reason %s', reason => {
    expect(decodeWinRmResult(encoded({ ...transport, reason }), frame)).toMatchObject({ invocationStatus: 'transport_error', winrmReason: 'frame_body_invalid' });
  });
  it('keeps timeout, cancellation, local launch and local host boundaries ahead of frames', () => {
    for (const [extra, reason] of [[{ timedOut: true }, 'timeout'], [{ cancelled: true }, 'cancelled'], [{ spawnError: 'PRIVATE' }, 'local_launch_error'], [{ exitCode: 7 }, 'local_host_error'], [{ protocolError: true }, 'local_host_error']] as const) {
      const decoded = decodeWinRmResult({ ...encoded(transport), ...extra }, frame);
      expect(decoded.winrmReason).toBe(reason);
      expect(fromProcess(decoded, 'winrm', 'PRIVATE').terminationCertainty).toBe('unknown');
    }
    expect(decodeWinRmResult({ ...raw, stdout: 'PRIVATE' }, frame).winrmReason).toBe('frame_invalid');
    expect(decodeWinRmResult(encoded({}), frame).winrmReason).toBe('frame_body_invalid');
  });
  it('admits old metrics and a complete WinRM reason marginal, rejects private fields and bad totals', () => {
    const row = { outcomes: { error: 1 }, durations: { lt100: 1 }, features: { remote: 1 } };
    expect(validMetrics({ winrm_exec: row })).toBe(true);
    expect(validMetrics({ winrm_exec: { ...row, winrmReasons: { unknown: 1 } } })).toBe(true);
    for (const winrmReasons of [{ PRIVATE: 1 }, { unknown: 2 }, {}, { unknown: 0 }, { unknown: true }]) {
      expect(validMetrics({ winrm_exec: { ...row, winrmReasons } })).toBe(false);
    }
    expect(validMetrics({ ssh_exec: { ...row, winrmReasons: { unknown: 1 } } })).toBe(false);
  });
});

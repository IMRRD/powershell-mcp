import { describe, expect, it } from 'vitest';
import { decodeWinRmResult } from '../src/winrm.js';
import { OutputCollector, captureBytes } from '../src/output-collector.js';
import type { PsResult } from '../src/powershell.js';
import { logStore } from '../src/full-logs.js';

const frame = 'a'.repeat(48);
function envelope(text: string) {
  const bytes = Buffer.byteLength(text);
  return { output: text, observedBytes: bytes, capturedBytes: bytes, omittedBytes: 0, truncated: false };
}
function host(local: Buffer, remote: string, limit = 32, tail = false, stdout = ''): PsResult {
  const collector = new OutputCollector(limit, tail);
  collector.append(local);
  const stderrCapture = collector.snapshot();
  const remoteCollector = new OutputCollector(limit, tail);
  remoteCollector.append(Buffer.from(remote));
  const { text: output, ...accounting } = remoteCollector.snapshot();
  const out = new OutputCollector(limit, tail); out.append(Buffer.from(stdout));
  const { text: outText, ...outAccounting } = out.snapshot();
  const body = { output: outText, ...outAccounting, status: 'completed', records: [], recordsTruncated: false, stderr: { output, ...accounting } };
  return { stdout: `WINRM-RESULT:${frame}:${Buffer.from(JSON.stringify(body)).toString('base64')}`,
    stderr: stderrCapture.text, stderrCapture, exitCode: 0, timedOut: false,
    truncated: stderrCapture.truncated, durationMs: 1, shell: 'powershell' };
}

describe('WinRM local and remote stderr', () => {
  it.each([false, true])('does not fill an omitted Unicode boundary from the other source (tail=%s)', tail => {
    const result = decodeWinRmResult(host(Buffer.from(tail ? 'A' : '€'), tail ? '€' : 'A', 1, tail), frame, 1, tail);
    expect(result.invocationStatus).toBe('completed');
    expect(result.stderrCapture).toEqual({ text: '', observedBytes: 4, capturedBytes: 0, omittedBytes: 4, truncated: true });
  });

  const unicodeSources: [Buffer, string][] = [
    [Buffer.from('A'), '€'], [Buffer.from('€'), 'A'],
    [Buffer.from('A¢€😀Z'), '€B'], [Buffer.from('€Z'), ''],
    [Buffer.from([0xff, 0x41, 0xe2, 0x82, 0xac]), '😀B'],
    [Buffer.from([0xe2]), '€'],
  ];
  for (const [index, [local, remote]] of unicodeSources.entries()) for (const tail of [false, true]) for (const logging of [false, true]) {
    it.each([0, 1, 2, 3, 4, 5, 7])(`matches reference for both streams case=${index} tail=${tail} logging=${logging} cap=%s`, cap => {
      const quota = Math.max(1, cap), budget = logging ? quota : cap;
      const result = decodeWinRmResult(host(local, remote, budget, tail, '€Z'), frame, cap, tail, logging, quota);
      const stderr = new OutputCollector(cap, tail); stderr.append(local); stderr.append(Buffer.from(remote));
      const stdout = new OutputCollector(cap, tail); stdout.append(Buffer.from('€Z'));
      try {
        expect(result.invocationStatus).toBe('completed');
        expect(result.stderrCapture).toEqual(stderr.snapshot());
        expect(result.stdoutCapture).toEqual(stdout.snapshot());
        expect(result.stderr).toBe(stderr.snapshot().text);
        expect(result.stdout).toBe(stdout.snapshot().text);
        if (logging) {
          const fullErr = new OutputCollector(budget, tail); fullErr.append(local); fullErr.append(Buffer.from(remote));
          const fullOut = new OutputCollector(budget, tail); fullOut.append(Buffer.from('€Z'));
          const outBytes = captureBytes(fullOut.snapshot()).subarray(0, quota);
          const errBytes = captureBytes(fullErr.snapshot()).subarray(0, quota - outBytes.length);
          expect(result.log).toMatchObject({ stdoutBytes: outBytes.length, stderrBytes: errBytes.length,
            complete: !fullOut.snapshot().truncated && !fullErr.snapshot().truncated &&
              fullOut.snapshot().capturedBytes + fullErr.snapshot().capturedBytes <= quota });
          for (const [stream, expected] of [['stdout', outBytes], ['stderr', errBytes]] as const)
            expect(Buffer.from(logStore.read(result.log!.handle, stream, 0, 32).data, 'base64')).toEqual(expected);
        }
      } finally { if (result.log) logStore.delete(result.log.handle); }
    });
  }

  it('preserves LOCAL host stderr (5 bytes) plus REMOTE envelope stderr (6 bytes)', () => {
    const result = decodeWinRmResult(host(Buffer.from('LOCAL'), 'REMOTE'), frame, 32);
    expect(result.stderrCapture).toEqual({ text: 'LOCALREMOTE', observedBytes: 11, capturedBytes: 11, omittedBytes: 0, truncated: false });
    expect(result.stderr).toBe('LOCALREMOTE');
  });

  it.each([false, true])('caps retained local stderr on timeout before decoding/logging (tail=%s)', tail => {
    const raw = { ...host(Buffer.from('LOCALx'), 'REMOTE'), timedOut: true };
    const result = decodeWinRmResult(raw, frame, 1, tail, true, 32);
    expect(result.stderrCapture).toEqual({ text: tail ? 'x' : 'L', observedBytes: 6, capturedBytes: 1, omittedBytes: 5, truncated: true });
    expect(result.log).toBeUndefined();
    expect(result.invocationStatus).toBe('transport_error');
  });

  for (const remote of ['', 'REMOTE']) for (const tail of [false, true]) for (const cap of [0, 1, 3, 5, 11]) for (const logging of [false, true]) {
    it(`retains local plus remote=${remote} cap=${cap} tail=${tail} logging=${logging}`, () => {
      const text = 'LOCAL' + remote;
      const result = decodeWinRmResult(host(Buffer.from('LOCAL'), remote, logging ? 32 : cap, tail), frame, cap, tail, logging, 32);
      const retained = cap === 0 ? '' : tail ? text.slice(-cap) : text.slice(0, cap);
      try {
        expect(result.invocationStatus).toBe('completed');
        expect(result.stderrCapture).toEqual({ text: retained, observedBytes: text.length, capturedBytes: retained.length,
          omittedBytes: text.length - retained.length, truncated: text.length > retained.length });
        expect(result.stderr).toBe(retained);
        expect(result.truncated).toBe(text.length > retained.length);
        if (logging) {
          expect(result.log).toMatchObject({ complete: true, stdoutBytes: 0, stderrBytes: text.length });
          expect(Buffer.from(logStore.read(result.log!.handle, 'stderr', 0, 32).data, 'base64').toString()).toBe(text);
        }
      } finally { if (result.log) logStore.delete(result.log.handle); }
    });
  }

  it.each([false, true])('preserves original malformed local bytes in display accounting and protected readback (tail=%s)', tail => {
    const local = Buffer.from([0xff, 0x41]);
    const result = decodeWinRmResult(host(local, '€Z'), frame, 3, tail, true, 32);
    try {
      expect(result.stderrCapture).toEqual({ text: tail ? 'Z' : '�A', observedBytes: 6, capturedBytes: tail ? 1 : 2,
        omittedBytes: tail ? 5 : 4, truncated: true });
      expect(result.log).toMatchObject({ complete: true, stderrBytes: 6 });
      expect(Buffer.from(logStore.read(result.log!.handle, 'stderr', 0, 32).data, 'base64')).toEqual(Buffer.concat([local, Buffer.from('€Z')]));
    } finally { if (result.log) logStore.delete(result.log.handle); }
  });

  it.each([false, true])('counts upstream omissions from both streams (tail=%s)', tail => {
    const raw = host(Buffer.from('LOCAL'), 'REMOTE', 2, tail);
    const body = { ...envelope(''), status: 'completed', records: [], recordsTruncated: false,
      stderr: { output: tail ? 'TE' : 'RE', observedBytes: 6, capturedBytes: 2, omittedBytes: 4, truncated: true } };
    raw.stdout = `WINRM-RESULT:${frame}:${Buffer.from(JSON.stringify(body)).toString('base64')}`;
    const result = decodeWinRmResult(raw, frame, 2, tail, true, 2);
    try {
      expect(result.stderrCapture).toEqual({ text: tail ? 'TE' : 'LO', observedBytes: 11, capturedBytes: 2, omittedBytes: 9, truncated: true });
      expect(result.log).toMatchObject({ complete: false, stderrBytes: 2 });
      expect(Buffer.from(logStore.read(result.log!.handle, 'stderr', 0, 32).data, 'base64').toString()).toBe(tail ? 'TE' : 'LO');
    } finally { if (result.log) logStore.delete(result.log.handle); }
  });

  it('enforces the shared stdout/stderr log quota without reducing display', () => {
    const raw = host(Buffer.from('LOCAL'), 'REMOTE');
    const body = { ...envelope('OUT'), status: 'completed', records: [], recordsTruncated: false, stderr: envelope('REMOTE') };
    raw.stdout = `WINRM-RESULT:${frame}:${Buffer.from(JSON.stringify(body)).toString('base64')}`;
    const result = decodeWinRmResult(raw, frame, 16, false, true, 7);
    try {
      expect(result.stderr).toBe('LOCALREMOTE');
      expect(result.stderrCapture).toMatchObject({ observedBytes: 11, capturedBytes: 11, omittedBytes: 0, truncated: false });
      expect(result.log).toMatchObject({ complete: false, stdoutBytes: 3, stderrBytes: 4 });
      expect(Buffer.from(logStore.read(result.log!.handle, 'stdout', 0, 32).data, 'base64').toString()).toBe('OUT');
      expect(Buffer.from(logStore.read(result.log!.handle, 'stderr', 0, 32).data, 'base64').toString()).toBe('LOCA');
    } finally { if (result.log) logStore.delete(result.log.handle); }
  });
});

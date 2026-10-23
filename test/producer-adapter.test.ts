import { describe, expect, it, vi } from 'vitest';
import { selectIntegrationEngines } from './integration-engine.js';
import { fromProcess } from '../src/result.js';
import { logStore } from '../src/full-logs.js';
import { frameLimit } from '../src/envelope-output.js';

// Keep production input construction, random framing, reservation, launch options
// and decoding. Replace only Invoke-Command with an in-process local fixture.
vi.mock('../src/powershell.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/powershell.js')>();
  return { ...actual, runPowerShell: vi.fn((script, opts) => actual.runPowerShell(
    'function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$ErrorAction) if ($env:MCP_TEST_LOCAL_STDERR) { [Console]::Error.Write($env:MCP_TEST_LOCAL_STDERR) }; & $ScriptBlock @ArgumentList };\n' + script,
    { ...opts, exe: engine?.exe },
  )) };
});
import { runPowerShell } from '../src/powershell.js';
import { runWinRm, WINRM_BOOTSTRAP } from '../src/winrm.js';

const engine = selectIntegrationEngines()[0];
describe.skipIf(!engine)('production WinRM adapter with local invocation', () => {
  it.each(['', 'REMOTE'])('preserves host stderr alongside remote stderr=%s through protected logging', async remote => {
    vi.stubEnv('MCP_TEST_LOCAL_STDERR', 'LOCAL');
    let result;
    try {
      result = await runWinRm({ computerName: 'local-double', command: `[Console]::Error.Write('${remote}')`, maxOutputBytes: 1, logOutput: true, logQuotaBytes: 32 });
      expect(result).toMatchObject({ invocationStatus: 'completed', stderr: 'L',
        stderrCapture: { observedBytes: 5 + remote.length, capturedBytes: 1, omittedBytes: 4 + remote.length, truncated: true },
        log: { complete: true, stderrBytes: 5 + remote.length } });
      expect(vi.mocked(runPowerShell).mock.calls.at(-1)![1].stderrLimitBytes).toBe(32);
      expect(Buffer.from(logStore.read(result.log!.handle, 'stderr', 0, 32).data, 'base64').toString()).toBe('LOCAL' + remote);
    } finally { vi.unstubAllEnvs(); if (result?.log) logStore.delete(result.log.handle); }
  }, 15000);

  it('passes remote retention limits before serialization and preserves both streams through logging', async () => {
    const result = await runWinRm({ computerName: 'local-double', command: "[Console]::Out.Write('abcdef'); [Console]::Error.Write('uvwxyz')", maxOutputBytes: 2, tail: true, logOutput: true, logQuotaBytes: 32 });
    try {
      expect(result).toMatchObject({ invocationStatus: 'completed', stdout: 'ef', stderr: 'yz',
        stdoutCapture: { observedBytes: 6, capturedBytes: 2, omittedBytes: 4 },
        stderrCapture: { observedBytes: 6, capturedBytes: 2, omittedBytes: 4 },
        log: { complete: true, stdoutBytes: 6, stderrBytes: 6 } });
      const [script, options] = vi.mocked(runPowerShell).mock.calls.at(-1)!;
      expect(script).toBe(WINRM_BOOTSTRAP);
      expect(options.maxOutputBytes).toBe(frameLimit(64));
      const input = JSON.parse(Buffer.from(options.stdin!, 'base64').toString());
      expect(input).toMatchObject({ outputLimit: 32, outputTail: true });
      expect(logStore.read(result.log!.handle, 'stderr', 0, 32).data).toBe('dXZ3eHl6');
    } finally { if (result.log) logStore.delete(result.log.handle); }
  }, 15000);

  it.each(['timeout', 'cancel'])('%s releases framed log reservations and cannot report completion', async kind => {
    const controller = new AbortController();
    const timer = kind === 'cancel' ? setTimeout(() => controller.abort(), 1500) : undefined;
    try {
      const result = await runWinRm({ computerName: 'local-double', command: "'prefix'; Start-Sleep -Seconds 20", timeoutMs: kind === 'timeout' ? 1500 : 15000, signal: controller.signal, logOutput: true });
      expect(fromProcess(result, 'winrm', 'local-double').terminationStatus).toBe(kind === 'timeout' ? 'timeout' : 'cancelled');
      expect(result.stdoutCapture).toBeUndefined();
      expect(result.log).toBeUndefined();
      const held: ReturnType<typeof logStore.create>[] = [];
      try { for (let i = 0; i < 8; i++) held.push(logStore.create()); }
      finally { for (const log of held) logStore.delete(log.finish().handle); }
    } finally { clearTimeout(timer); }
  }, 20000);
});

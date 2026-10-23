import { describe, expect, it } from 'vitest';
import { selectIntegrationEngines } from './integration-engine.js';
import { runPowerShell } from '../src/powershell.js';
import { buildWinRmInput, WINRM_BOOTSTRAP, decodeWinRmResult } from '../src/winrm.js';
import { logStore } from '../src/full-logs.js';
import { fromProcess } from '../src/result.js';
import { EOL } from 'node:os';

const prefix = 'function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$ErrorAction) & $ScriptBlock @ArgumentList };\n';
async function remote(exe: string, command: string, cap: number, tail: boolean, logging = false, quota = 8) {
  const frame = 'a'.repeat(48);
  const input = JSON.parse(Buffer.from(buildWinRmInput({ computerName: 'local-double', command, maxOutputBytes: cap, tail, logOutput: logging, logQuotaBytes: quota }), 'base64').toString());
  input.frame = frame;
  const raw = await runPowerShell(prefix + WINRM_BOOTSTRAP, { exe, stdin: Buffer.from(JSON.stringify(input)).toString('base64'), maxOutputBytes: 100000, timeoutMs: 60000 });
  return decodeWinRmResult(raw, frame, cap, tail, logging, quota);
}

// Exercise the actual producer, including direct console writes that must never
// be mistaken for transport framing. No remote connection is made.
for (const { exe } of selectIntegrationEngines()) describe(`bounded producers (${exe})`, () => {
  it.each(['strict', 'winrm'])('%s drains sustained simultaneous console/pipeline output', async kind => {
    // C# workers write both console streams while PowerShell emits pipeline items.
    const command = `Add-Type -TypeDefinition @'
using System;
using System.Threading;
public class ProducerFixture {
  public static Thread Start(bool error) {
    var t = new Thread(() => { string s = new string('x', 1024); for(int i=0;i<4096;i++) { if(error) Console.Error.Write(s); else Console.Out.Write(s); } });
    t.Start(); return t;
  }
}
'@
$a = [ProducerFixture]::Start($false); $b = [ProducerFixture]::Start($true)
$s = 'x' * 1024; 1..4096 | ForEach-Object { Write-Output $s }; $a.Join(); $b.Join(); 'END'`;
    let result;
    if (kind === 'strict') result = await runPowerShell(command, { exe, errorPolicy: 'strict', maxOutputBytes: 7, tail: true, timeoutMs: 60000 });
    else {
      const frame = 'a'.repeat(48);
      const input = JSON.parse(Buffer.from(buildWinRmInput({ computerName: 'local-double', command, maxOutputBytes: 7, tail: true }), 'base64').toString());
      input.frame = frame;
      const raw = await runPowerShell('function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$ErrorAction) & $ScriptBlock @ArgumentList };\n' + WINRM_BOOTSTRAP,
        { exe, stdin: Buffer.from(JSON.stringify(input)).toString('base64'), maxOutputBytes: 100000, timeoutMs: 60000 });
      result = decodeWinRmResult(raw, frame, 7, true);
    }
    expect(result.protocolError).toBeUndefined();
    expect(result.invocationStatus ?? (result.scriptError ? 'error' : 'completed')).toBe('completed');
    expect(result.stdout).toContain('END');
    expect(result.stdoutCapture?.observedBytes).toBeGreaterThan(8_000_000);
    expect(result.stdoutCapture?.capturedBytes).toBeLessThanOrEqual(7);
    expect(result.stderrCapture?.observedBytes).toBe(4194304);
  }, 90000);

  it.each(['strict', 'winrm'])('%s counts Unicode and honors zero, tiny, exact and head/tail caps', async kind => {
    const text = `A😀éZ${EOL}`;
    for (const tail of [false, true]) for (const cap of [0, 1, 3, 5, Buffer.byteLength(text)]) {
      const result = kind === 'strict'
        ? await runPowerShell("'A😀éZ'", { exe, errorPolicy: 'strict', maxOutputBytes: cap, tail })
        : await remote(exe, "'A😀éZ'", cap, tail);
      expect(result.protocolError).toBeUndefined();
      expect(result.invocationStatus ?? 'completed').toBe('completed');
      const c = result.stdoutCapture!;
      expect(c.observedBytes).toBe(Buffer.byteLength(text));
      expect(c.capturedBytes).toBe(Buffer.byteLength(result.stdout));
      expect(c.capturedBytes).toBeLessThanOrEqual(cap);
      expect(c.capturedBytes + c.omittedBytes).toBe(c.observedBytes);
      expect(result.stdout).not.toContain('�');
      if (tail) expect(text.endsWith(result.stdout)).toBe(true);
      else expect(text.startsWith(result.stdout)).toBe(true);
    }
  }, 90000);

  it('keeps a display larger than its log quota and bounds remote stderr logging', async () => {
    for (const kind of ['strict', 'winrm']) {
      const result = kind === 'strict'
        ? await runPowerShell("'abcdefghij'", { exe, errorPolicy: 'strict', maxOutputBytes: 10, logOutput: true, logQuotaBytes: 2 })
        : await remote(exe, "[Console]::Error.Write('diagnostic'); 'abcdefghij'", 10, false, true, 2);
      try {
        expect(result.stdout).toBe('abcdefghij');
        expect(result.log).toMatchObject({ complete: false, stdoutBytes: 2, stderrBytes: 0 });
        expect(logStore.read(result.log!.handle, 'stdout', 0, 10).data).toBe('YWI=');
      } finally { if (result.log) logStore.delete(result.log.handle); }
    }
    const result = await remote(exe, "[Console]::Error.Write('é'); 'ok'", 10, false, true, 16);
    try {
      expect(result.stderrCapture).toMatchObject({ observedBytes: 2, capturedBytes: 2, omittedBytes: 0 });
      expect(result.log).toMatchObject({ complete: true, stderrBytes: 2 });
      expect(logStore.read(result.log!.handle, 'stderr', 0, 10).data).toBe('w6k=');
    } finally { if (result.log) logStore.delete(result.log.handle); }
  }, 30000);

  it('bounds error summaries while continuing to drain', async () => {
    const result = await runPowerShell("1..2000 | ForEach-Object { Write-Error ('bad' * 1000) -ErrorAction Continue }; 'END'", { exe, errorPolicy: 'strict', maxOutputBytes: 7, tail: true });
    expect(result.scriptError).toBe(true);
    expect(result.stdout).toContain('END');
    expect(result.errorRecords).toHaveLength(8);
    expect(result.errorRecordsTruncated).toBe(true);
  }, 30000);

  it.each(['strict', 'winrm'])('%s does not retain a sustained 64 MiB pipeline', async kind => {
    const command = "$before = [GC]::GetTotalMemory($true); $s = 'x' * 8192; 1..8192 | ForEach-Object { [string]$_ + $s }; 'LIVE_BYTES:' + ([GC]::GetTotalMemory($true) - $before)";
    const result = kind === 'strict'
      ? await runPowerShell(command, { exe, errorPolicy: 'strict', maxOutputBytes: 64, tail: true, timeoutMs: 60000 })
      : await remote(exe, command, 64, true);
    expect(result.stdoutCapture?.observedBytes).toBeGreaterThan(64 * 1024 * 1024);
    const live = result.stdout.match(/LIVE_BYTES:(-?\d+)/);
    expect(live, result.stderr).not.toBeNull();
    expect(Number(live![1])).toBeLessThan(16 * 1024 * 1024);
  }, 90000);

  it('encodes surrogate pairs split across writes and preserves raw OS stderr byte counts', async () => {
    const result = await runPowerShell("[Console]::Out.Write([char]0xd83d); [Console]::Out.Write([char]0xde00); $raw = [Console]::OpenStandardError(); $raw.Write([byte[]]@(255,97),0,2)", { exe, errorPolicy: 'strict', maxOutputBytes: 4 });
    expect(result.stdout).toBe('😀');
    expect(result.stdoutCapture).toMatchObject({ observedBytes: 4, capturedBytes: 4 });
    expect(result.stderr).toBe('�a');
    expect(result.stderrCapture).toMatchObject({ observedBytes: 2, capturedBytes: 2 });
  });

  it.each(['timeout', 'cancel'])('%s fails closed and releases strict log reservations', async reason => {
    const controller = new AbortController();
    const timer = reason === 'cancel' ? setTimeout(() => controller.abort(), 1500) : undefined;
    try {
      const result = await runPowerShell("'prefix'; Start-Sleep -Seconds 20", { exe, errorPolicy: 'strict', maxOutputBytes: 2, timeoutMs: reason === 'timeout' ? 1500 : 15000, signal: controller.signal, logOutput: true });
      expect(fromProcess(result, 'powershell', 'local').terminationStatus).toBe(reason === 'timeout' ? 'timeout' : 'cancelled');
      expect(result.stdoutCapture).toBeUndefined(); // No terminal frame: no invented producer counts.
      expect(result.log).toBeUndefined();
      const held: ReturnType<typeof logStore.create>[] = [];
      try { for (let i = 0; i < 8; i++) held.push(logStore.create()); }
      finally { for (const log of held) logStore.delete(log.finish().handle); }
    } finally { clearTimeout(timer); }
  }, 20000);
});

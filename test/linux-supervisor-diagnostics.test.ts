import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const assembly = fileURLToPath(new URL('../dist/linux-supervisor.dll', import.meta.url));
it('treats only ESRCH proc read races as disappeared processes and keeps other inspection failures closed', () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -Path $env:MCP_TEST_SUPERVISOR
    $flags = [Reflection.BindingFlags]'NonPublic,Static'
    $map = [LinuxJob].GetMethod('ProcFailure',$flags)
    if (!$map) { throw 'Missing proc read race handling' }
    $vanished = $map.Invoke($null,@([IO.IOException]::new('SECRET /proc/path',3)))
    if ($vanished -isnot [IO.FileNotFoundException]) { throw 'ESRCH was not recognized' }
    foreach ($failure in @(
      [IO.IOException]::new('SECRET access denied',13),
      [IO.IOException]::new('SECRET I/O failure',5),
      [IO.IOException]::new('SECRET generic failure'),
      [UnauthorizedAccessException]::new('SECRET permission'),
      [FormatException]::new('SECRET malformed stat')
    )) {
      $mapped = $map.Invoke($null,@($failure))
      if ($mapped.GetType().GetField('Reason').GetValue($mapped) -ne 'proc_inspection_failed') { throw 'Inspection guard lost' }
    }
    [Console]::WriteLine('ESRCH vanished; other inspection failures remain unknown')
  `], { env: { ...process.env, MCP_TEST_SUPERVISOR: assembly }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('ESRCH vanished; other inspection failures remain unknown');
  expect(result.stdout).not.toContain('SECRET');
});
// Exercise the shipped assembly on Windows too. Only synthetic failures; no
// Linux emulation or changes to supervisor admission/termination behavior.
for (const stream of ['stdout', 'stderr']) it(`emits a fixed ${stream} drain reason without exception details`, () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -Path $env:MCP_TEST_SUPERVISOR
    Add-Type -TypeDefinition 'public class SecretStream : System.IO.MemoryStream { public override int Read(byte[] b,int o,int n) { throw new System.Exception("SECRET /private/path command credentials"); } }'
    $flags = [Reflection.BindingFlags]'NonPublic,Static'
    [LinuxJob].GetField('nonce',$flags).SetValue($null,('a'*48))
    $thread = [LinuxJob].GetMethod('Drain',$flags).Invoke($null,@([SecretStream]::new(),'${stream}'))
    if (!$thread.Join(5000)) { throw 'Test drain thread did not finish' }
  `], { env: { ...process.env, MCP_TEST_SUPERVISOR: assembly }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ event: 'unknown', nonce: 'a'.repeat(48), reason: `${stream}_drain_failed` });
  expect(result.stdout).not.toContain('SECRET');
});

it.skipIf(process.platform !== 'win32')('keeps unexpected supervisor exceptions unknown without leaking the command', () => {
  // libc admission fails on Windows, before any command can launch.
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -Path $env:MCP_TEST_SUPERVISOR
    [LinuxJob]::Run('SECRET command',@('SECRET argument'),'SECRET cwd','',('a'*48))
  `], { env: { ...process.env, MCP_TEST_SUPERVISOR: assembly }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual({ event: 'unknown', nonce: 'a'.repeat(48), reason: 'supervisor_exception' });
});

it.skipIf(process.platform !== 'win32')('labels failed proc enumeration while preserving disappeared-process exceptions', () => {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -Path $env:MCP_TEST_SUPERVISOR
    $flags = [Reflection.BindingFlags]'NonPublic,Static'
    try { [LinuxJob].GetMethod('Children',$flags).Invoke($null,@()); throw 'Expected missing proc' }
    catch { $cause = $_.Exception.GetBaseException(); $reason = $cause.GetType().GetField('Reason').GetValue($cause); if (!$reason) { throw }; [Console]::WriteLine($reason) }
    try { [LinuxJob].GetMethod('Parent',$flags).Invoke($null,@([int]2147483647)); throw 'Expected vanished process' }
    catch { $cause = $_.Exception.GetBaseException(); if ($cause -isnot [IO.DirectoryNotFoundException] -and $cause -isnot [IO.FileNotFoundException]) { throw } }
  `], { env: { ...process.env, MCP_TEST_SUPERVISOR: assembly }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('proc_inspection_failed');
});

it('requires repeated Linux completion in CI and retains failing test evidence', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
  const gate = readFileSync(new URL('../scripts/check-test-report.mjs', import.meta.url), 'utf8');
  expect(workflow).toContain('node-version: 20');
  expect(workflow).toContain('os: ubuntu-latest\n            engine: pwsh');
  expect(workflow).toContain('node scripts/check-test-report.mjs vitest-report.json');
  expect(gate).toContain('/linux-supervisor-eof.test.ts');
  expect(gate).toContain("t.status === 'passed'");
  expect(workflow).toMatch(/if: failure\(\)\s+uses: actions\/upload-artifact@v4/);
  expect(workflow).toContain('path: vitest-report.json');
});

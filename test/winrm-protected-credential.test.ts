import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectIntegrationEngines } from './integration-engine.js';

const transport = vi.hoisted(() => ({ exe: '', prefix: '', suffix: '', cleanupFault: false, patch: undefined as ((p: any) => void) | undefined, calls: [] as any[], raw: [] as any[] }));
vi.mock('../src/powershell.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/powershell.js')>();
  return { ...actual, runPowerShell: async (script: string, opts: any) => {
    // Keep completions attached to the fixture that launched them, even after
    // a test deadline causes teardown to replace the shared recording arrays.
    const records = transport.raw;
    transport.calls.push({ script, opts });
    if (transport.cleanupFault) script = script.replace('try { $item.Password.Dispose() }', "try { $item.Password.Dispose(); throw 'synthetic cleanup fault' }");
    if (transport.patch) { const payload = JSON.parse(Buffer.from(opts.stdin, 'base64').toString()); transport.patch(payload); opts = { ...opts, stdin: Buffer.from(JSON.stringify(payload)).toString('base64') }; }
    // Only the remoting boundary is local: execute the real adapter and bootstrap.
    const raw = await actual.runPowerShell(transport.prefix + script.replaceAll('Microsoft.PowerShell.Core\\Invoke-Command', 'Invoke-Command') + transport.suffix, { ...opts, exe: transport.exe });
    records.push(raw); return raw;
  } };
});
import { configuredProvider, resolveCredential } from '../src/credentials.js';
import { runWinRm } from '../src/winrm.js';
import { executeBatchTarget } from '../src/remote-batch.js';
import { logStore } from '../src/full-logs.js';
import { runPowerShell } from '../src/powershell.js';

const scope = { transport: 'winrm' as const, host: 'synthetic.invalid', port: 5985, principal: 'SYNTHETIC\\robot' };
const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); transport.calls = []; transport.raw = []; transport.patch = undefined; transport.cleanupFault = false; transport.prefix = ''; transport.suffix = ''; for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mcp-protected-test-')); directories.push(directory);
  const path = join(directory, 'loader.ps1');
  // The password is created only in PowerShell, never returned to Node.
  writeFileSync(path, "$s = New-Object Security.SecureString; $s.AppendChar([char]97); $s.MakeReadOnly(); $global:testCredential = [pscredential]::new('SYNTHETIC\\robot', $s); $global:testCredential");
  const entry = { ...scope, loaderPath: path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
  const map = join(directory, 'map.json'); writeFileSync(map, JSON.stringify({ robot: entry }));
  vi.stubEnv('POWERSHELL_MCP_WINRM_CREDENTIAL_MAP', map);
  vi.stubEnv('POWERSHELL_MCP_WINRM_CREDENTIAL_MAP_SHA256', createHash('sha256').update(readFileSync(map)).digest('hex'));
  return { directory, path, entry, map };
}
async function auth() { return resolveCredential({ ...scope, username: scope.principal, credentialRef: 'robot' }, configuredProvider()); }
function replaceLoader(f: ReturnType<typeof fixture>, source: string) {
  writeFileSync(f.path, source); f.entry.sha256 = createHash('sha256').update(readFileSync(f.path)).digest('hex');
  writeFileSync(f.map, JSON.stringify({ robot: f.entry }));
  vi.stubEnv('POWERSHELL_MCP_WINRM_CREDENTIAL_MAP_SHA256', createHash('sha256').update(readFileSync(f.map)).digest('hex'));
}
const target = { transport: 'winrm' as const, host: scope.host, username: scope.principal, credentialRef: 'robot', command: "'synthetic ok'", authentication: 'Kerberos' as const };
async function direct(command = target.command, extra = {}) { return runWinRm({ computerName: scope.host, username: scope.principal, ...await auth(), command, authentication: 'Kerberos', ...extra }); }
function observe(f: ReturnType<typeof fixture>, body = '& $ScriptBlock @ArgumentList') {
  const invoked = join(f.directory, 'invoked').replaceAll("'", "''"), disposed = join(f.directory, 'disposed').replaceAll("'", "''");
  transport.prefix = `function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$Credential,$Authentication,$ErrorAction) [IO.File]::WriteAllText('${invoked}', 'invoked'); ${body} }\n`;
  transport.suffix = `\nif ($null -ne $global:testCredential) { try { $global:testCredential.Password.Copy().Dispose() } catch { [IO.File]::WriteAllText('${disposed}', 'disposed') } }`;
}

describe.skipIf(process.platform !== 'win32')('operator mapped protected WinRM reference', () => {
  it('resolves metadata without reading the loader or a plaintext credential into Node', async () => {
    const f = fixture();
    const value = await auth();
    expect(value).toEqual({ protectedCredential: f.entry });
    expect(transport.calls).toHaveLength(0);
    expect(JSON.stringify(value)).not.toContain('password');
  });
  it.each([{ host: 'other.invalid' }, { port: 5986 }, { principal: 'other' }, { transport: 'ssh' as const }])('rejects exact scope mismatch %j', async change => {
    fixture();
    await expect(resolveCredential({ ...scope, ...change, credentialRef: 'robot' }, configuredProvider())).rejects.toThrow(/scope|unavailable/i);
    expect(transport.calls).toHaveLength(0);
  });
  it('rejects mixed auth and invalid references before reading operator configuration', async () => {
    fixture();
    for (const change of [{ password: 'raw' }, { passphrase: 'raw' }, { privateKeyPath: 'raw' }]) await expect(resolveCredential({ ...scope, credentialRef: 'robot', ...change }, configuredProvider())).rejects.toThrow(/mixed/i);
    await expect(resolveCredential({ ...scope, credentialRef: '../robot' }, configuredProvider())).rejects.toThrow(/invalid/i);
    expect(transport.calls).toHaveLength(0);
  });
  it('refuses an unpinned or tampered operator map without falling back', async () => {
    fixture();
    for (const pin of ['', '0'.repeat(64)]) {
      vi.stubEnv('POWERSHELL_MCP_WINRM_CREDENTIAL_MAP_SHA256', pin);
      await expect(auth()).rejects.toThrow('Credential reference unavailable');
    }
    expect(transport.calls).toHaveLength(0);
  });
  it.each([{}, { robot: { ...scope, loaderPath: '../caller.ps1', sha256: '0'.repeat(64) } }, { robot: { ...scope, loaderPath: 'C:/loader.ps1', sha256: 'invalid' } }])('fails closed on absent or invalid map entry %#', async map => {
    const f = fixture(); writeFileSync(f.map, JSON.stringify(map));
    vi.stubEnv('POWERSHELL_MCP_WINRM_CREDENTIAL_MAP_SHA256', createHash('sha256').update(readFileSync(f.map)).digest('hex'));
    await expect(auth()).rejects.toThrow('Credential reference unavailable');
    expect(transport.calls).toHaveLength(0);
  });
});

for (const engine of process.platform === 'win32' ? selectIntegrationEngines() : []) describe(`protected adapter (${engine.exe})`, () => {
  it('keeps a late transport result in its original fixture recording', async () => {
    transport.exe = engine.exe;
    const original = transport.raw;
    const pending = runPowerShell("'synthetic late result'", { timeoutMs: 15000 });
    transport.raw = [];
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('synthetic late result');
    expect(transport.raw).toEqual([]);
    expect(original).toEqual([result]);
  });
  it.each(['direct', 'batch'] as const)('binds the PSCredential on %s calls and disposes it', async mode => {
    const createLog = vi.spyOn(logStore, 'create');
    const f = fixture(); transport.exe = engine.exe;
    const marker = join(f.directory, 'disposed').replaceAll("'", "''");
    transport.prefix = `function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$Credential,$Authentication,$ErrorAction)
      if ($Credential -isnot [pscredential] -or $Credential.UserName -cne 'SYNTHETIC\\robot' -or $Credential.Password.Length -ne 1 -or $Authentication -cne 'Kerberos') { throw 'binding failed' }
      & $ScriptBlock @ArgumentList
    }
    `;
    transport.suffix = `\ntry { $global:testCredential.Password.Copy().Dispose() } catch { [IO.File]::WriteAllText('${marker}', 'disposed') }`;
    if (mode === 'direct') {
      const result = await runWinRm({ computerName: scope.host, command: "'synthetic ok'", username: scope.principal, ...await auth(), authentication: 'Kerberos', logOutput: true, timeoutMs: 15000 });
      expect(result, result.stderr).toMatchObject({ invocationStatus: 'completed', exitCode: 0 });
      expect(result.stdout.trim()).toBe('synthetic ok');
      expect(result.log).toBeUndefined();
    } else {
      const batch = await executeBatchTarget({ transport: 'winrm', host: scope.host, command: "'synthetic ok'", username: scope.principal, credentialRef: 'robot', authentication: 'Kerberos' }, 15000);
      expect(batch).toMatchObject({ status: 'completed', output: { invocationStatus: 'completed' } });
      expect((batch.output as any).stdout.trim()).toBe('synthetic ok');
    }
    expect(readFileSync(join(f.directory, 'disposed'), 'utf8')).toBe('disposed');
    for (const { script, opts } of transport.calls) {
      expect(script).not.toContain(f.path);
      expect(opts.env).toBeUndefined();
      const payload = JSON.parse(Buffer.from(opts.stdin, 'base64').toString());
      expect(payload.password).toBeUndefined();
      expect(payload.protectedCredential).toEqual(f.entry);
    }
    expect(createLog).not.toHaveBeenCalled();
  });
  it('redacts a one-character secret and both base64 forms before Node receives the frame', async () => {
    fixture(); transport.exe = engine.exe;
    transport.prefix = `function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$Credential,$Authentication,$ErrorAction) & $ScriptBlock @ArgumentList }\n`;
    const result = await runWinRm({ computerName: scope.host, command: "[Console]::Error.Write('a YQ== YQA='); 'a YQ== YQA='; Write-Error 'a YQ== YQA='", username: scope.principal, ...await auth(), maxOutputBytes: 1024 });
    expect(result, result.stderr).toMatchObject({ invocationStatus: 'remote_error', winrmReason: 'remote_script_error' });
    expect(result.stdout).toContain('[REDACTED] [REDACTED] [REDACTED]');
    expect(result.stderr).toBe('[REDACTED] [REDACTED] [REDACTED]');
    for (const record of result.errorRecords ?? []) for (const text of Object.values(record)) expect(text).not.toContain('YQA=');
    expect(result.log).toBeUndefined();
    const batch = await executeBatchTarget({ ...target, command: "'a YQ== YQA='; Write-Error 'a YQ== YQA='" }, 15000);
    expect(batch).toMatchObject({ status: 'failed', output: { invocationStatus: 'remote_error' } });
    for (const raw of transport.raw) {
      const body = JSON.parse(Buffer.from(raw.stdout.trim().split(':').at(-1), 'base64').toString());
      expect(body.output).not.toContain('a'); expect(body.output).not.toContain('YQ=='); expect(body.output).not.toContain('YQA=');
      expect(raw.stderr).toBe('');
    }
  });
  it.each(['pin', 'type', 'principal', 'throw-after-output', 'disposed'])('refuses loader %s and never dispatches', async failure => {
    const f = fixture(); transport.exe = engine.exe; observe(f);
    if (failure === 'pin') writeFileSync(f.path, "throw 'changed loader must not execute'");
    if (failure === 'type') replaceLoader(f, "'unexpected output'");
    if (failure === 'principal') replaceLoader(f, readFileSync(f.path, 'utf8').replace('SYNTHETIC\\robot', 'SYNTHETIC\\other'));
    if (failure === 'throw-after-output') replaceLoader(f, readFileSync(f.path, 'utf8') + "; throw 'secret-bearing loader failure'");
    if (failure === 'disposed') replaceLoader(f, readFileSync(f.path, 'utf8') + '; $global:testCredential.Password.Dispose()');
    const results = [await direct(), (await executeBatchTarget(target, 15000)).output as any];
    expect(existsSync(join(f.directory, 'invoked'))).toBe(false);
    for (const result of results) {
      expect(result).toMatchObject({ invocationStatus: 'transport_error', winrmReason: 'invoke_exception', stdout: '' });
      expect(result.stderr).toBe('Protected credential unavailable'); expect(result.log).toBeUndefined();
    }
    expect(existsSync(join(f.directory, 'invoked'))).toBe(false);
    if (failure === 'principal' || failure === 'throw-after-output') expect(readFileSync(join(f.directory, 'disposed'), 'utf8')).toBe('disposed');
  });
  it.each(['host', 'port', 'principal', 'transport'])('rechecks %s scope inside the PowerShell child', async field => {
    const f = fixture(); transport.exe = engine.exe; observe(f);
    transport.patch = payload => { payload.protectedCredential[field] = field === 'port' ? 5986 : 'mismatch'; };
    expect(await direct()).toMatchObject({ invocationStatus: 'transport_error', stderr: 'Protected credential unavailable' });
    expect(existsSync(join(f.directory, 'invoked'))).toBe(false);
  });
  it('disposes after a transport exception without exposing the one-character secret', async () => {
    const f = fixture(); transport.exe = engine.exe; observe(f, "throw [Security.Authentication.AuthenticationException]::new($Credential.GetNetworkCredential().Password)");
    const result = await direct();
    expect(result).toMatchObject({ invocationStatus: 'transport_error', winrmReason: 'authentication_exception', stderr: '[REDACTED]' });
    expect(readFileSync(join(f.directory, 'disposed'), 'utf8')).toBe('disposed');
  });
  it('discards successful output when cleanup reports failure', async () => {
    const f = fixture(); transport.exe = engine.exe; observe(f); transport.cleanupFault = true;
    for (const result of [await direct(), (await executeBatchTarget(target, 15000)).output as any]) {
      expect(result).toMatchObject({ invocationStatus: 'transport_error', stdout: '', stderr: 'Protected credential cleanup failed' });
      expect(result.errorRecords).toBeUndefined(); expect(result.log).toBeUndefined();
    }
    expect(readFileSync(join(f.directory, 'disposed'), 'utf8')).toBe('disposed');
    expect(transport.raw.every(raw => raw.stderr === '')).toBe(true);
  });
  it('suppresses loader console and diagnostic streams before framing', async () => {
    const f = fixture(); transport.exe = engine.exe; observe(f);
    replaceLoader(f, readFileSync(f.path, 'utf8').replace('; $global:testCredential', "; [Console]::Out.Write('a YQA='); [Console]::Error.Write('a YQA='); Write-Warning 'a YQA='; Write-Host 'a YQA='; $global:testCredential"));
    // Preserve exactly one credential output while discarding loader diagnostics.
    expect(await direct()).toMatchObject({ invocationStatus: 'completed' });
    expect(transport.raw[0].stderr).toBe('');
    expect(transport.raw[0].stdout).toMatch(/^WINRM-RESULT:[0-9a-f]{48}:[A-Za-z0-9+/=]+\r?\n$/);
  });
  it('checks the deadline after loading and disposes before refusing dispatch', async () => {
    const f = fixture(); transport.exe = engine.exe; observe(f);
    transport.patch = payload => { payload.deadlineAt = 0; };
    const result = await direct();
    expect(result).toMatchObject({ invocationStatus: 'transport_error', stdout: '' });
    expect(existsSync(join(f.directory, 'invoked'))).toBe(false);
    expect(readFileSync(join(f.directory, 'disposed'), 'utf8')).toBe('disposed');
    expect(await executeBatchTarget(target, 15000)).toMatchObject({ status: 'failed', output: { invocationStatus: 'transport_error', stdout: '' } });
    expect(existsSync(join(f.directory, 'invoked'))).toBe(false);
  });
});

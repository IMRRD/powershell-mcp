import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { selectIntegrationEngines } from './integration-engine.js';

const engines = process.platform === 'win32' ? selectIntegrationEngines() : [];
const root = resolve(import.meta.dirname, '..');
let directory: string, installed: string;
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(p => p && existsSync(p))!;
async function npm(args: string[], cwd: string, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', failure: Error | undefined;
    child.stdout.on('data', b => out = (out + b).slice(-65536)); child.stderr.on('data', b => err = (err + b).slice(-4096));
    child.once('error', error => { failure = error; });
    // Drain close before removing the owned install directory, including abort.
    child.once('close', code => !failure && code === 0 ? resolve(out) : reject(failure ?? Error(`artifact setup failed (${code}): ${err.slice(-512)}`)));
  });
}
beforeAll(async () => {
  if (!engines.length) return;
  directory = mkdtempSync(join(tmpdir(), 'mcp-protected-artifact-'));
  const signal = AbortSignal.timeout(150000);
  const pack = join(directory, 'pack'); mkdirSync(pack);
  const packed = JSON.parse(await npm(['pack', root, '--json', '--pack-destination', pack], root, signal))[0];
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}');
  await npm(['install', '--no-audit', '--no-fund', '--cache', join(root, 'node_modules/.npm-cache'), join(pack, packed.filename)], directory, signal);
  installed = join(directory, 'node_modules/@imrrd/powershell-mcp');
  expect(readFileSync(join(installed, 'dist/winrm-credential.js'), 'utf8')).toBe(readFileSync(join(root, 'dist/winrm-credential.js'), 'utf8'));
  console.log(`PROTECTED_ARTIFACT sha256=${createHash('sha256').update(readFileSync(join(pack, packed.filename))).digest('hex')}`);
}, 180000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

// Pinned synthetic loader doubles only native remoting, inside the child. No
// network occurs. All installed MCP handlers/providers/adapters remain real.
const loader = `
New-Module -Name Microsoft.PowerShell.Core -ScriptBlock {
  function Invoke-Command {
    param($ComputerName,$ScriptBlock,$ArgumentList,$Credential,$Authentication,$ErrorAction)
    if ($Credential -isnot [pscredential] -or $Credential.UserName -cne 'SYNTHETIC\\robot' -or $Credential.Password.Length -ne 1 -or $Authentication -cne 'Kerberos') { throw 'binding failed' }
    [IO.File]::AppendAllText($global:invokedPath, '1')
    & $ScriptBlock @ArgumentList
  }
  Export-ModuleMember -Function Invoke-Command
} | Import-Module -Global -Force
$s = New-Object Security.SecureString; $s.AppendChar([char]97); $s.MakeReadOnly()
[pscredential]::new('SYNTHETIC\\robot', $s)
`;

for (const engine of engines.length ? engines : [{ exe: 'Windows required' }]) describe.skipIf(process.platform !== 'win32')(`packed protected MCP (${engine.exe})`, () => {
  it('runs direct/batch positives and scope, short-secret, pin, cleanup and deadline refusals', async ({ signal }) => {
    const local = join(directory, engine.exe); mkdirSync(local);
    const path = join(local, 'robot.ps1'), map = join(local, 'map.json'), invoked = join(local, 'invoked');
    const scope = { transport: 'winrm', host: 'synthetic.invalid', port: 5985, principal: 'SYNTHETIC\\robot' };
    const entries: Record<string, unknown> = {};
    const configure = (ref: string, source: string) => {
      const loaderPath = join(local, `${ref}.ps1`); writeFileSync(loaderPath, source);
      entries[ref] = { ...scope, loaderPath, sha256: createHash('sha256').update(readFileSync(loaderPath)).digest('hex') };
      writeFileSync(map, JSON.stringify(entries));
    };
    const prefix = `$global:invokedPath = '${invoked.replaceAll("'", "''")}'\n`;
    configure('robot', prefix + loader);
    configure('cleanup', prefix + loader.replace('& $ScriptBlock @ArgumentList', '$r = & $ScriptBlock @ArgumentList; $Credential.Password.Dispose(); $r'));
    configure('disposed', prefix + loader + '; $s.Dispose()');
    configure('deadline', prefix + loader.replace('$s = New-Object', '$script:payload.deadlineAt = 0\n$s = New-Object'));
    const client = new Client({ name: 'synthetic-protected-acceptance', version: '1' });
    const stdio = new StdioClientTransport({ command: process.execPath, args: [join(installed, 'dist/index.js')],
      env: { ...process.env as Record<string, string>, POWERSHELL_MCP_NO_TELEMETRY: '1', PWSH_MCP_EXE: engine.exe, POWERSHELL_MCP_WINRM_CREDENTIAL_MAP: map, POWERSHELL_MCP_WINRM_CREDENTIAL_MAP_SHA256: createHash('sha256').update(readFileSync(map)).digest('hex') }, stderr: 'pipe' });
    try {
      await client.connect(stdio);
      const call = (name: string, args: any) => client.callTool({ name, arguments: args }, undefined, { timeout: 20000, signal });
      const request = { computerName: scope.host, username: scope.principal, credentialRef: 'robot', authentication: 'Kerberos', command: "'synthetic ok'", timeoutMs: 15000, maxOutputBytes: 1024, logOutput: true };
      const direct = await call('winrm_exec', request);
      expect(direct.structuredContent, JSON.stringify(direct)).toMatchObject({ terminationStatus: 'completed', terminationCertainty: 'unknown', exitCode: null, detail: { localExitCode: 0 } });
      expect((direct.structuredContent as any).stdout.trim()).toBe('synthetic ok');
      expect((direct.structuredContent as any).log).toBeUndefined();
      const batch = await call('start_remote_batch', { targets: [{ transport: 'winrm', host: scope.host, command: request.command, username: scope.principal, credentialRef: 'robot', authentication: 'Kerberos' }], concurrency: 1, timeoutMs: 15000 });
      const id = JSON.parse((batch.content as any)[0].text).id;
      let snapshot: any;
      for (let i = 0; i < 160; i++) {
        snapshot = JSON.parse(((await call('remote_batch_status', { id })).content as any)[0].text);
        if (snapshot.status !== 'running') break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(snapshot).toMatchObject({ status: 'completed', results: [{ status: 'completed', result: { invocationStatus: 'completed' } }] });
      expect(readFileSync(invoked, 'utf8')).toBe('11');
      const mismatch = await call('winrm_exec', { ...request, computerName: 'other.invalid' });
      expect(mismatch.isError).toBe(true); expect(readFileSync(invoked, 'utf8')).toBe('11');
      const redacted = await call('winrm_exec', { ...request, command: "'a YQ== YQA='; Write-Error 'a YQ== YQA='" });
      expect(redacted.structuredContent).toMatchObject({ terminationStatus: 'remote_error' });
      expect((redacted.structuredContent as any).stdout).toContain('[REDACTED] [REDACTED] [REDACTED]');
      expect(JSON.stringify(redacted)).not.toContain('YQA=');
      writeFileSync(path, "throw 'pin mismatch must not execute'");
      const pin = await call('winrm_exec', request);
      expect(pin.structuredContent).toMatchObject({ terminationStatus: 'transport_error', stdout: '' });
      expect(readFileSync(invoked, 'utf8')).toBe('111');
      const disposed = await call('winrm_exec', { ...request, credentialRef: 'disposed' });
      expect(disposed.structuredContent).toMatchObject({ terminationStatus: 'transport_error', stdout: '' });
      expect(readFileSync(invoked, 'utf8')).toBe('111');
      // Dispose before returning the wrapper: local redaction/cleanup cannot
      // establish safe completion and must discard the successful remote body.
      const cleanup = await call('winrm_exec', { ...request, credentialRef: 'cleanup' });
      expect(cleanup.structuredContent).toMatchObject({ terminationStatus: 'transport_error', stdout: '' });
      // Force expiry in the trusted local fixture after resolution, before the
      // final dispatch check; no timing lottery and no remote invocation.
      const before = readFileSync(invoked, 'utf8');
      const deadline = await call('winrm_exec', { ...request, credentialRef: 'deadline' });
      expect(deadline.structuredContent).toMatchObject({ terminationStatus: 'transport_error', stdout: '' });
      expect(readFileSync(invoked, 'utf8')).toBe(before);
    } finally { await client.close(); }
  }, 90000);
});

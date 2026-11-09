import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestrictedDiagnosticsStore } from '../src/diagnostics-store.js';
import { diagnosticPair, DIAGNOSTICS_POLICY, validDiagnosticPair } from '../src/diagnostics-schema.js';

const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const q = (value: string) => "'" + value.replaceAll("'", "''") + "'";
const secret = 'SYNTHETIC-CUSTOMER-password=abc-target.example.invalid';
const pair = () => diagnosticPair('run_program', randomUUID(), 8, 'transport_error', -4058);
function native(script: string, input?: string) {
  return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; " + script], { input, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
describe.skipIf(process.platform !== 'win32')('actual restricted diagnostics storage', () => {
  let parent: string, directory: string, store: RestrictedDiagnosticsStore;
  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), 'mcp-diagnostics-test-'));
    directory = join(parent, 'private');
    store = new RestrictedDiagnosticsStore(directory, 'isolated-test');
  });
  afterEach(() => { rmSync(parent, { recursive: true, force: true }); });
  const consent = async () => expect(await store.consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'ok' });
  function seed(records: unknown[], age = 61000, extra = '') {
    native(`Add-Type -Path ${q(join(process.cwd(), 'scripts/ProtectedCredentialStore.cs'))}; Add-Type -AssemblyName System.Security;
      $s=New-Object ProtectedCredentialStore(${q(directory)},$false);
      $r=[Console]::In.ReadToEnd() | ConvertFrom-Json; try {
        $entropy=[Text.Encoding]::UTF8.GetBytes('powershell-mcp-restricted-diagnostics-v1');
        foreach($p in $r.pairs) {
          $v=@{storedAt=([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$r.age);pair=$p};
          $b=[Text.Encoding]::UTF8.GetBytes(($v|ConvertTo-Json -Depth 12 -Compress));
          $blob=[Security.Cryptography.ProtectedData]::Protect($b,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);
          $s.Publish(('record-'+$p[0].correlationId+'.dpapi'),$blob)
        }; ${extra}
      } finally {$s.Dispose()}`, JSON.stringify({ pairs: records, age }));
  }

  it('requires separate exact named scope and refuses automatic directory creation', async () => {
    expect(await store.append(pair())).toEqual({ status: 'inactive' });
    expect(readdirSync(parent)).toEqual([]);
    await consent();
    expect(await new RestrictedDiagnosticsStore(directory, 'other-installation').append(pair())).toEqual({ status: 'denied' });
    expect(await new RestrictedDiagnosticsStore(directory, 'other-installation').read()).toEqual({ status: 'denied' });
    expect(await new RestrictedDiagnosticsStore(directory, 'other-installation').revoke()).toEqual({ status: 'denied' });
    expect(await store.consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'denied' });
  }, 45000);

  it('roundtrips an operator directory containing Unicode and quotes as stdin data', async () => {
    directory = join(parent, "private-Δ-'quoted");
    store = new RestrictedDiagnosticsStore(directory, 'isolated-test');
    await consent();
    const value = pair(); expect(await store.append(value)).toEqual({ status: 'ok' });
    expect(await store.read()).toEqual({ status: 'ok', pairs: [value], nextAfter: null });
    expect(await store.revoke()).toEqual({ status: 'ok' });
  }, 45000);

  it('roundtrips strictly bounded encrypted records across instances and rejects raw data', async () => {
    await consent();
    const value = pair();
    expect(await store.append(value)).toEqual({ status: 'ok' });
    expect(await new RestrictedDiagnosticsStore(directory, 'isolated-test').read()).toEqual({ status: 'ok', pairs: [value], nextAfter: null });
    const before = readdirSync(directory);
    expect(await store.append([{ ...value[0], command: secret }, value[1]])).toEqual({ status: 'invalid' });
    expect(await store.read(17)).toEqual({ status: 'invalid' });
    expect(readdirSync(directory)).toEqual(before);
    const disk = readFileSync(join(directory, `record-${value[0].correlationId}.dpapi`));
    expect(disk.toString()).not.toContain('correlationId');
    expect(disk.toString()).not.toContain(value[0].correlationId);
    expect(await store.append(value)).toEqual({ status: 'denied' }); // no replacement/replay overwrite
  }, 45000);

  it('persists disable/revoke, denies retrieval, purges only diagnostics and preserves aggregate history', async () => {
    const history = join(parent, 'permanent-aggregate-history');
    writeFileSync(history, 'permanent-fixture');
    await consent();
    expect(await store.append(pair())).toEqual({ status: 'ok' });
    expect(await store.disable()).toEqual({ status: 'ok' });
    expect(readdirSync(directory).some(n => n.startsWith('record-'))).toBe(true);
    expect(await store.read()).toEqual({ status: 'inactive' });
    expect(await new RestrictedDiagnosticsStore(directory, 'isolated-test').append(pair())).toEqual({ status: 'inactive' });
    expect(await store.revoke()).toEqual({ status: 'ok' });
    expect(await store.revoke()).toEqual({ status: 'ok' });
    expect(readdirSync(directory).some(n => n.startsWith('record-'))).toBe(false);
    expect(await store.read()).toEqual({ status: 'inactive' });
    expect(readFileSync(history, 'utf8')).toBe('permanent-fixture');
    expect(await new RestrictedDiagnosticsStore(parent, 'isolated-test').consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'denied' });
    expect(readFileSync(history, 'utf8')).toBe('permanent-fixture');
  }, 60000);

  it('enforces a cross-process rate limit without overwriting retained records', async () => {
    await consent();
    for (let i = 0; i < 6; i++) expect(await new RestrictedDiagnosticsStore(directory, 'isolated-test').append(pair())).toEqual({ status: 'ok' });
    expect(await store.append(pair())).toEqual({ status: 'limited' });
    expect((await store.read()).pairs).toHaveLength(6);
  }, 60000);

  it('fails fast under real cross-process exclusive admission and recovers after lease release', async () => {
    await consent();
    const helper = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', `
      $ErrorActionPreference='Stop';
      $f=[IO.File]::Open(${q(join(directory, 'access.lock'))},[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);
      try { [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally { $f.Dispose() }
    `], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const deadline = setTimeout(() => helper.kill(), 15000);
    try {
      const [ready] = await once(helper.stdout, 'data');
      expect(ready.toString().trim()).toBe('locked');
      expect(await store.append(pair())).toEqual({ status: 'denied' });
      expect(await store.read()).toEqual({ status: 'denied' });
      const closed = once(helper, 'close'); helper.stdin.end('\n'); await closed;
      expect(await store.append(pair())).toEqual({ status: 'ok' });
      expect((await store.read()).pairs).toHaveLength(1);
    } finally { clearTimeout(deadline); helper.kill(); }
  }, 45000);

  it('bounds capacity and retrieval pages independently of rate', async () => {
    await consent();
    seed(Array.from({ length: 128 }, pair));
    expect(await store.append(pair())).toEqual({ status: 'limited' });
    const first = await store.read(16);
    expect(first.status).toBe('ok');
    expect(first.pairs).toHaveLength(16);
    expect(first.pairs!.every(validDiagnosticPair)).toBe(true);
    expect(first.nextAfter).toBe(first.pairs![15][0].correlationId);
    const next = await store.read(16, first.nextAfter!);
    expect(next.pairs).toHaveLength(16);
    expect(next.pairs!.every(p => !first.pairs!.some(f => f[0].correlationId === p[0].correlationId))).toBe(true);
  }, 60000);

  it('prunes expired records, rejects expired consent and allows explicit final deletion', async () => {
    await consent();
    seed([pair()], 3600001);
    expect(await store.read()).toEqual({ status: 'ok', pairs: [], nextAfter: null });
    seed([], 0, `$issued=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-3600001;
      $b=[Text.Encoding]::UTF8.GetBytes((@{schemaVersion=1;policy='restricted-local-v1';installation='isolated-test';issuedAt=$issued;expiresAt=($issued+3600000)} | ConvertTo-Json -Compress));
      [IO.File]::Delete(${q(join(directory, 'consent.dpapi'))});
      $s.Publish('consent.dpapi',[Security.Cryptography.ProtectedData]::Protect($b,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser))`);
    expect(await store.append(pair())).toEqual({ status: 'inactive' });
    expect(await store.read()).toEqual({ status: 'inactive' });
    expect(await store.revoke()).toEqual({ status: 'ok' });
  }, 45000);

  it('never exposes an interrupted publication and can revoke its protected orphan', async () => {
    await consent();
    seed([], 0, `$s.Publish('abcdefgh.abc',[Text.Encoding]::UTF8.GetBytes('partial-synthetic'))`);
    expect(await store.read()).toEqual({ status: 'denied' });
    expect(await store.append(pair())).toEqual({ status: 'denied' });
    expect(await store.revoke()).toEqual({ status: 'ok' });
    expect(readdirSync(directory)).not.toContain('abcdefgh.abc');
  }, 45000);

  it('refuses oversized records and disk pressure without publishing', async () => {
    await consent();
    const faultRoot = join(parent, 'disk-fault-helper');
    // Fault injection in a disposable copy only; production has no tunable disk floor.
    const { mkdirSync } = await import('node:fs'); mkdirSync(faultRoot);
    copyFileSync(join(process.cwd(), 'scripts/ProtectedCredentialStore.cs'), join(faultRoot, 'ProtectedCredentialStore.cs'));
    writeFileSync(join(faultRoot, 'restricted-diagnostics.ps1'), readFileSync(join(process.cwd(), 'scripts/restricted-diagnostics.ps1'), 'utf8').replace('$MinFreeBytes = 67108864L', '$MinFreeBytes = [long]::MaxValue'));
    const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', join(faultRoot, 'restricted-diagnostics.ps1')], { input: JSON.stringify({ operation: 'append', directory, installation: 'isolated-test', pair: pair() }), encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ status: 'limited' });
    expect(readdirSync(directory).some(n => n.startsWith('record-'))).toBe(false);
    // Exercise byte admission independently of the slot/rate guards.
    const byteFault = join(faultRoot, 'byte-limit.ps1');
    writeFileSync(byteFault, readFileSync(join(process.cwd(), 'scripts/restricted-diagnostics.ps1'), 'utf8').replace('$MaxBytes = 262144L', '$MaxBytes = 1L'));
    const bytes = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', byteFault], { input: JSON.stringify({ operation: 'append', directory, installation: 'isolated-test', pair: pair() }), encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(bytes.status).toBe(0); expect(JSON.parse(bytes.stdout)).toEqual({ status: 'limited' });
    // Bypass the TS API to prove that the storage boundary independently rejects free text.
    const invalid = pair() as any; invalid[0].password = secret;
    const rejected = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-File', join(process.cwd(), 'scripts/restricted-diagnostics.ps1')], { input: JSON.stringify({ operation: 'append', directory, installation: 'isolated-test', pair: invalid }), encoding: 'utf8', timeout: 15000, windowsHide: true });
    expect(rejected.status).toBe(0); expect(JSON.parse(rejected.stdout)).toEqual({ status: 'denied' });
    expect(readdirSync(directory).some(n => n.startsWith('record-'))).toBe(false);
    seed([], 0, `$s.Publish('record-${randomUUID()}.dpapi',(New-Object byte[] 2049))`);
    expect(await store.read()).toEqual({ status: 'denied' });
    expect(await store.append(pair())).toEqual({ status: 'denied' });
  }, 45000);

  it('verifies real protected ACLs and real kernel access denial using a restricted token', async () => {
    await consent();
    const value = pair(); expect(await store.append(value)).toEqual({ status: 'ok' });
    const file = join(directory, `record-${value[0].correlationId}.dpapi`);
    const result = native(`Add-Type -Path ${q(join(process.cwd(), 'test/fixtures/diagnostics-access-denial.cs'))};
      $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      foreach($p in @(${q(directory)},${q(file)})) {
        $a=Get-Acl -LiteralPath $p; if(-not $a.AreAccessRulesProtected -or $a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'unsafe'};
        foreach($rule in $a.Access){if($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid){throw 'unsafe'}}
      }; if(-not [DiagnosticsAccessDenial]::CannotRead(${q(file)})){throw 'access allowed'}; 'denied-as-required'`);
    expect(result.trim()).toBe('denied-as-required');
    execFileSync(join(process.env.SystemRoot!, 'System32/icacls.exe'), [file, '/grant', '*S-1-1-0:R'], { windowsHide: true });
    const snapshot = () => native(`(Get-Acl -LiteralPath ${q(file)}).Sddl`).trim();
    const before = snapshot();
    expect(await store.read()).toEqual({ status: 'denied' });
    expect(await store.append(pair())).toEqual({ status: 'denied' });
    expect(snapshot()).toBe(before);
  }, 60000);

  it('rejects inherited roots and junction aliases without repairing their ACL', async () => {
    await consent();
    const alias = join(parent, 'alias');
    symlinkSync(directory, alias, 'junction');
    expect(await new RestrictedDiagnosticsStore(alias, 'isolated-test').read()).toEqual({ status: 'denied' });
    execFileSync(join(process.env.SystemRoot!, 'System32/icacls.exe'), [directory, '/inheritance:e'], { windowsHide: true });
    const before = native(`(Get-Acl -LiteralPath ${q(directory)}).Sddl`);
    expect(await store.append(pair())).toEqual({ status: 'denied' });
    expect(native(`(Get-Acl -LiteralPath ${q(directory)}).Sddl`)).toBe(before);
  }, 45000);
});

it.skipIf(process.platform === 'win32')('fails closed on platforms without this protected backend', async () => {
  const store = new RestrictedDiagnosticsStore('/tmp/unused-restricted-diagnostics', 'isolated-test');
  expect(await store.consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'unavailable' });
  expect(await store.read()).toEqual({ status: 'unavailable' });
});

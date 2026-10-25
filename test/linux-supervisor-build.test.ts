import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(join(root, 'scripts/supervisor-build/baseline.json'), 'utf8'));
it('ships a loadable .NET Core 3.1 artifact with only baseline assembly references', () => {
  const assembly = join(root, 'dist/linux-supervisor.dll');
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -Path $env:MCP_TEST_SUPERVISOR; $a=[LinuxJob].Assembly; @{location=$a.Location; target=($a.GetCustomAttributesData() | Where-Object AttributeType -Match TargetFramework).ConstructorArguments[0].Value; refs=@($a.GetReferencedAssemblies() | ForEach-Object { $_.Name + "=" + $_.Version.ToString() })} | ConvertTo-Json -Compress'], {
    env: { ...process.env, MCP_TEST_SUPERVISOR: assembly }, encoding: 'utf8', windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  const metadata = JSON.parse(result.stdout);
  expect(realpathSync.native(metadata.location)).toBe(realpathSync.native(assembly));
  expect(metadata.target).toBe('.NETCoreApp,Version=v3.1');
  expect(metadata.refs.sort()).toEqual([
    'System.Runtime=4.2.2.0', 'System.Diagnostics.Process=4.2.2.0', 'System.Collections=4.1.2.0',
    'System.Threading.Thread=4.1.2.0', 'System.Threading=4.1.2.0', 'System.Console=4.1.2.0',
    'System.IO.FileSystem=4.1.2.0', 'System.Runtime.Extensions=4.2.2.0', 'System.Runtime.InteropServices=4.2.2.0',
  ].sort());
});

function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'supervisor-contract-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    for (const path of ['build-supervisors.mjs', 'supervisor-toolchain.mjs', 'supervisor-build'])
      cpSync(join(root, 'scripts', path), join(directory, 'scripts', path), { recursive: true });
    cpSync(join(root, 'assets'), join(directory, 'assets'), { recursive: true });
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'dist/linux-supervisor.dll'), 'stale');
    run(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
function build(directory: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(directory, 'scripts/build-supervisors.mjs')], {
    env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true,
  });
}
for (const failure of ['missing SDK', 'wrong SDK', 'missing refs', 'wrong archive', 'wrong extracted refs'])
  it(`fails closed and deletes stale artifact with ${failure}`, () => fixture(directory => {
    const cache = join(directory, 'packages');
    const env: NodeJS.ProcessEnv = { NUGET_PACKAGES: cache };
    if (failure === 'missing SDK') env.MCP_SUPERVISOR_DOTNET = join(directory, 'absent-dotnet');
    if (failure === 'wrong SDK') env.MCP_SUPERVISOR_DOTNET = process.execPath;
    if (failure.startsWith('wrong ' ) && failure !== 'wrong SDK') {
      const pack = join(cache, 'microsoft.netcore.app.ref', baseline.referenceVersion);
      mkdirSync(join(pack, 'ref/netcoreapp3.1'), { recursive: true });
      const name = `microsoft.netcore.app.ref.${baseline.referenceVersion}.nupkg`;
      const source = join(process.env.NUGET_PACKAGES || join(homedir(), '.nuget/packages'), 'microsoft.netcore.app.ref', baseline.referenceVersion, name);
      if (failure === 'wrong archive') writeFileSync(join(pack, name), 'wrong archive');
      else cpSync(source, join(pack, name));
      writeFileSync(join(pack, 'ref/netcoreapp3.1/System.Runtime.dll'), 'wrong reference');
    }
    const result = build(directory, env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(failure === 'wrong SDK' ? /requires SDK/ : failure === 'wrong archive' ? /package hash mismatch/ : failure === 'wrong extracted refs' ? /assemblies hash mismatch/ : /ENOENT/);
    expect(existsSync(join(directory, 'dist/linux-supervisor.dll'))).toBe(false);
  }));

it('builds deterministically from locked references without invoking PowerShell', () => fixture(directory => {
  const sdks = spawnSync('dotnet', ['--list-sdks'], { encoding: 'utf8', windowsHide: true }).stdout;
  const entry = sdks.split(/\r?\n/).find(line => line.startsWith(`${baseline.sdk} [`))!;
  const dotnet = join(entry.slice(entry.indexOf('[') + 1, -1), '..', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const result = build(directory, { PATH: '', MCP_SUPERVISOR_DOTNET: dotnet });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(readFileSync(join(directory, 'dist/linux-supervisor.dll'))).toEqual(readFileSync(join(root, 'dist/linux-supervisor.dll')));
  expect(readFileSync(join(directory, 'dist/linux-supervisor.ps1'), 'utf8')).not.toMatch(/TypeDefinition|CompileOnly/);
}));

it('requires the pinned baseline and actual minimum-consumer artifact gate in CI and publish', () => {
  const sdk = JSON.parse(readFileSync(join(root, 'scripts/supervisor-build/global.json'), 'utf8')).sdk;
  expect(sdk).toEqual({ version: baseline.sdk, rollForward: 'disable', allowPrerelease: false });
  expect(baseline.referenceVersion).toBe('3.1.0');
  expect(baseline.minimumImage).toMatch(/7\.0\.0-ubuntu-18\.04@sha256:[a-f0-9]{64}$/);
  for (const workflow of ['ci.yml', 'publish.yml']) {
    const text = readFileSync(join(root, '.github/workflows', workflow), 'utf8');
    expect(text.indexOf('global-json-file: scripts/supervisor-build/global.json')).toBeLessThan(text.indexOf('run: npm run build'));
    expect(text).toContain('run: npm run supervisor:restore');
    expect(text).toContain('run: npm run test:supervisor-compat');
    expect(text).not.toContain('continue-on-error');
  }
});

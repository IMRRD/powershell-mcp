// Exercise only the tarball built from this checkout, never a registry copy of this package.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'mcp-installed-smoke-'));
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(path => path && existsSync(path));
if (!npmCli) throw new Error('npm CLI unavailable next to the selected Node runtime');
function command(args, cwd) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0 || result.error) throw new Error(`npm ${args.join(' ')} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
function assert(condition, message) { if (!condition) throw new Error(message); }
let client;
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert(pkg.name === '@imrrd/powershell-mcp', 'canonical scoped identity changed');
  const packDir = join(temp, 'pack');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(packDir);
  const filename = JSON.parse(command(['pack', root, '--json', '--pack-destination', packDir], root))[0].filename;
  const tarball = join(packDir, filename);
  assert(readdirSync(packDir).length === 1, 'expected one packed artifact');
  writeFileSync(join(temp, 'package.json'), '{"private":true,"type":"module"}\n');
  command(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], temp);
  const installed = join(temp, 'node_modules', '@imrrd', 'powershell-mcp');
  const actual = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert(actual.name === pkg.name && actual.version === pkg.version, 'installed identity/version mismatch');
  assert(readFileSync(join(installed, 'dist', 'index.js'), 'utf8').length > 0, 'missing built entrypoint');
  assert(readFileSync(join(installed, 'dist', 'job-supervisor.ps1'), 'utf8').length > 0, 'missing packaged supervisor');
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(installed, actual.bin['powershell-mcp'])],
    env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_EXEC_PARENT: temp }, stderr: 'pipe' });
  client = new Client({ name: 'installed-artifact-gate', version: '1' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  for (const name of ['run_powershell', 'run_program', 'ssh_exec', 'sftp_upload', 'sftp_download', 'winrm_exec', 'runtime_capabilities'])
    assert(tools.some(t => t.name === name), `missing packaged tool ${name}`);
  const cap = await client.callTool({ name: 'runtime_capabilities', arguments: {} }, undefined, { timeout: 20000 });
  assert(cap.structuredContent?.packageVersion === pkg.version && cap.structuredContent?.protocolVersion === 1, 'incompatible capabilities');
  const call = (name, args) => client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  const success = await call('run_program', { program: process.execPath, args: ['-e', "process.stdout.write(process.argv[1]);process.stderr.write('stderr')", 'argument with spaces'], maxOutputBytes: 8, tail: true });
  assert(!success.isError && success.structuredContent?.stdout === 'h spaces' && success.structuredContent?.stderr === 'stderr', 'installed direct execution/arguments/bounds failed');
  assert(success.structuredContent?.truncation?.stdout?.truncated === true, 'output cap not reported');
  const failure = await call('run_program', { program: process.execPath, args: ['-e', 'process.exit(7)'] });
  assert(failure.isError && failure.structuredContent?.exitCode === 7 && failure.structuredContent?.terminationStatus === 'nonzero_exit', 'installed nonzero failure contract');
  const timeout = await call('run_program', { program: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], timeoutMs: 250 });
  assert(timeout.isError && timeout.structuredContent?.timedOut === true, 'installed timeout contract');
  const secret = 'synthetic-only-secret-24';
  const denied = await call('ssh_exec', { host: '127.0.0.1', port: 1, username: 'fixture', command: 'true', password: secret, hostKeyPins: ['SHA256:invalid'] });
  assert(denied.isError && denied.structuredContent?.detail?.error === 'invalid host key pin' && !JSON.stringify(denied).includes(secret), 'installed trust/credential boundary');
  const mixed = await call('ssh_exec', { host: 'synthetic.invalid', username: 'fixture', command: 'true', credentialRef: 'fixture', password: secret });
  assert(mixed.isError && !JSON.stringify(mixed).includes(secret), 'mixed credential boundary');
  if (process.env.MCP_REQUIRED_ENGINE) {
    const engine = process.env.MCP_REQUIRED_ENGINE;
    const ps = await call('run_powershell', { engine, script: "Write-Output 'engine-smoke-24'", errorPolicy: 'strict' });
    assert(!ps.isError && ps.structuredContent?.stdout?.includes('engine-smoke-24') && ps.structuredContent?.detail?.shell === (engine === 'powershell' ? 'powershell.exe' : engine), `required ${engine} failed: ${JSON.stringify(ps)}`);
  }
  console.log(`installed artifact PASS ${actual.name}@${actual.version} schema=1 engine=${process.env.MCP_REQUIRED_ENGINE ?? 'none'} tarball=${filename} sha256=${createHash('sha256').update(readFileSync(tarball)).digest('hex')} commit=${process.env.GITHUB_SHA ?? 'local'}`);
} finally {
  if (client) await client.close();
  rmSync(temp, { recursive: true, force: true });
}

// Exercise only the tarball built from this checkout, never a registry copy of this package.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { connect as tcpConnect } from 'node:net';
import { pathToFileURL } from 'node:url';
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
let assertions = 0;
function assert(condition, message) { assertions++; if (!condition) throw new Error(message); }
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
  const { OutputCollector, combineCaptures, captureBytes } = await import(pathToFileURL(join(installed, 'dist', 'output-collector.js')).href);
  for (const tail of [false, true]) for (const cap of [0, 1, 2, 3, 4, 5, 7]) {
    for (const [local, remote] of [[Buffer.from('A'), '€'], [Buffer.from('€'), 'A'], [Buffer.from([0xff, 0x41]), '€😀Z'], [Buffer.from([0xe2]), '€']]) {
      const first = new OutputCollector(cap, tail); first.append(local);
      const second = new OutputCollector(cap, tail); second.append(Buffer.from(remote));
      const reference = new OutputCollector(cap, tail); reference.append(local); reference.append(Buffer.from(remote));
      const combined = combineCaptures([first.snapshot(), { ...second.snapshot() }], cap, tail);
      assert(JSON.stringify(combined) === JSON.stringify(reference.snapshot()) &&
        captureBytes(combined).equals(captureBytes(reference.snapshot())), `installed Unicode combination cap=${cap} tail=${tail}`);
    }
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(installed, actual.bin['powershell-mcp'])],
    env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_EXEC_PARENT: temp }, stderr: 'pipe' });
  client = new Client({ name: 'installed-artifact-gate', version: '1' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const { TOOL_NAMES } = await import(pathToFileURL(join(installed, 'dist', 'tool-instrumentation.js')).href);
  assert(tools.length === TOOL_NAMES.length && tools.every(t => TOOL_NAMES.includes(t.name)), 'instrumentation tool allowlist drift');
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
  const { Server, utils } = createRequire(join(installed, 'package.json'))('ssh2');
  const fixtures = [];
  const makeFixture = async (forward) => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
    const parsed = utils.parseKey(key);
    assert(!(parsed instanceof Error), 'invalid fixture key');
    const pin = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
    const sockets = new Set(); let commands = 0;
    const server = new Server({ hostKeys: [key] }, peer => {
      sockets.add(peer); peer.on('error', () => {}); peer.on('close', () => sockets.delete(peer));
      peer.on('authentication', ctx => ctx.accept());
      peer.on('ready', () => {
        peer.on('tcpip', (accept, reject, info) => {
          if (!forward || info.destIP !== '127.0.0.1') return reject();
          const outbound = tcpConnect(info.destPort, '127.0.0.1');
          outbound.once('connect', () => outbound.pipe(accept()).pipe(outbound));
          outbound.once('error', () => reject());
        });
        peer.on('session', accept => accept().on('exec', acceptExec => { commands++; const stream = acceptExec(); stream.write('packaged-routed'); stream.exit(0); stream.end(); }));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const item = { host: '127.0.0.1', port: server.address().port, username: 'fixture', password: 'synthetic', hostKeyPins: [pin], get commands() { return commands; }, async close() { for (const c of sockets) c.end(); await new Promise(resolve => server.close(resolve)); } };
    fixtures.push(item); return item;
  };
  try {
    const dest = await makeFixture(false), middle = await makeFixture(true), first = await makeFixture(true), wrong = await makeFixture(false);
    const route = { host: dest.host, port: dest.port, username: dest.username, password: dest.password, hostKeyPins: dest.hostKeyPins, command: 'echo routed', jumps: [first, middle].map(({ host, port, username, password, hostKeyPins }) => ({ host, port, username, password, hostKeyPins })), timeoutMs: 5000 };
    const good = await call('ssh_exec', route);
    assert(!good.isError && good.structuredContent?.stdout === 'packaged-routed' && dest.commands === 1, `packaged two-hop execution failed: ${JSON.stringify(good.structuredContent)}`);
    for (const index of [0, 1, 2]) {
      const bad = { ...route, hostKeyPins: index === 2 ? wrong.hostKeyPins : dest.hostKeyPins,
        jumps: route.jumps.map((hop, i) => ({ ...hop, hostKeyPins: i === index ? wrong.hostKeyPins : hop.hostKeyPins })) };
      const before = dest.commands;
      const refusal = await call('ssh_exec', bad);
      assert(refusal.isError && dest.commands === before, `packaged route trust failure at hop ${index} dispatched destination`);
    }
    console.log('packaged two-hop fixture PASS: control plus three independent host-key refusals');
  } finally { for (const f of fixtures.reverse()) await f.close(); }
  if (process.env.MCP_REQUIRED_ENGINE) {
    const engine = process.env.MCP_REQUIRED_ENGINE;
    const ps = await call('run_powershell', { engine, script: "Write-Output 'engine-smoke-24'", errorPolicy: 'strict' });
    assert(!ps.isError && ps.structuredContent?.stdout?.includes('engine-smoke-24') && ps.structuredContent?.detail?.shell === (engine === 'powershell' ? 'powershell.exe' : engine), `required ${engine} failed: ${JSON.stringify(ps)}`);
    for (const tail of [false, true]) {
      const bounded = await call('run_powershell', { engine, script: "$s='x'*1024; 1..1024 | ForEach-Object { [Console]::Out.Write($s); [Console]::Error.Write($s); $s }; 'END'", errorPolicy: 'strict', maxOutputBytes: 7, tail });
      const data = bounded.structuredContent;
      assert(!bounded.isError && data?.terminationStatus === 'completed', 'packaged sustained producer framing failed');
      assert(data?.truncation?.stdout?.observedBytes > 2_000_000 && data?.truncation?.stderr?.observedBytes === 1048576, 'packaged producer counters failed');
      for (const stream of ['stdout', 'stderr']) {
        const counts = data.truncation[stream];
        assert(counts.capturedBytes <= 7 && counts.capturedBytes + counts.omittedBytes === counts.observedBytes, 'packaged byte invariant failed');
      }
      assert(tail ? data.stdout.includes('END') : data.stdout === 'xxxxxxx', 'packaged head/tail failed');
    }
    const logged = await call('run_powershell', { engine, script: "[Console]::Out.Write('abcdefghij')", errorPolicy: 'strict', maxOutputBytes: 10, logOutput: true, logQuotaBytes: 2 });
    const data = logged.structuredContent;
    assert(!logged.isError && data.stdout === 'abcdefghij' && data.log.complete === false && data.log.stdoutBytes === 2, 'packaged display/log quota independence failed');
    const page = await call('read_output_log', { handle: data.log.handle, stream: 'stdout', offset: 0, length: 16 });
    assert(JSON.parse(page.content[0].text).data === 'YWI=', 'packaged log raw bytes failed');
    await call('delete_output_log', { handle: data.log.handle });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await client.callTool({ name: 'run_powershell', arguments: { engine, script: "'prefix'; Start-Sleep -Seconds 20", errorPolicy: 'strict', logOutput: true } }, undefined, { signal: controller.signal, timeout: 10000 });
      assert(false, 'packaged cancellation unexpectedly completed');
    } catch (error) { assert(controller.signal.aborted, 'packaged cancellation failed before abort'); }
    finally { clearTimeout(timer); }
    const after = await call('run_powershell', { engine, script: "'AFTER_CANCEL'", errorPolicy: 'strict' });
    assert(!after.isError && after.structuredContent.stdout.includes('AFTER_CANCEL'), 'packaged server failed after cancellation');
  }
  console.log(`installed artifact PASS assertions=${assertions} ${actual.name}@${actual.version} schema=1 engine=${process.env.MCP_REQUIRED_ENGINE ?? 'none'} tarball=${filename} sha256=${createHash('sha256').update(readFileSync(tarball)).digest('hex')} commit=${process.env.GITHUB_SHA ?? 'local'}`);
} finally {
  if (client) await client.close();
  rmSync(temp, { recursive: true, force: true });
}

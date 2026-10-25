// Linux gate: exercise the packed DLL under PowerShell 7.0.0 / .NET Core 3.1.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = JSON.parse(readFileSync(new URL('./supervisor-build/baseline.json', import.meta.url), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'mcp-supervisor-compat-'));
function command(program, args) {
  const r = spawnSync(program, args, { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (r.error || r.status !== 0) throw Error(`${program} failed: ${r.error || r.stderr}`);
  return r.stdout;
}
try {
  if (process.platform !== 'linux') throw Error('Minimum supervisor gate requires Linux with Docker');
  const npm = process.env.npm_execpath;
  if (!npm) throw Error('Run via npm run test:supervisor-compat');
  const pack = JSON.parse(command(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', work]))[0];
  for (const name of ['linux-supervisor.dll', 'linux-supervisor.ps1'])
    if (!pack.files.some(file => file.path === `dist/${name}`)) throw Error(`Tarball missing ${name}`);
  const tarball = join(work, pack.filename);
  command('tar', ['-xzf', tarball, '-C', work]);
  const dist = resolve(work, 'package/dist');
  console.log(`tarball SHA256 ${createHash('sha256').update(readFileSync(tarball)).digest('hex')}`);
  const image = baseline.minimumImage;
  command('docker', ['pull', image]);
  const docker = ['run', '--rm', '-i', '--network=none', '--mount', `type=bind,src=${dist},dst=/artifact,readonly`,
    '--entrypoint', 'pwsh', image, '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; if ($PSVersionTable.PSVersion.ToString() -cne '7.0.0' -or -not ([System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription.StartsWith('.NET Core 3.1.'))) { throw 'Wrong minimum consumer' }; [Console]::Error.WriteLine($PSVersionTable.PSVersion.ToString() + ' / ' + [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription); & /artifact/linux-supervisor.ps1"];
  async function exercise(cancel) {
    const nonce = 'a'.repeat(48);
    const script = cancel ? 'sleep 30 & printf child-ready; wait' : 'read line; printf "out:%s:%s" "$PWD" "$line"; printf err >&2; exit 7';
    const request = { nonce, program: '/bin/sh', args: ['-c', script], cwd: '/tmp', input: Buffer.from('stdin-ok\n').toString('base64') };
    const events = []; let stderr = ''; let pending = ''; let cancelSent = false;
    const child = spawn('docker', docker, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      pending += data;
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try { const event = JSON.parse(line); events.push(event);
          if (cancel && !cancelSent && event.event === 'chunk' &&
              events.filter(e => e.event === 'chunk' && e.stream === 'stdout').map(e => Buffer.from(e.data, 'base64').toString()).join('').includes('child-ready')) {
            cancelSent = true; child.stdin.write(`cancel ${nonce}\n`);
          }
        } catch { events.push({ event: 'invalid', line }); }
      }
    });
    child.stdin.write(JSON.stringify(request) + '\n');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(Error('Minimum consumer timed out')); }, 20000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Minimum consumer exit ${code}: ${stderr}`)); });
    });
    const finished = events.find(event => event.event === 'finished');
    if (events.some(event => event.nonce !== nonce || !['started', 'chunk', 'finished'].includes(event.event)) ||
        events.filter(e => e.event === 'started').length !== 1 || events.filter(e => e.event === 'finished').length !== 1 ||
        (cancel && !cancelSent) || !finished || finished.active !== 0 || finished.cancelled !== cancel || (!cancel && finished.exitCode !== 7))
      throw Error(`Invalid minimum-runtime lifecycle proof: ${JSON.stringify(events)} ${stderr}`);
    if (!cancel) {
      const output = stream => Buffer.concat(events.filter(e => e.event === 'chunk' && e.stream === stream).map(e => Buffer.from(e.data, 'base64'))).toString();
      if (output('stdout') !== 'out:/tmp:stdin-ok' || output('stderr') !== 'err') throw Error('Minimum-runtime stream/input/cwd mismatch');
    }
    console.log(`minimum runtime ${stderr.trim()}; ${cancel ? 'descendant cancellation' : 'streams, stdin, cwd, nonzero exit'}: passed`);
  }
  await exercise(false);
  await exercise(true);
} finally { rmSync(work, { recursive: true, force: true }); }

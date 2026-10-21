import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
function entries(home) {
  const root = join(home, '.powershell-mcp-telemetry');
  try { return readdirSync(root).filter(n => /^slot-\d{3}$/.test(n)).flatMap(n => readdirSync(join(root, n)).map(f => join(root, n, f))); }
  catch { return []; }
}
async function until(predicate, label) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await delay(100); }
  throw Error(`Timed out: ${label}`);
}
async function childRun(script, install, home, url) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: install, env: { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_NO_TELEMETRY: '0', POWERSHELL_MCP_TELEMETRY_URL: url }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
}
test('installed tarball persists through real collector ACK; wrong/lost ACK retains and replays', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'packaged-telemetry-'));
  const home = join(dir, 'home'), install = join(dir, 'install'), file = join(dir, 'records.jsonl');
  let collector, proxy;
  try {
    const { mkdirSync } = await import('node:fs'); mkdirSync(home); mkdirSync(install);
    const npm = process.platform === 'win32' ? resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js') : 'npm';
    const command = process.platform === 'win32' ? process.execPath : npm;
    const args = process.platform === 'win32' ? [npm] : [];
    const packed = execFileSync(command, [...args, 'pack', '--pack-destination', dir, '--json'], { cwd: repo, encoding: 'utf8' });
    const tar = join(dir, JSON.parse(packed)[0].filename);
    execFileSync(command, [...args, 'install', '--no-audit', '--no-fund', '--prefix', install, tar], { encoding: 'utf8' });
    const module = pathToFileURL(resolve(install, 'node_modules/@imrrd/powershell-mcp/dist/telemetry.js')).href;
    const startup = `import {startupPing,telemetryStatus} from ${JSON.stringify(module)}; startupPing('0.6.0'); while(telemetryStatus().outstanding) await new Promise(r=>setTimeout(r,20)); await new Promise(r=>setTimeout(r,2500));`;
    const resume = `import {startFlushTimer,telemetryStatus} from ${JSON.stringify(module)}; startFlushTimer('0.6.0'); while(telemetryStatus().outstanding) await new Promise(r=>setTimeout(r,20)); await new Promise(r=>setTimeout(r,2500));`;
    const port = 18000 + Math.floor(Math.random() * 25000);
    collector = spawn(process.execPath, [join(repo, 'collector/server.js')], { env: { ...process.env, PORT: String(port), TELEMETRY_FILE: file }, stdio: 'ignore' });

    const target = `http://127.0.0.1:${port}/api/telemetry`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {} await delay(25); }
    const proxyServer = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const b of req) chunks.push(b);
        const payload = Buffer.concat(chunks);
        const r = await fetch(target, { method: 'POST', body: payload });
        // Durable collector receipt exists but the client sees the wrong ACK.
        res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, eventId: 'wrong' }));
      } catch { res.writeHead(502).end(); }
    });
    proxyServer.listen(0, '127.0.0.1'); await once(proxyServer, 'listening'); proxy = proxyServer;
    const bad = `http://127.0.0.1:${proxy.address().port}/api/telemetry`;
    await childRun(startup, install, home, bad);
    await until(() => entries(home).some(p => p.includes('event.claim-')), 'retained claim');
    const [claim] = entries(home);
    const id = JSON.parse(readFileSync(claim, 'utf8')).eventId;
    await until(() => { try { return readFileSync(file, 'utf8').includes(id); } catch { return false; } }, 'durable collector record');
    assert.equal(entries(home).length, 1, 'wrong ACK must not delete');
    // Simulate a lost ACK and restart after claim lease expiry, preserving identity.
    const old = new Date(Date.now() - 11 * 60 * 1000); utimesSync(claim, old, old);
    await childRun(resume, install, home, target);
    await until(() => entries(home).length === 0, 'ACK deletion');
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').filter(x => JSON.parse(x).eventId === id).length, 1, 'deduplicated durable record');
    await childRun(startup, install, home, target);
    await until(() => entries(home).length === 0, 'positive ACK deletion');
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
    console.log('packaged positive ACK, wrong ACK retention, replay dedupe, queue deletion: verified');
  } finally { proxy?.close(); collector?.kill(); rmSync(dir, { recursive: true, force: true }); }
});

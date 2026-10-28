import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCommand, runClient, startProcess, stopProcess, waitFor, cleanup } from './fixtures/packaged-process.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
function entries(home) {
  const root = join(home, '.powershell-mcp-telemetry');
  try { return readdirSync(root).filter(n => /^slot-\d{3}$/.test(n)).flatMap(n => readdirSync(join(root, n)).map(f => join(root, n, f))); }
  catch { return []; }
}
async function until(predicate, label, signal) {
  for (let i = 0; i < 150; i++) { signal.throwIfAborted(); if (predicate()) return; await delay(100); }
  throw Error(`Timed out: ${label}`);
}
async function childRun(script, install, home, url, observe, signal) {
  // Local persistence ACK unrefs the worker. Keep this fixture process alive
  // until its parent has observed the network/queue proof, not for a fixed sleep.
  await runClient(script, {
    cwd: install, env: { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_NO_TELEMETRY: '0', POWERSHELL_MCP_TELEMETRY_URL: url },
  }, observe, { signal });
}
test('installed tarball persists through real collector ACK; wrong/lost ACK retains and replays', { timeout: 120000 }, async t => {
  const { signal } = t;
  const dir = mkdtempSync(join(tmpdir(), 'packaged-telemetry-'));
  const home = join(dir, 'home'), install = join(dir, 'install'), file = join(dir, 'records.jsonl');
  let collector, proxy, primary;
  try {
    const { mkdirSync } = await import('node:fs'); mkdirSync(home); mkdirSync(install);
    const npm = process.platform === 'win32' ? resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js') : 'npm';
    const command = process.platform === 'win32' ? process.execPath : npm;
    const args = process.platform === 'win32' ? [npm] : [];
    const packed = await runCommand(command, [...args, 'pack', '--pack-destination', dir, '--json'], { cwd: repo, signal, label: 'npm pack' });
    const tar = join(dir, JSON.parse(packed)[0].filename);
    await runCommand(command, [...args, 'install', '--no-audit', '--no-fund', '--prefix', install, tar], { signal, label: 'npm install' });
    const module = pathToFileURL(resolve(install, 'node_modules/@imrrd/powershell-mcp/dist/telemetry.js')).href;
    const metric = `import {recordTool,flushCounters,telemetryStatus} from ${JSON.stringify(module)}; import {readdirSync} from 'node:fs'; import {join} from 'node:path'; import {homedir} from 'node:os'; recordTool('runtime_capabilities','success','lt100','inspection'); flushCounters('0.6.0'); const root=join(homedir(),'.powershell-mcp-telemetry'); const end=Date.now()+10000; do { if(Date.now()>end) throw Error('metric ACK deadline'); await new Promise(r=>setTimeout(r,20)); } while(telemetryStatus().outstanding || readdirSync(root).some(n=>/^slot-\\d{3}$/.test(n)));`;
    const startup = `import {startupPing,telemetryStatus} from ${JSON.stringify(module)}; startupPing('0.6.0'); while(telemetryStatus().outstanding) await new Promise(r=>setTimeout(r,20));`;
    const resume = `import {startFlushTimer,telemetryStatus} from ${JSON.stringify(module)}; startFlushTimer('0.6.0'); while(telemetryStatus().outstanding) await new Promise(r=>setTimeout(r,20));`;
    const port = 18000 + Math.floor(Math.random() * 25000);
    collector = startProcess(process.execPath, [join(repo, 'collector/server.js')], { env: { ...process.env, PORT: String(port), TELEMETRY_FILE: file }, stdio: 'ignore' });

    const target = `http://127.0.0.1:${port}/api/telemetry`;
    let ready = false;
    for (let i = 0; i < 100; i++) { signal.throwIfAborted(); try { if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]) })).ok) { ready = true; break; } } catch {} await delay(25); }
    assert.ok(ready, 'collector must be ready before fixture traffic');
    let wrongAckSent = false;
    const proxyServer = createServer(async (req, res) => {
      try {
        const chunks = []; for await (const b of req) chunks.push(b);
        const payload = Buffer.concat(chunks);
        const r = await fetch(target, { method: 'POST', body: payload, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
        // Durable collector receipt exists but the client sees the wrong ACK.
        res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, eventId: 'wrong' }), () => { wrongAckSent = true; });
      } catch { res.writeHead(502).end(); }
    });
    proxy = proxyServer;
    proxyServer.listen(0, '127.0.0.1'); await waitFor(once(proxyServer, 'listening'), { signal, label: 'proxy listening' });
    const bad = `http://127.0.0.1:${proxy.address().port}/api/telemetry`;
    await childRun(startup, install, home, bad, async (_, observing) => {
      await until(() => entries(home).some(p => p.includes('event.claim-')), 'retained claim', observing);
      const eventId = JSON.parse(readFileSync(entries(home)[0], 'utf8')).eventId;
      await until(() => { try { return readFileSync(file, 'utf8').includes(eventId); } catch { return false; } }, 'durable collector record', observing);
      await until(() => wrongAckSent, 'wrong ACK response sent', observing);
      assert.equal(entries(home).length, 1, 'wrong ACK must retain the claim while the sender is live');
    }, signal);
    const [claim] = entries(home);
    const id = JSON.parse(readFileSync(claim, 'utf8')).eventId;
    await until(() => { try { return readFileSync(file, 'utf8').includes(id); } catch { return false; } }, 'durable collector record', signal);
    assert.equal(entries(home).length, 1, 'wrong ACK must not delete');
    // Simulate a lost ACK and restart after claim lease expiry, preserving identity.
    const old = new Date(Date.now() - 11 * 60 * 1000); utimesSync(claim, old, old);
    await childRun(resume, install, home, target, async (_, observing) => {
      await until(() => entries(home).length === 0, 'ACK deletion', observing);
    }, signal);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').filter(x => JSON.parse(x).eventId === id).length, 1, 'deduplicated durable record');
    await childRun(startup, install, home, target, async (_, observing) => {
      await until(() => entries(home).length === 0, 'positive ACK deletion', observing);
    }, signal);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
    await childRun(metric, install, home, target, async (_, observing) => {
      await until(() => entries(home).length === 0, 'metric ACK deletion', observing);
    }, signal);
    await until(() => { try { return readFileSync(file, 'utf8').trim().split('\n').length === 4; } catch { return false; } }, 'metric receipts', signal);
    const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.find(r => r.event === 'tool_counts').counts, { runtime_capabilities: 1 });
    assert.deepEqual(records.find(r => r.event === 'tool_metrics').metrics.runtime_capabilities, { outcomes: { success: 1 }, durations: { lt100: 1 }, features: { inspection: 1 } });
    console.log('packaged positive ACK, wrong ACK retention, replay dedupe, queue deletion: verified');
  } catch (e) { primary = e; } finally {
    await cleanup(primary, [async () => {
      if (proxy) {
        const closed = new Promise((resolve, reject) => proxy.close(e => e ? reject(e) : resolve()));
        await cleanup(undefined, [
          () => proxy.closeAllConnections(),
          () => waitFor(closed, { timeout: 5000, label: 'proxy close' }),
        ]);
      }
    }, () => stopProcess(collector),
    () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })]);
  }
});

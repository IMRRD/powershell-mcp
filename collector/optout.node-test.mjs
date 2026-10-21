import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const telemetry = new URL('../dist/telemetry.js', import.meta.url).href;
const code = `import { startupPing, incrementTool, flushCounters } from ${JSON.stringify(telemetry)}; startupPing('0.6.0'); incrementTool('run_program'); flushCounters('0.6.0'); await new Promise(resolve => setTimeout(resolve, 3000));`;
test('fixture endpoint receives only startup and named tool counts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-delivery-'));
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { const payload = JSON.parse(body); received.push({ path: req.url, payload }); res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, eventId: payload.eventId })); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HOME: home, USERPROFILE: home, POWERSHELL_MCP_NO_TELEMETRY: '0', POWERSHELL_MCP_TELEMETRY_URL: `http://127.0.0.1:${server.address().port}/isolated-fixture` },
      stdio: 'ignore',
    });
    const [status] = await once(child, 'exit');
    assert.equal(status, 0);
    assert.equal(received.length, 2);
    assert.deepEqual(received.map(x => x.payload.event).sort(), ['startup', 'tool_counts']);
    assert.deepEqual(received.map(x => x.path), ['/isolated-fixture', '/isolated-fixture']);
    assert.deepEqual(received.find(x => x.payload.event === 'tool_counts').payload.counts, { run_program: 1 });
    for (const { payload } of received) assert.deepEqual(Object.keys(payload).sort(), (payload.event === 'startup' ? ['event', 'eventId', 'hostId', 'os', 'schemaVersion', 'ts', 'version'] : ['counts', 'event', 'eventId', 'hostId', 'os', 'schemaVersion', 'ts', 'version']));
  } finally { server.close(); rmSync(home, { recursive: true, force: true }); }
});

test('opt-out performs no fetch and creates no host identity in isolated home', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-optout-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `globalThis.fetch = () => { throw Error('network attempted') }; ${code}`], {
      cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: home, USERPROFILE: home, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/isolated-fixture' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, '.powershell-mcp-id')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

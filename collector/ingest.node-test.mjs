import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const valid = { event: 'startup', hostId: 'fixture', os: 'linux', version: '0.6.0', ts: '2026-10-21T00:00:00.000Z' };
test('collector accepts legacy shape but rejects unknown fields and oversized bodies without writing them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collector-ingest-'));
  const file = join(dir, 'events.jsonl');
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { env: { ...process.env, PORT: String(port), TELEMETRY_FILE: file }, stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(url + '/health'); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(ready, 'server ready');
    const send = body => fetch(url + '/api/telemetry', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    assert.equal((await send(JSON.stringify(valid))).status, 202);
    assert.equal((await send(JSON.stringify({ ...valid, command: 'sensitive' }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...valid, counts: { run_program: 1 } }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...valid, hostId: 'x'.repeat(17000) }))).status, 413);
    assert.equal((await send('{')).status, 400);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._ip, undefined);
    assert.equal(rows[0].hostId, 'fixture');
  } finally { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } rmSync(dir, { recursive: true, force: true }); }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const historical = { ...valid, _ip: 'historical-private-fixture' };
  writeFileSync(file, JSON.stringify(historical) + '\n');
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { env: { ...process.env, PORT: String(port), TELEMETRY_FILE: file, TELEMETRY_TOKEN: 'fixture-secret' }, stdio: 'ignore' });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(url + '/health'); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(ready, 'server ready');
    const send = (body, token = 'fixture-secret') => fetch(url + '/api/telemetry', { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...(token === null ? {} : { 'X-Telemetry-Token': token }) } });
    assert.equal((await send(JSON.stringify(valid), null)).status, 401);
    assert.equal((await send(JSON.stringify(valid), 'wrong')).status, 401);
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify(historical) + '\n');
    const prefix = JSON.stringify({ ...valid, hostId: 'é' });
    const exact = prefix + ' '.repeat(16384 - Buffer.byteLength(prefix));
    assert.equal(Buffer.byteLength(exact), 16384);
    assert.equal((await send(exact)).status, 202);
    assert.equal((await send(exact + ' ')).status, 413);
    assert.equal((await send(JSON.stringify(valid))).status, 202);
    const opted = { ...valid, schemaVersion: 1, eventId: '12345678-1234-4234-8234-123456789abc', userId: 'abcdefab-1234-4234-8234-123456789abc', cohort: 'external_self_declared' };
    assert.equal((await send(JSON.stringify(opted))).status, 202);
    for (const extra of [{ userId: 'private@example.invalid' }, { cohort: 'internal' }, { userId: null }, { error: 'private' }]) {
      assert.equal((await send(JSON.stringify({ ...opted, ...extra }))).status, 422);
    }
    assert.equal((await send(JSON.stringify({ ...valid, command: 'sensitive' }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...valid, counts: { run_program: 1 } }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...valid, hostId: 'x'.repeat(17000) }))).status, 413);
    const metric = { ...valid, event: 'tool_metrics', schemaVersion: 2, eventId: '12345678-1234-4234-8234-123456789012', metrics: { run_program: { outcomes: { success: 1 }, durations: { lt100: 1 }, features: { execution: 1 } } } };
    assert.equal((await send(JSON.stringify(metric))).status, 202);
    const batchMetric = { ...metric, eventId: '12345678-1234-4234-8234-123456789013', metrics: { start_remote_batch: metric.metrics.run_program, remote_batch_status: metric.metrics.run_program, cancel_remote_batch: metric.metrics.run_program } };
    assert.equal((await send(JSON.stringify(batchMetric))).status, 202);
    assert.equal((await send(JSON.stringify({ ...metric, metrics: { run_program: { ...metric.metrics.run_program, host: 'private' } } }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...metric, schemaVersion: 1 }))).status, 422);
    assert.equal((await send(JSON.stringify({ ...metric, metrics: { run_program: { ...metric.metrics.run_program, outcomes: { secret: 1 } } } }))).status, 422);
    assert.equal((await send('{')).status, 400);
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 6);
    assert.deepEqual(rows[0], historical);
    assert.equal(rows[0]._ip, 'historical-private-fixture');
    assert.equal(rows[1].hostId, 'é');
    assert.equal(rows[1]._ip, undefined);
    assert.equal(rows[2]._ip, undefined);
    assert.equal(rows[2].hostId, 'fixture');
  } finally { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } rmSync(dir, { recursive: true, force: true }); }
});

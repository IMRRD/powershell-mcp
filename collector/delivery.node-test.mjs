import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const fixture = { schemaVersion: 1, eventId: '550e8400-e29b-41d4-a716-446655440000', event: 'startup', hostId: 'fixture', os: 'linux', version: '0.6.0', ts: '2026-10-21T00:00:00.000Z' };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function start(port, file, unhealthy = false, fault = '') {
  const env = { ...process.env, PORT: String(port), TELEMETRY_FILE: file };
  if (fault) { env.FAULT_TELEMETRY_FILE = file; env.FAULT_MODE = fault; env.NODE_OPTIONS = `--require=${fileURLToPath(new URL('./storage-fault.cjs', import.meta.url))}`; }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === (unhealthy ? 503 : 200)) return child; } catch {} await delay(25); }
  throw Error('collector not ready');
}
async function stop(child) { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
test('versioned receipt deduplicates after a real collector process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-')); const file = join(dir, 'events.jsonl');
  const port = 18000 + Math.floor(Math.random() * 30000);
  let child;
  try {
    child = await start(port, file);
    const send = (value = fixture) => fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(value) });
    let r = await send(); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { ok: true, eventId: fixture.eventId });
    const metric = { ...fixture, event: 'tool_metrics', schemaVersion: 2, eventId: '550e8400-e29b-41d4-a716-446655440001', userId: '12345678-1234-4234-8234-123456789abc', cohort: 'external_self_declared', metrics: { winrm_exec: { outcomes: { error: 1 }, durations: { lt1000: 1 }, features: { remote: 1 } } } };
    assert.equal((await send(metric)).status, 202);
    await stop(child); child = await start(port, file);
    r = await send(); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { ok: true, eventId: fixture.eventId });
    assert.equal((await send(metric)).status, 202);
    assert.equal((await send({ ...metric, userId: '12345678-1234-4234-8234-123456789abd' })).status, 409);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify({ ...fixture, eventId: 'not-id' }) })).status, 422);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('an event ID collision with different content is rejected across restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'collision-')); const file = join(dir, 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  let child;
  try {
    child = await start(port, file);
    const send = p => fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(p) });
    assert.equal((await send(fixture)).status, 202);
    await stop(child); child = await start(port, file);
    assert.equal((await send({ ...fixture, version: 'different' })).status, 409);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('an interrupted tail is repaired before new receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tail-')); const file = join(dir, 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  writeFileSync(file, '{"eventId":"partial');
  let child;
  try {
    child = await start(port, file);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) })).status, 202);
    const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1); assert.equal(records[0].eventId, fixture.eventId);
    const quarantines = readdirSync(dir).filter(name => name.startsWith('events.jsonl.corrupt-'));
    assert.equal(quarantines.length, 1);
    assert.equal(readFileSync(join(dir, quarantines[0]), 'utf8'), '{"eventId":"partial');
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('complete final record without newline remains durable after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newline-')); const file = join(dir, 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  writeFileSync(file, JSON.stringify({ ...fixture, _receivedAt: fixture.ts }));
  let child;
  try {
    child = await start(port, file);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) })).status, 202);
    const records = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, 1); assert.equal(records[0]._receivedAt, fixture.ts);
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify({ ...fixture, _receivedAt: fixture.ts }) + '\n');
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('semantic payload equality ignores property ordering, including counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-')); const file = join(dir, 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  let child;
  const payload = { ...fixture, event: 'tool_counts', counts: { run_program: 2, run_powershell: 1 } };
  try {
    child = await start(port, file);
    const send = p => fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(p) });
    assert.equal((await send(payload)).status, 202);
    await stop(child);
    const index = `${file}.receipts`;
    const [entry] = readdirSync(index);
    writeFileSync(join(index, entry), 'interrupted receipt');
    child = await start(port, file);
    assert.equal((await send({ counts: { run_powershell: 1, run_program: 2 }, ...fixture, event: 'tool_counts' })).status, 202);
    assert.equal((await send({ ...payload, counts: { run_program: 3, run_powershell: 1 } })).status, 409);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('short append is completed; partial append and fsync failure never ACK', async () => {
  for (const fault of ['short', 'partial', 'fsync']) {
    const dir = mkdtempSync(join(tmpdir(), `fault-${fault}-`)); const file = join(dir, 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
    let child;
    try {
      child = await start(port, file, false, fault);
      const send = () => fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) });
      assert.equal((await send()).status, fault === 'short' ? 202 : 503);
      assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, fault === 'short' ? 200 : 503);
      await stop(child); child = await start(port, file);
      assert.equal((await send()).status, 202);
      assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
    } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
  }
});
test('archive larger than 64 MiB accepts indexed receipts without deleting history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'large-archive-')); const file = join(dir, 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  const legacy = JSON.stringify({ event: 'startup', hostId: 'historical', os: 'linux', version: '0.6.0', ts: fixture.ts, pad: 'x'.repeat(15000) }) + '\n';
  const archive = legacy.repeat(Math.ceil((65 * 1024 * 1024) / Buffer.byteLength(legacy)));
  writeFileSync(file, archive);
  let child;
  try {
    child = await start(port, file);
    const send = () => fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) });
    assert.equal((await send()).status, 202);
    await stop(child); child = await start(port, file);
    assert.equal((await send()).status, 202);
    const content = readFileSync(file, 'utf8');
    assert.ok(content.startsWith(archive));
    assert.equal(content.slice(archive.length).trim().split('\n').length, 1);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('failed storage never acknowledges or remembers an event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-fail-')); const file = join(dir, 'missing', 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  let child;
  try {
    child = await start(port, file, true);
    const r = await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) });
    assert.equal(r.status, 503);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

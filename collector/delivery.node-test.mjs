import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const fixture = { schemaVersion: 1, eventId: '550e8400-e29b-41d4-a716-446655440000', event: 'startup', hostId: 'fixture', os: 'linux', version: '0.6.0', ts: '2026-10-21T00:00:00.000Z' };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function start(port, file) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url))], { env: { ...process.env, PORT: String(port), TELEMETRY_FILE: file }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return child; } catch {} await delay(25); }
  throw Error('collector not ready');
}
async function stop(child) { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
test('versioned receipt deduplicates after a real collector process restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-')); const file = join(dir, 'events.jsonl');
  const port = 18000 + Math.floor(Math.random() * 30000);
  let child;
  try {
    child = await start(port, file);
    const send = () => fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) });
    let r = await send(); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { ok: true, eventId: fixture.eventId });
    await stop(child); child = await start(port, file);
    r = await send(); assert.equal(r.status, 202); assert.deepEqual(await r.json(), { ok: true, eventId: fixture.eventId });
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify({ ...fixture, eventId: 'not-id' }) })).status, 422);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});
test('failed storage never acknowledges or remembers an event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delivery-fail-')); const file = join(dir, 'missing', 'events.jsonl'); const port = 18000 + Math.floor(Math.random() * 30000);
  let child;
  try {
    child = await start(port, file);
    const r = await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: 'POST', body: JSON.stringify(fixture) });
    assert.equal(r.status, 500);
  } finally { if (child) await stop(child); rmSync(dir, { recursive: true, force: true }); }
});

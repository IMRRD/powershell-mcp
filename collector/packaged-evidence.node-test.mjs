import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installEvidence } from './fixtures/packaged-evidence.mjs';
import { runClient, waitFor } from './fixtures/packaged-process.mjs';

async function fixture(body) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('npm evidence allowlists numeric phases and rejects secrets, identities and arbitrary keys', () => fixture(dir => {
  const logs = join(dir, 'logs'); mkdirSync(logs);
  const secret = 'SECRET-token-user-host-C:\\Users\\private';
  writeFileSync(join(logs, 'fixture-timing.json'), JSON.stringify({ command: [secret], timers: { npm: 123, 'idealTree:buildDeps': 45, [secret]: 9, reify: secret, 'command:install': -1, 'reify:build': Infinity }, unfinishedTimers: { [secret]: [1, 2] } }));
  writeFileSync(join(logs, 'fixture-debug-0.log'), `0 verbose cwd ${secret}\n1 verbose argv ${secret}\n2 timing reify Completed in 12ms\n3 timing ${secret} Completed in 9ms\n4 verbose exit 0\n`);
  const evidence = installEvidence(join(dir, 'safe.json'));
  evidence.npm(logs);
  const result = JSON.parse(readFileSync(join(dir, 'safe.json')));
  assert.deepEqual(result.npm, { timing: { npm: 123, 'idealTree:buildDeps': 45 }, debugTiming: { reify: 12 }, exitCode: 0 });
  assert.equal(JSON.stringify(result).includes(secret), false);
}));
test('malformed oversized or missing npm evidence never becomes raw fallback', () => fixture(dir => {
  const logs = join(dir, 'logs'); mkdirSync(logs);
  writeFileSync(join(logs, 'bad-timing.json'), '{secret');
  writeFileSync(join(logs, 'huge-debug-0.log'), 'secret'.repeat(50000));
  const evidence = installEvidence(join(dir, 'safe.json'));
  evidence.npm(logs); evidence.npm(join(dir, 'absent'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'safe.json'))).npm, { timing: {}, debugTiming: {} });
  assert.ok(readFileSync(join(dir, 'safe.json')).length < 4096);
}));
test('successful install evidence survives later proof and cleanup failures outside removed fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  const file = join(dir, 'safe.json'), logs = join(dir, 'fixture'); mkdirSync(logs);
  const evidence = installEvidence(file), primary = Error('secret proof failure');
  try {
    writeFileSync(join(logs, 'ok-timing.json'), '{"timers":{"command:install":12}}');
    await evidence.measure('install', async () => {}); evidence.npm(logs);
    await assert.rejects(evidence.measure('proof', async () => { throw primary; }), e => e === primary);
    await assert.rejects(evidence.measure('collectorClose', async () => { throw primary; }), e => e === primary);
    await evidence.measure('directoryRemove', () => rmSync(logs, { recursive: true }));
    const result = JSON.parse(readFileSync(file));
    assert.equal(result.npm.timing['command:install'], 12);
    for (const phase of ['install', 'proof', 'collectorClose', 'directoryRemove']) assert.ok(result.phases[phase].durationMs >= 0);
    assert.equal(result.phases.proof.status, 'failed');
    assert.equal(result.phases.directoryRemove.status, 'completed');
    assert.equal(readFileSync(file, 'utf8').includes(primary.message), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('diagnostic write failure preserves cancellation identity and started phase snapshot', async () => fixture(async dir => {
  const file = join(dir, 'safe.json'), evidence = installEvidence(file);
  const finish = evidence.start('proxyClose');
  assert.equal(JSON.parse(readFileSync(file)).phases.proxyClose.status, 'started'); finish();
  const unavailable = installEvidence(join(dir, 'absent', 'safe.json'));
  const controller = new AbortController(), reason = Error('private cancellation'); controller.abort(reason);
  await assert.rejects(unavailable.measure('proof', () => controller.signal.throwIfAborted()), e => e === reason);
}));

test('held client proof preserves its ACK checkpoint and closes before diagnostic failure returns', { timeout: 10000 }, async t => fixture(async dir => {
  const file = join(dir, 'safe.json'), evidence = installEvidence(file);
  const primary = Error('private fixture proof failure');
  const controller = new AbortController();
  let enter, release, child;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await evidence.measure('install', async () => {});
  const result = evidence.measure('wrongAckClient', () => runClient('', {}, async c => {
    child = c;
    await evidence.measure('retainedClaim', async () => { enter(); await held; throw primary; });
  }, { signal: AbortSignal.any([t.signal, controller.signal]), measure: evidence.measure })).then(() => null, e => e);
  try {
    await waitFor(entered, { signal: t.signal, timeout: 3000 });
    const pending = JSON.parse(readFileSync(file));
    assert.equal(pending.phases.install.status, 'completed');
    assert.equal(pending.phases.wrongAckClient?.status, 'started');
    assert.equal(pending.phases.clientReady?.status, 'completed');
    assert.equal(pending.phases.clientProof?.status, 'started');
    assert.equal(pending.phases.retainedClaim?.status, 'started');
    assert.equal(pending.phases.clientRelease, undefined);
    release();
    assert.equal(await result, primary, 'diagnostics retain the original proof error');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned child closed before returning');
    const finished = JSON.parse(readFileSync(file));
    for (const phase of ['wrongAckClient', 'clientProof', 'retainedClaim']) assert.equal(finished.phases[phase].status, 'failed');
    assert.equal(finished.phases.clientClose.status, 'completed');
    assert.equal(JSON.stringify(finished).includes(primary.message), false);
    evidence.start(primary.message)();
    assert.equal(JSON.stringify(JSON.parse(readFileSync(file))).includes(primary.message), false);
    assert.ok(readFileSync(file).length <= 8192);
  } finally {
    release(); controller.abort(Error('proof regression scope closed')); await result;
  }
}));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { aggregate, classify, suppress } from './report.js';
const script = fileURLToPath(new URL('./report.js', import.meta.url));
function fixture(lines, config = { internalHostIds: ['internal-id'], testHostIds: ['test-id'] }, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'adoption-fixture-'));
  try {
    const data = join(dir, 'events.jsonl'), ids = join(dir, 'private.json');
    writeFileSync(data, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
    writeFileSync(ids, JSON.stringify(config));
    const result = spawnSync(process.execPath, [script, '--file', data, '--classification', ids, '--from', '2026-10-01T00:00:00.000Z', '--to', '2026-10-08T00:00:00.000Z', ...args], { encoding: 'utf8', env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1' } });
    if (result.status === 0) result.raw = JSON.parse(JSON.stringify(aggregate(lines.map(x=>JSON.stringify(x)).join('\n'), classify(JSON.stringify(config)), '2026-10-01T00:00:00.000Z', '2026-10-08T00:00:00.000Z')));
    return result;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const event = (hostId, eventName, ts, extra = {}) => ({ hostId, event: eventName, ts, version: '0.5.3', os: 'win32', ...extra });
test('offline report deduplicates hosts and segregates internal, test and unknown origin', () => {
  const result = fixture([
    event('internal-id', 'startup', '2026-10-01T00:00:00.000Z'),
    event('internal-id', 'tool_counts', '2026-10-02T00:00:00.000Z', { counts: { run_program: 2 } }),
    event('test-id', 'startup', '2026-10-02T00:00:00.000Z'),
    event('unknown-secret', 'startup', '2026-10-03T00:00:00.000Z'),
    event('unknown-secret', 'tool_counts', '2026-10-03T00:00:00.000Z', { counts: { ssh_exec: 3 } }),
    event('outside-secret', 'startup', '2026-10-08T00:00:00.000Z'),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const r = result.raw;
  assert.deepEqual(r.groups.internal, { observedInstallations: 1, activeInstallations: 1, startupOnlyInstallations: 0, coveredInstallations: 0, unknownUserInstallations: 1, userProxies: 0, versions: { '0.5.3': 1 }, os: { win32: 1 }, toolCounts: { run_program: 2 }, toolMetrics: {} });
  assert.equal(r.groups.test.observedInstallations, 1);
  assert.equal(r.groups.unknownOrigin.observedInstallations, 1);
  assert.equal(r.groups.unknownOrigin.activeInstallations, 1);
  assert.equal(r.groups.unknownOrigin.toolCounts.ssh_exec, 3);
  assert.equal(r.groups.externalUsers, undefined);
  assert.equal(JSON.parse(result.stdout).withheld, true);
  assert.equal(JSON.parse(result.stdout).groups, undefined);
  assert.doesNotMatch(result.stdout + result.stderr, /internal-id|test-id|unknown-secret|outside-secret/);
});
test('versioned metric outcomes, durations and features aggregate without doubling legacy counts', () => {
  const row = event('internal-id','tool_metrics','2026-10-02T00:00:00.000Z', { schemaVersion: 2, eventId: '12345678-1234-4234-8234-123456789012', metrics: { runtime_capabilities: { outcomes: { success: 2 }, durations: { lt100: 2 }, features: { inspection: 2 } } } });
  const result = fixture([row, event('internal-id','tool_counts','2026-10-02T00:00:00.000Z',{ counts: { runtime_capabilities: 2 } })]);
  assert.equal(result.status, 0, result.stderr);
  const group = result.raw.groups.internal;
  assert.equal(group.toolCounts.runtime_capabilities, 2);
  assert.deepEqual(group.toolMetrics.runtime_capabilities, row.metrics.runtime_capabilities);
  assert.equal(group.activeInstallations, 1);
  const bad = fixture([{ ...row, metrics: { runtime_capabilities: { ...row.metrics.runtime_capabilities, secret: 'private' } } }]);
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, '');
  const winrm = (host, reasons) => event(host, 'tool_metrics', '2026-10-02T00:00:00.000Z', {
    schemaVersion: 2, metrics: { winrm_exec: { outcomes: { error: 20 }, durations: { lt100: 20 }, features: { remote: 20 },
      ...(reasons === undefined ? {} : { winrmReasons: reasons }) } } });
  const rows = Array.from({length: 20}, (_, i) => winrm('synthetic-' + i, i < 10 ? {unknown: 20} : undefined));
  const mixed = fixture(rows);
  assert.equal(mixed.status, 0, mixed.stderr);
  const metrics = mixed.raw.groups.unknownOrigin.toolMetrics.winrm_exec;
  assert.deepEqual(metrics.outcomes, {error: 400});
  assert.deepEqual(metrics.winrmReasons, {unknown: 200, uninstrumented: 200});
  assert.equal(JSON.parse(mixed.stdout).withheld, false);
  for (const reason of ['completed','remote_script_error','authentication_exception','access_exception',
    'remoting_transport_exception','invoke_exception','wrapper_result_invalid','frame_invalid',
    'frame_body_invalid','local_host_error','local_launch_error','timeout','cancelled','unknown']) {
    const positive = fixture([winrm('synthetic', {[reason]: 20})]);
    assert.equal(positive.status, 0, reason);
    assert.equal(positive.raw.groups.unknownOrigin.toolMetrics.winrm_exec.winrmReasons[reason], 20);
  }
  for (const invalid of [{}, {PRIVATE: 20}, {unknown: true}, {unknown: 0}, {unknown: -1}, {unknown: 1.5},
                         {unknown: 19}, {unknown: 21}, {uninstrumented: 20}, [], null, {unknown: Number.MAX_SAFE_INTEGER, completed: 1}]) {
    const refused = fixture([winrm('synthetic', invalid)]);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
    assert.doesNotMatch(refused.stderr, /PRIVATE|synthetic/);
  }
  const wrong = winrm('synthetic', {unknown: 20});
  wrong.metrics.ssh_exec = wrong.metrics.winrm_exec;
  delete wrong.metrics.winrm_exec;
  for (const invalid of [wrong,
    {...winrm('synthetic', {unknown: 20}), command: 'PRIVATE'},
    {...winrm('synthetic', {unknown: 20}), metrics: {winrm_exec: {...winrm('synthetic').metrics.winrm_exec, secret: 'PRIVATE'}}}]) {
    const refused = fixture([invalid]);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.stdout, '');
    assert.doesNotMatch(refused.stderr, /PRIVATE/);
  }
  // All reason and outcome cells are safe, but error(21)-known(20)=1.
  const complement = Array.from({length: 41}, (_, i) => {
    const row = winrm('synthetic-' + i, i < 20 ? {invoke_exception: 1} : {unknown: 1});
    Object.assign(row.metrics.winrm_exec, {outcomes: {[i < 21 ? 'error' : 'success']: 1}, durations: {lt100: 1}, features: {remote: 1}});
    return row;
  });
  const withheld = fixture(complement);
  assert.equal(withheld.status, 0, withheld.stderr);
  assert.equal(JSON.parse(withheld.stdout).withheld, true);
  assert.doesNotMatch(withheld.stdout, /invoke_exception/);
  // Above-threshold remainder is still disclosed.
  for (let i = 21; i < 30; i++) complement[i].metrics.winrm_exec.outcomes = {error: 1};
  assert.equal(JSON.parse(fixture(complement).stdout).withheld, false);
  for (const kind of ['reason_cell', 'uninstrumented']) {
    const sparse = Array.from({length: 20}, (_, i) => winrm('synthetic-' + i, {invoke_exception: 20}));
    if (kind === 'reason_cell') sparse[0].metrics.winrm_exec.winrmReasons = {invoke_exception: 19, unknown: 1};
    else {
      const legacy = winrm('synthetic-0');
      Object.assign(legacy.metrics.winrm_exec, {outcomes: {error: 1}, durations: {lt100: 1}, features: {remote: 1}});
      sparse.push(legacy);
    }
    const refused = fixture(sparse);
    assert.equal(refused.status, 0);
    assert.equal(JSON.parse(refused.stdout).withheld, true);
    assert.doesNotMatch(refused.stdout, /invoke_exception/);
  }
});

test('ambiguous classification and invalid windows fail closed', () => {
  const row = event('private-id', 'startup', '2026-10-01T00:00:00.000Z');
  for (const [classification, args] of [
    [{ internalHostIds: ['private-id'], testHostIds: ['private-id'] }, []],
    [{ internalHostIds: [], testHostIds: [] }, ['--unexpected', 'value']],
    [{ internalHostIds: [], testHostIds: [] }, ['--to', '2026-10-09T00:00:00.000Z']],
  ]) {
    const result = fixture([row], classification, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /private-id/);
  }
});

test('malformed input fails closed without partial report or leaking input', () => {
  const result = fixture([event('secret-identifier', 'startup', '2026-10-01T00:00:00.000Z'), { hostId: 'secret-identifier', event: 'tool_counts', ts: 'bad', counts: { x: 1 } }]);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /secret-identifier/);
});
test('repeat deliveries deduplicate identities but retain each tool-count record', () => {
  const row = event('unknown-secret', 'tool_counts', '2026-10-03T00:00:00.000Z', { counts: { ssh_exec: 3 } });
  const result = fixture([row, row]);
  assert.equal(result.status, 0, result.stderr);
  const group = result.raw.groups.unknownOrigin;
  assert.equal(group.observedInstallations, 1);
  assert.equal(group.toolCounts.ssh_exec, 6);
});
test('untrusted version labels never appear in output while canonical versions aggregate', () => {
  const secret = 'privateCustomerToken12345';
  const result = fixture([
    event('one', 'startup', '2026-10-01T00:00:00.000Z', { version: `0.5.3-${secret}` }),
    event('two', 'startup', '2026-10-01T00:00:00.000Z', { version: '0.5.3' }),
    event('three', 'startup', '2026-10-01T00:00:00.000Z', { version: 'untrusted label' }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.raw.groups.unknownOrigin.versions, { other: 2, '0.5.3': 1 });
  assert.doesNotMatch(result.stdout + result.stderr, /privateCustomerToken12345|untrusted label/);
});
test('earliest-event version also collapses untrusted labels and invalid category keys fail closed', () => {
  const secret = 'privateCustomerToken12345';
  const result = fixture([
    event('one', 'startup', '2026-10-03T00:00:00.000Z', { version: '0.5.3' }),
    event('one', 'startup', '2026-10-01T00:00:00.000Z', { version: `0.5.3-${secret}` }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.raw.groups.unknownOrigin.versions, { other: 1 });
  assert.doesNotMatch(result.stdout + result.stderr, /privateCustomerToken12345/);
  for (const bad of [{ os: secret }, { event: secret }, { counts: { [secret]: 1 }, event: 'tool_counts' }]) {
    const failed = fixture([event('one', 'startup', '2026-10-01T00:00:00.000Z', bad)]);
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout, '');
    assert.doesNotMatch(failed.stderr, /privateCustomerToken12345/);
  }
});

test('optional shared random user tokens, unknown coverage, conflicts and complementary suppression', () => {
  const token = '12345678-1234-4234-8234-123456789abc';
  const result = fixture([
    event('a', 'startup', '2026-10-01T00:00:00.000Z', { userId: token, cohort: 'external_self_declared' }),
    event('b', 'startup', '2026-10-01T00:00:00.000Z', { userId: token, cohort: 'external_self_declared' }),
    event('legacy', 'startup', '2026-10-01T00:00:00.000Z'),
    event('internal-id', 'startup', '2026-10-01T00:00:00.000Z', { cohort: 'external_self_declared' }),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.raw.groups.externalSelfDeclared.userProxies, 1);
  assert.equal(result.raw.groups.externalSelfDeclared.coveredInstallations, 2);
  assert.equal(result.raw.groups.unknownOrigin.unknownUserInstallations, 1);
  assert.equal(result.raw.groups.cohortConflict.observedInstallations, 1);
  assert.doesNotMatch(result.stdout, /12345678|internal-id/);
  const g = { observedInstallations: 22, activeInstallations: 11, startupOnlyInstallations: 10, coveredInstallations: 0, unknownUserInstallations: 22, userProxies: 0, versions: {}, os: {}, toolCounts: {}, toolMetrics: {} };
  assert.equal(suppress({ windowUtc: {}, groups: { unknownOrigin: g } }).withheld, true);
});

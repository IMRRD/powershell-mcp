import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordTool, flushCounters, telemetryStatus } from '../dist/telemetry.js';
import { instrumentTool } from '../dist/tool-instrumentation.js';
import { validQueuedEvent } from '../dist/telemetry-wire.js';
const id = '12345678-1234-4234-8234-123456789012';
const base = { schemaVersion: 2, eventId: id, hostId: id, event: 'tool_metrics', version: '0.6.0', os: process.platform, ts: new Date().toISOString() };

test('all registered tools have bounded safe classifications and outcomes', async () => {
  const names = ['run_powershell','list_services','get_service','control_service','system_info','ssh_exec','winrm_exec','sftp_upload','sftp_download','run_program','runtime_capabilities','start_execution','execution_status','read_execution_output','cancel_execution','read_output_log','delete_output_log'];
  const outcomes = [];
  for (const name of names) {
    const handler = instrumentTool(name, async () => ({ structuredContent: { terminationStatus: 'nonzero_exit', target: 'private-host', stdout: 'secret' }, content: [] }), (_n, o, b, f) => outcomes.push([name,o,b,f]));
    await handler({});
  }
  assert.equal(outcomes.length, 17);
  assert.ok(outcomes.every(x => x[1] === 'nonzero' && ['lt100','lt1000','lt10000','gte10000'].includes(x[2]) && ['execution','inspection','remote','transfer','lifecycle','logs'].includes(x[3])));
  assert.equal(JSON.stringify(outcomes).includes('private-host'), false);
});
test('exactly once on throw, timeout, cancellation and pending job polls', async () => {
  const rows = [];
  const capture = (_n,o) => rows.push(o);
  await assert.rejects(instrumentTool('run_program', async () => { throw Error('secret'); }, capture)({}));
  await instrumentTool('run_program', async () => ({structuredContent:{terminationStatus:'timeout'}}), capture)({});
  await instrumentTool('run_program', async () => ({structuredContent:{terminationStatus:'cancelled'}}), capture)({});
  await instrumentTool('execution_status', async () => ({content:[{type:'text',text:JSON.stringify({state:'running', stdout:'secret'})}]}), capture)({});
  await instrumentTool('execution_status', async () => ({content:[{type:'text',text:JSON.stringify({state:'reserved'})}]}), capture)({});
  await instrumentTool('execution_status', async () => ({content:[{type:'text',text:JSON.stringify({state:'completed', exitCode:7})}]}), capture)({});
  assert.deepEqual(rows, ['error','timeout','cancelled','unknown','unknown','nonzero']);
});
test('schema 2 rejects arbitrary keys and invalid buckets while retaining schema 1', () => {
  const event = { ...base, metrics: { run_program: { outcomes: { success: 1 }, durations: { lt100: 1 }, features: { execution: 1 } } } };
  assert.equal(validQueuedEvent(event,id), true);
  assert.equal(validQueuedEvent({ ...event, command: 'secret' },id), false);
  assert.equal(validQueuedEvent({ ...event, metrics: { run_program: { outcomes: { secret: 1 }, durations: { lt100: 1 }, features: { execution: 1 } } } },id), false);
  assert.equal(validQueuedEvent({ ...event, metrics: { run_program: { outcomes: { success: 1 }, durations: { secret: 1 }, features: { execution: 1 } } } },id), false);
  assert.equal(validQueuedEvent({ ...event, metrics: { run_program: { outcomes: { success: 1 }, durations: { lt100: 1 }, features: { execution: 1 }, host: 'private' } } },id), false);
  assert.equal(validQueuedEvent({ ...event, metrics: { run_program: { outcomes: { success: 1 }, durations: { lt100: 2 }, features: { execution: 1 } } } },id), false);
  assert.equal(validQueuedEvent({ ...event, event: 'tool_counts', schemaVersion: 1, counts: { run_program: 1 }, metrics: undefined },id), false);
});
test('optout does not create filesystem state for metric recording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metric-optout-'));
  try {
    const code = `import {recordTool,flushCounters} from ${JSON.stringify(new URL('../dist/telemetry.js',import.meta.url).href)}; recordTool('run_program','success','lt100','execution'); flushCounters('0.6.0');`;
    const result = spawnSync(process.execPath,['--input-type=module','-e',code],{env:{...process.env,HOME:dir,USERPROFILE:dir,POWERSHELL_MCP_NO_TELEMETRY:'1'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(readdirSync(dir).length,0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

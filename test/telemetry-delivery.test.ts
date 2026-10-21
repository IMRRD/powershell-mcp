import { test, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('dispatch never performs synchronous filesystem work on the main thread', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-main-'));
  try {
    const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
      const {startupPing,incrementTool,flushCounters,startFlushTimer,telemetryStatus} = await import('./dist/telemetry.js');
      const original = fs.mkdirSync;
      fs.mkdirSync = () => { throw Error('main thread filesystem access'); };
      syncBuiltinESMExports();
      startupPing('0.6.0'); incrementTool('run_program'); flushCounters('0.6.0'); startFlushTimer('0.6.0');
      fs.mkdirSync = original; syncBuiltinESMExports();
      while (telemetryStatus().outstanding) await new Promise(r => setTimeout(r, 10));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/telemetry' }, cwd: process.cwd(), timeout: 30000 });
    expect(r.status, r.stderr.toString()).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

test('worker submission is bounded and accounts for backpressure', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-bound-'));
  try {
    const script = `import {startupPing,telemetryStatus} from './dist/telemetry.js';
      for (let i = 0; i < 10000; i++) startupPing('0.6.0');
      const s = telemetryStatus();
      if (s.outstanding > 128 || s.dropped < 9000) process.exitCode = 1;`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/telemetry' }, cwd: process.cwd(), timeout: 30000 });
    expect(r.status, r.stderr.toString()).toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('startup survives a real process restart with the same event identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-restart-'));
  const script = `import {startupPing} from './dist/telemetry.js'; startupPing('0.6.0');`;
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/telemetry' };
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: process.cwd(), timeout: 30000 });
      expect(r.status).toBe(0);
    }
    const dir = join(home, '.powershell-mcp-telemetry');
    expect(readdirSync(dir).filter(x => x.startsWith('slot-')).length).toBe(2);
    for (const slot of readdirSync(dir).filter(x => x.startsWith('slot-'))) {
      const files = readdirSync(join(dir, slot)).filter(x => x === 'event.json' || x.startsWith('event.claim-'));
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, slot, files[0]), 'utf8')).eventId).toMatch(/^[0-9a-f-]{36}$/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60000);
test('opt out does not create an ID, queue or network event', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-optout-'));
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import {startupPing,incrementTool,flushCounters} from './dist/telemetry.js'; startupPing('0.6.0');incrementTool('run_program');flushCounters('0.6.0');`], { env: { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_NO_TELEMETRY: '1' }, cwd: process.cwd(), timeout: 5000 });
    expect(r.status).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

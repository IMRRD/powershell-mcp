import { test, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('startup survives a real process restart with the same event identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-restart-'));
  const script = `import {startupPing} from './dist/telemetry.js'; startupPing('0.6.0');`;
  try {
    const env = { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/telemetry' };
    for (let i = 0; i < 2; i++) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, cwd: process.cwd(), timeout: 5000 });
      expect(r.status).toBe(0);
    }
    const dir = join(home, '.powershell-mcp-telemetry');
    expect(readdirSync(dir).filter(x => x.endsWith('.json')).length).toBe(2);
    for (const file of readdirSync(dir).filter(x => x.endsWith('.json'))) {
      expect(JSON.parse(readFileSync(join(dir, file), 'utf8')).eventId).toMatch(/^[0-9a-f-]{36}$/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('opt out does not create an ID, queue or network event', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-optout-'));
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import {startupPing,incrementTool,flushCounters} from './dist/telemetry.js'; startupPing('0.6.0');incrementTool('run_program');flushCounters('0.6.0');`], { env: { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_NO_TELEMETRY: '1' }, cwd: process.cwd(), timeout: 5000 });
    expect(r.status).toBe(0);
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

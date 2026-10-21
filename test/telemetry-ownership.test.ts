import { test, expect } from 'vitest';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const script = `import {startupPing,telemetryStatus} from './dist/telemetry.js'; startupPing('0.6.0'); while(telemetryStatus().outstanding) await new Promise(r=>setTimeout(r,20));`;
function env(home: string) { return { ...process.env, USERPROFILE: home, HOME: home, POWERSHELL_MCP_NO_TELEMETRY: '0', POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/telemetry' }; }
test('concurrent producers reserve separate slots without overwriting data', async () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-concurrent-'));
  try {
    const children = Array.from({ length: 8 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { env: env(home), cwd: process.cwd(), stdio: 'ignore' }));
    expect(await Promise.all(children.map(async c => (await once(c, 'exit'))[0]))).toEqual(Array(8).fill(0));
    const root = join(home, '.powershell-mcp-telemetry');
    const slots = readdirSync(root).filter(x => /^slot-\d{3}$/.test(x));
    expect(slots).toHaveLength(8);
    const ids = slots.map(s => {
      const names = readdirSync(join(root, s)).filter(x => x === 'event.json' || x.startsWith('event.claim-'));
      expect(names).toHaveLength(1);
      return JSON.parse(readFileSync(join(root, s, names[0]), 'utf8')).eventId;
    });
    expect(new Set(ids).size).toBe(8);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60000);
test('oversized and corrupt slots consume capacity but cannot be sent', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-corrupt-'));
  try {
    const root = join(home, '.powershell-mcp-telemetry');
    mkdirSync(root, { mode: 0o700 });
    for (let i = 0; i < 128; i++) {
      const dir = join(root, `slot-${String(i).padStart(3, '0')}`);
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, 'event.json'), i === 0 ? 'x'.repeat(16385) : '{invalid');
    }
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: env(home), cwd: process.cwd(), timeout: 15000 }).status).toBe(0);
    expect(readdirSync(root)).toHaveLength(128);
    expect(readFileSync(join(root, 'slot-000', 'event.json'), 'utf8')).toHaveLength(16385);
    expect(readFileSync(join(root, 'slot-001', 'event.json'), 'utf8')).toBe('{invalid');
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);
test.skipIf(process.platform !== 'win32')('Windows rejects inherited ACL store without modifying it', () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-acl-'));
  try {
    const root = join(home, '.powershell-mcp-telemetry');
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: env(home), cwd: process.cwd(), timeout: 10000 }).status).toBe(0);
    const before = readdirSync(root).length;
    execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [root, '/inheritance:e']);
    expect(spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: env(home), cwd: process.cwd(), timeout: 10000 }).status).toBe(0);
    expect(readdirSync(root).length).toBe(before);
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30000);

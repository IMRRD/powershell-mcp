import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const module = new URL('../dist/telemetry.js', import.meta.url).href;
for (const mode of process.platform === 'win32' ? ['natural'] : ['natural', 'SIGTERM']) test(`counter survives ${mode} without collector ACK`, { timeout: 15000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'telemetry-exit-'));
  const code = `import { incrementTool, startFlushTimer } from ${JSON.stringify(module)}; startFlushTimer('0.6.0'); incrementTool('run_program'); ${mode === 'natural' ? '' : "console.error('armed'); setInterval(() => {}, 1000);"}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home, USERPROFILE: home, POWERSHELL_MCP_NO_TELEMETRY: '0', POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/api/telemetry' }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    let stderr = '';
    child.stderr.on('data', b => { stderr += b; if (mode === 'SIGTERM' && stderr.includes('armed')) child.kill('SIGTERM'); });
    const result = await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(Error('child hung')), 9000))]);
    assert.equal(result[0], mode === 'natural' ? 0 : 143, stderr);
    const root = join(home, '.powershell-mcp-telemetry');
    const records = readdirSync(root).filter(n => n.startsWith('slot-')).flatMap(n => readdirSync(join(root, n)).map(f => JSON.parse(readFileSync(join(root, n, f), 'utf8'))));
    assert.equal(records.filter(r => r.event === 'tool_counts' && r.counts?.run_program === 1).length, 1);
  } finally { child.kill(); rmSync(home, { recursive: true, force: true }); }
});

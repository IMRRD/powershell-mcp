import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFixturePids, witnessFixturePid } from './fixture-pids.mjs';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The same native acceptance can exercise an installed tarball, without resolving
// the server or its helpers from this checkout.
it('native MCP cancellation stops the owned program tree and preserves an unrelated sentinel', async () => {
  const base = mkdtempSync(join(tmpdir(), 'program-cancel-'));
  const marker = join(base, 'pids'), entry = join(base, 'tree.cjs');
  writeFileSync(entry, `const {spawn}=require('node:child_process');const fs=require('node:fs');
const [role,marker]=process.argv.slice(2);fs.appendFileSync(marker,role+':'+process.pid+'\\n');
if(role==='root')spawn(process.execPath,[__filename,'child',marker],{stdio:'ignore',detached:process.platform==='linux'}).unref();
setTimeout(()=>{},20000);`);
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const client = new Client({ name: 'native-cancellation', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(process.env.MCP_TEST_PACKAGE_ROOT ?? process.cwd(), 'dist/index.js')],
    env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_EXEC_PARENT: base }, stderr: 'pipe' });
  const abort = new AbortController();
  let pending: Promise<unknown> | undefined;
  let pids: number[] = [];
  try {
    await client.connect(transport);
    pending = client.callTool({ name: 'run_program', arguments: { program: process.execPath, args: [entry, 'root', marker] } }, undefined,
      { signal: abort.signal, timeout: 30000 }).catch(error => error);
    await expect.poll(() => {
      try { pids = parseFixturePids(readFileSync(marker, 'utf8'), ['root', 'child']) ?? []; } catch { /* startup */ }
      return pids.length;
    }, { timeout: 15000, interval: 25 }).toBe(2);
    expect(pids.every(pid => Number.isInteger(pid) && pid > 0 && alive(pid))).toBe(true);
    for (const pid of pids) witnessFixturePid(pid, marker);
    const started = Date.now();
    abort.abort();
    await pending;
    await expect.poll(() => pids.map(alive), { timeout: 7500, interval: 25 }).toEqual([false, false]);
    expect(Date.now() - started).toBeLessThan(8500);
    expect(alive(sentinel.pid!)).toBe(true);
    const after = await client.callTool({ name: 'run_program', arguments: { program: process.execPath, args: ['-e', 'process.stdout.write("after-cancel")'] } });
    expect(after.isError).not.toBe(true);
    expect(after.structuredContent?.stdout).toBe('after-cancel');
  } finally {
    abort.abort();
    await pending;
    await client.close();
    sentinel.kill();
    // Even the RED implementation must clean up through the fixture's natural
    // 20 second lifetime; don't mask the cancellation assertion with teardown.
    await expect.poll(() => pids.some(alive), { timeout: 25000, interval: 25 }).toBe(false);
    rmSync(base, { recursive: true, force: true });
  }
}, 45000);

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { PsResult } from '../src/powershell.js';
import { selectIntegrationEngines } from './integration-engine.js';
import { parseFixturePids, witnessFixturePid } from './fixture-pids.mjs';

// Reuse the actual native acceptance against a freshly installed tarball. The
// artifact lane imports only installed production modules and their helpers.
const moduleUrl = (name: string) => process.env.MCP_TEST_PACKAGE_ROOT
  ? pathToFileURL(join(process.env.MCP_TEST_PACKAGE_ROOT, 'dist', `${name}.js`)).href
  : new URL(`../src/${name}.ts`, import.meta.url).href;
const { runProgram } = await import(moduleUrl('program')) as typeof import('../src/program.js');
const { runPowerShell } = await import(moduleUrl('powershell')) as typeof import('../src/powershell.js');
const { ExecutionStore } = await import(moduleUrl('execution-lifecycle')) as typeof import('../src/execution-lifecycle.js');

const engine = selectIntegrationEngines()[0]!.exe;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const callers = ['program', 'legacy', 'strict', 'durable'] as const;

describe('native program lifecycle families', () => {
  for (const caller of callers) for (const action of ['complete', 'cancel', 'timeout'] as const) {
    if (caller === 'durable' && action === 'timeout') continue; // Durable has explicit cancellation, no synchronous deadline.
    it(`${caller} ${action} waits for a child after its root exits and preserves a sentinel`, async () => {
      const base = mkdtempSync(join(tmpdir(), 'root-before-child-'));
      const marker = join(base, 'pids'), entry = join(base, 'tree.cjs');
      writeFileSync(entry, `const {spawn}=require('node:child_process');const fs=require('node:fs');
const [role,marker]=process.argv.slice(2);fs.appendFileSync(marker,role+':'+process.pid+'\\n');
if(role==='root'){spawn(process.execPath,[__filename,'child',marker],{stdio:['ignore',1,2],detached:true,windowsHide:true}).unref();}
else {process.stdout.write('child-ready\\n');setTimeout(()=>{process.stdout.write('child-done\\n');process.stderr.write('child-stderr\\n')},${action === 'complete' ? 2000 : 20000});}`);
      const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
      const abort = new AbortController();
      let store: InstanceType<typeof ExecutionStore> | undefined, id: string | undefined, pending: Promise<PsResult> | undefined;
      let pids: number[] = [];
      let settled = false;
      try {
        // This case requires an observed root exit before the deadline. Give
        // strict Add-Type/engine startup its own fixture allowance; the separate
        // startup tests still enforce 5 seconds and the duration test 60 seconds.
        const opts = { signal: abort.signal, timeoutMs: action === 'timeout' ? 15000 : 60000 };
        if (caller === 'durable') {
          store = new ExecutionStore(join(base, 'store'));
          id = store.start('owner', 'tree', process.execPath, [entry, 'root', marker]).id;
        } else {
          pending = caller === 'program' ? runProgram(process.execPath, [entry, 'root', marker], opts)
            : runPowerShell(`& ${quote(process.execPath)} ${quote(entry)} root ${quote(marker)}`, { ...opts, exe: engine, errorPolicy: caller === 'strict' ? 'strict' : 'legacy' });
          void pending.then(() => { settled = true; });
        }
        await expect.poll(() => {
          try { pids = parseFixturePids(readFileSync(marker, 'utf8'), ['root', 'child']) ?? []; } catch { /* startup */ }
          return pids.length === 2 && !alive(pids[0]) && alive(pids[1]);
        }, { timeout: 15000, interval: 25 }).toBe(true);
        witnessFixturePid(pids[1], marker);
        expect(settled).toBe(false);
        if (store && id) expect(store.status('owner', id).state).toBe('running');
        if (action === 'cancel') { abort.abort(); if (store && id) store.cancel('owner', id); }
        const started = Date.now();
        if (store && id) {
          await expect.poll(() => store!.status('owner', id!).state, { timeout: 7500, interval: 25 }).toBe(action === 'cancel' ? 'cancelled' : 'completed');
          if (action === 'complete') {
            expect(store.status('owner', id)).toMatchObject({ exitCode: 0, outputComplete: true });
            expect(Buffer.from(store.read('owner', id, 'stdout', 0, 128).data, 'base64').toString()).toBe('child-ready\nchild-done\n');
            expect(Buffer.from(store.read('owner', id, 'stderr', 0, 128).data, 'base64').toString()).toBe('child-stderr\n');
          }
        } else {
          const result = await pending!;
          expect(result).toMatchObject({ timedOut: action === 'timeout', cancelled: action === 'cancel', treeTerminated: true });
          if (action === 'timeout') {
            expect(result.durationMs).toBeGreaterThanOrEqual(opts.timeoutMs);
            expect(result.durationMs).toBeLessThan(opts.timeoutMs + 10000);
          }
          if (action === 'complete') {
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toContain('child-done');
            // Strict PowerShell redirects native stderr into its rendered
            // pipeline payload. Direct execution and legacy retain raw stderr.
            if (caller === 'strict') {
              expect(result.stdout).toContain('child-stderr');
              expect(result.stderr).toBe('');
            } else expect(result.stderr).toBe('child-stderr\n');
          } else if (caller !== 'strict') expect(result.stdout).toBe('child-ready\n');
        }
        if (action !== 'timeout') expect(Date.now() - started).toBeLessThan(11000);
        // Root exit was observed before the action. Its PID can already name
        // unrelated work on a busy host; never treat that later PID as ownership.
        expect(alive(pids[1])).toBe(false);
        expect(alive(sentinel.pid!)).toBe(true);
      } finally {
        abort.abort(); if (store && id) store.cancel('owner', id);
        await pending;
        await expect.poll(() => pids.length === 2 && alive(pids[1]), { timeout: 10000, interval: 25 }).toBe(false);
        sentinel.kill();
        rmSync(base, { recursive: true, force: true });
      }
    }, 35000);
  }

  it.each(['timeout', 'cancel'])('a native child blocked on unread stdin still drains output and permits %s', async action => {
    const base = mkdtempSync(join(tmpdir(), 'blocked-input-'));
    const marker = join(base, 'pid');
    const abort = new AbortController();
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    // Synchronous writes exceed each OS pipe's capacity. The child never reads
    // its 1 MiB stdin, so the supervisor's input writer remains blocked.
    const source = `const fs=require('node:fs');const b=Buffer.alloc(65536,120);for(let i=0;i<32;i++){fs.writeSync(1,b);fs.writeSync(2,b)}fs.writeFileSync(process.argv[1],String(process.pid)+'\\n');setInterval(()=>{},1000)`;
    const pending = runProgram(process.execPath, ['-e', source, marker], { stdin: 'i'.repeat(1048576), maxOutputBytes: 7, tail: true,
      timeoutMs: action === 'timeout' ? 5000 : 60000, signal: abort.signal });
    let pid: number | undefined;
    try {
      await expect.poll(() => { try { pid = parseFixturePids(readFileSync(marker, 'utf8'))?.[0]; return pid !== undefined && alive(pid); } catch { return false; } }, { timeout: 15000, interval: 25 }).toBe(true);
      witnessFixturePid(pid!, marker);
      // The marker follows both write loops, so cancellation cannot race setup.
      if (action === 'cancel') abort.abort();
      const result = await pending;
      expect(result).toMatchObject({ timedOut: action === 'timeout', cancelled: action === 'cancel', treeTerminated: true,
        stdout: 'xxxxxxx', stderr: 'xxxxxxx', truncated: true,
        stdoutCapture: { observedBytes: 2097152, capturedBytes: 7, omittedBytes: 2097145 },
        stderrCapture: { observedBytes: 2097152, capturedBytes: 7, omittedBytes: 2097145 } });
      expect(alive(pid!)).toBe(false);
      expect(alive(sentinel.pid!)).toBe(true);
    } finally { abort.abort(); await pending; sentinel.kill(); rmSync(base, { recursive: true, force: true }); }
  }, 30000);

  it('legitimate 65 second work keeps the default deadline, supports an explicit deadline and durable idempotency without replay', async () => {
    const base = mkdtempSync(join(tmpdir(), 'legitimate-duration-'));
    const store = new ExecutionStore(join(base, 'store'));
    const source = (marker: string) => `require('node:fs').appendFileSync(${JSON.stringify(marker)},'start\\n');process.stdout.write('started\\n');setTimeout(()=>process.stdout.write('done\\n'),65000)`;
    const args = ['-e', source(join(base, 'durable'))];
    const run = store.start('owner', 'long-intent', process.execPath, args);
    const normal = runProgram(process.execPath, ['-e', source(join(base, 'default'))]);
    const explicit = runProgram(process.execPath, ['-e', source(join(base, 'explicit'))], { timeoutMs: 75000 });
    try {
      await expect.poll(() => store.status('owner', run.id).stdoutBytes, { timeout: 15000 }).toBe(8);
      expect(store.start('owner', 'long-intent', process.execPath, args).id).toBe(run.id);
      const timed = await normal;
      expect(timed).toMatchObject({ timedOut: true, treeTerminated: true, stdout: 'started\n' });
      expect(timed.durationMs).toBeGreaterThanOrEqual(60000);
      expect(timed.durationMs).toBeLessThan(67000);
      expect(store.status('owner', run.id).state).toBe('running');
      const completed = await explicit;
      expect(completed).toMatchObject({ timedOut: false, exitCode: 0, treeTerminated: true, stdout: 'started\ndone\n' });
      await expect.poll(() => store.status('owner', run.id).state, { timeout: 10000 }).toBe('completed');
      expect(store.start('owner', 'long-intent', process.execPath, args).id).toBe(run.id);
      expect(Buffer.from(store.read('owner', run.id, 'stdout', 0, 64).data, 'base64').toString()).toBe('started\ndone\n');
      for (const marker of ['default', 'explicit', 'durable']) expect(readFileSync(join(base, marker), 'utf8')).toBe('start\n');
      console.log(`NATIVE_DURATION default=${timed.durationMs}ms explicit=${completed.durationMs}ms durable=${Date.now() - Date.parse(run.createdAt)}ms`);
    } finally { store.cancel('owner', run.id); await Promise.all([normal, explicit]); rmSync(base, { recursive: true, force: true }); }
  }, 95000);
});

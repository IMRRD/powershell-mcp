import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProgram } from '../src/program.js';
import { runPowerShell } from '../src/powershell.js';
import { ExecutionStore } from '../src/execution-lifecycle.js';
import { fromProcess } from '../src/result.js';

const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
describe('lifecycle acceptance', () => {
  for (const caller of ['program', 'powershell', 'durable'] as const) it(`${caller} cancels parent child grandchild within a bound and preserves unrelated process`, async () => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'acceptance-tree-'));
    const marker = join(base, 'pids'), entry = join(base, 'tree.cjs');
    writeFileSync(entry, `const {spawn}=require('node:child_process');const fs=require('node:fs');const [role,marker]=process.argv.slice(2);fs.appendFileSync(marker,role+':'+process.pid+'\\n');if(role!=='grandchild')spawn(process.execPath,[__filename,role==='parent'?'child':'grandchild',marker],{stdio:'ignore',detached:process.platform==='linux'}).unref();process.stdout.write('before-timeout\\n');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),20000);`);
    const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
    let pids: number[] = [];
    let store: ExecutionStore | undefined, id: string | undefined;
    try {
      let pending;
      if (caller === 'durable') { store = new ExecutionStore(join(base, 'store')); id = store.start('owner', 'tree', process.execPath, [entry, 'parent', marker]).id; }
      else if (caller === 'program') pending = runProgram(process.execPath, [entry, 'parent', marker], { timeoutMs: 5000 });
      else pending = runPowerShell(`& '${process.execPath.replaceAll("'", "''")}' '${entry.replaceAll("'", "''")}' parent '${marker.replaceAll("'", "''")}'`, { timeoutMs: 5000, exe: process.env.MCP_REQUIRED_ENGINE === 'powershell' ? 'powershell.exe' : 'pwsh' });
      for (let i = 0; i < 160; i++) { try { const lines = readFileSync(marker, 'utf8').trim().split('\n'); pids = lines.map(s => Number(s.split(':')[1])); if (pids.length === 3) break; } catch {} await pause(25); }
      expect(pids).toHaveLength(3);
      const started = Date.now();
      if (store && id) {
        store.cancel('owner', id);
        for (let i = 0; i < 300 && store.status('owner', id).state === 'running'; i++) await pause(25);
        expect(store.status('owner', id).state).toBe('cancelled');
      } else { const result = await pending!; expect(result.timedOut).toBe(true); expect(result.stdout).toContain('before-timeout'); }
      expect(Date.now() - started).toBeLessThan(10000);
      for (let i = 0; i < 80 && pids.some(alive); i++) await pause(25);
      expect(pids.map(alive)).toEqual([false, false, false]);
      expect(alive(control.pid!)).toBe(true);
    } finally {
      if (store && id) store.cancel('owner', id);
      control.kill(); await pause(300); rmSync(base, { recursive: true, force: true });
    }
  }, 25000);

  it('bounds a nonresponsive cancellation and never retries it', async () => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'acceptance-stall-'));
    const store = new ExecutionStore(join(base, 'store'));
    const run = store.start('owner', 'stall', process.execPath, ['-e', 'setTimeout(()=>{},9000)']);
    // Replace only this synthetic invocation's owned control channel with an unresponsive one.
    const internals = store as unknown as { children: Map<string, { pid: number; exitCode: null; stdin: { write: () => boolean }; cancel?: () => void }> };
    const original = internals.children.get(run.id)!;
    let attempts = 0;
    internals.children.set(run.id, { pid: process.pid, exitCode: null, stdin: { write: () => { attempts++; return true; } }, cancel: () => { attempts++; } });
    try {
      store.cancel('owner', run.id); store.cancel('owner', run.id);
      await pause(6500);
      expect(store.status('owner', run.id).state).toBe('unknown');
      expect(attempts).toBe(1);
      expect(store.start('owner', 'stall', process.execPath, ['-e', 'setTimeout(()=>{},9000)']).id).toBe(run.id);
    } finally { internals.children.set(run.id, original); original.cancel?.(); for (let i = 0; i < 200 && original.exitCode === null; i++) await pause(25); await pause(100); rmSync(base, { recursive: true, force: true }); }
  }, 20000);

  it('fresh process ignores synthetic stale PID ownership after a simulated reboot', async () => {
    const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'acceptance-reboot-'));
    const store = new ExecutionStore(join(base, 'store'));
    const args = ['-e', 'process.stdout.write("retained")'];
    const run = store.start('owner', 'reboot', process.execPath, args);
    for (let i = 0; i < 200 && store.status('owner', run.id).state === 'running'; i++) await pause(25);
    const path = join(store.root, run.id, 'meta.json');
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...meta, state: 'running', pid: process.pid, supervisorPid: process.pid, bootId: 'previous-boot', startTime: 'stale' }));
    const entry = join(base, 'recover.mjs');
    writeFileSync(entry, `import {ExecutionStore} from ${JSON.stringify(new URL('../src/execution-lifecycle.ts', import.meta.url).href)}; const s=new ExecutionStore(process.argv[2]);const id=process.argv[3]; console.log(JSON.stringify([s.status('owner',id),s.cancel('owner',id),s.start('owner','reboot',process.execPath,${JSON.stringify(args)})]));`);
    try {
      const recovered = spawnSync(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href, entry, store.root, run.id], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      expect(recovered.status, recovered.stderr).toBe(0);
      expect(JSON.parse(recovered.stdout).map((r: { state: string; id: string }) => [r.state, r.id])).toEqual(Array(3).fill(['unknown', run.id]));
      expect(alive(process.pid)).toBe(true);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }, 20000);

  it.each(['inaccessible', 'unauthorized'])('WinRM %s cannot establish remote termination from local exit', failure => {
    expect(fromProcess({ stdout: '', stderr: failure, exitCode: 0, timedOut: false, durationMs: 1, shell: 'fixture', truncated: false, invocationStatus: 'transport_error' }, 'winrm', 'synthetic.invalid')).toMatchObject({ terminationStatus: 'transport_error', terminationCertainty: 'unknown', exitCode: null });
  });
});

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, symlinkSync, renameSync, readdirSync, statSync, unlinkSync, truncateSync } from 'node:fs';
import * as fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExecutionStore } from '../src/execution-lifecycle.js';

const fixture = async (fn: (root: string) => Promise<void>) => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'execution-test-'));
  try { await fn(join(root, 'store')); } finally {
    for (let i = 0; i < 30; i++) {
      try { rmSync(root, { recursive: true, force: true }); break; }
      catch (error) { if (i === 29) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
};
const script = 'process.stdout.write("ready\\n")';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
// Windows ACL probes, process startup, polling, and fixture removal can each consume
// seconds; keep one bounded budget for every sibling rather than Vitest's 5s default.
const lifecycleIt = (name: string, fn: () => void | Promise<void>, timeout = 20_000) => it(name, fn, timeout);

describe('durable local executions', () => {
  lifecycleIt('deduplicates across real server processes after an unproven launch and restores completed output', async () => fixture(async root => {
    const base = join(root, '..');
    const entry = join(base, 'server.mjs');
    const moduleUrl = new URL('../src/execution-lifecycle.ts', import.meta.url).href;
    if (process.platform !== 'win32') fs.mkdirSync(root, { mode: 0o700 });
    writeFileSync(entry, `import { ExecutionStore } from ${JSON.stringify(moduleUrl)};
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const [root, phase] = process.argv.slice(2);
const store = new ExecutionStore(join(root, 'store'));
const code = 'require("node:fs").appendFileSync(' + JSON.stringify(join(root, 'marker')) + ', "x");setTimeout(()=>process.stdout.write("done"), 1500)';
const request = () => store.start('owner', 'intent', process.execPath, ['-e', code]);
if (phase === 'first') { const run = request(); writeFileSync(join(root, 'id'), run.id); const deadline=Date.now()+8000; while (!existsSync(join(root, 'marker')) && Date.now()<deadline) await new Promise(r=>setTimeout(r,20)); if (!existsSync(join(root, 'marker'))) process.exit(4); process.exit(0); }
else if (phase === 'complete') { const run = store.start('owner', 'complete', process.execPath, ['-e', 'process.stdout.write(String.fromCharCode(114,101,97,100,121,10))']); const deadline=Date.now()+8000; while (store.status('owner', run.id).state === 'running' && Date.now()<deadline) await new Promise(r=>setTimeout(r,20)); if (store.status('owner', run.id).state !== 'completed') process.exit(5); writeFileSync(join(root, 'complete-id'), run.id); }
else if (phase === 'verify') { const id = (await import('node:fs')).readFileSync(join(root, 'complete-id'), 'utf8'); writeFileSync(join(root, 'completed'), JSON.stringify({ status: store.status('owner', id), output: store.read('owner', id, 'stdout', 0, 64) })); }
else { const run = request(); writeFileSync(join(root, 'recovered'), JSON.stringify(run)); }
`);
    const run = (phase: string) => spawnSync(process.execPath, ['--import', pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href, entry, base, phase], { cwd: process.cwd(), env: { ...process.env, TMPDIR: process.env.TMPDIR ?? root }, encoding: 'utf8' });
    const firstProcess = run('first');
    expect(firstProcess.stderr).toBe('');
    expect(firstProcess.status).toBe(0);
    for (let i = 0; i < 100; i++) { try { if (readFileSync(join(base, 'marker'), 'utf8') === 'x') break; } catch { /* waiting */ } await pause(20); }
    expect(run('second').status).toBe(0);
    expect(JSON.parse(readFileSync(join(base, 'recovered'), 'utf8')).state).toBe('unknown');
    expect(readFileSync(join(base, 'marker'), 'utf8')).toBe('x');
    expect(run('complete').status).toBe(0);
    expect(run('verify').status).toBe(0);
    const completed = JSON.parse(readFileSync(join(base, 'completed'), 'utf8'));
    expect(completed.status.state).toBe('completed');
    expect(Buffer.from(completed.output.data, 'base64').toString()).toBe('ready\n');
  }), 30000);
  lifecycleIt('starts, polls, reads byte pages and survives a fresh store', async () => fixture(async root => {
    const store = new ExecutionStore(root);
    const { id } = store.start('owner-a', 'key-a', process.execPath, ['-e', script]);
    let result = store.status('owner-a', id);
    for (let i = 0; i < 100 && result.state === 'running'; i++) { await pause(20); result = store.status('owner-a', id); }
    expect(result.state).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(store.read('owner-a', id, 'stdout', 0, 64).data, 'base64').toString()).toBe('ready\n');
    expect(new ExecutionStore(root).status('owner-a', id).state).toBe('completed');
  }));
  lifecycleIt('deduplicates matching requests and rejects key conflicts', async () => fixture(async root => {
    const store = new ExecutionStore(root);
    const first = store.start('owner-a', 'unique', process.execPath, ['-e', script]);
    expect(store.start('owner-a', 'unique', process.execPath, ['-e', script]).id).toBe(first.id);
    expect(() => store.start('owner-a', 'unique', process.execPath, ['-e', 'process.exit(9)'])).toThrow(/conflict/i);
    expect(() => store.status('owner-b', first.id)).toThrow(/unknown/i);
    for (let i = 0; i < 100 && store.status('owner-a', first.id).state === 'running'; i++) await pause(20);
  }));
  lifecycleIt('marks live cancellation unknown rather than asserting descendant termination', async () => fixture(async root => {
    const store = new ExecutionStore(root);
    const run = store.start('owner', 'cancel', process.execPath, ['-e', 'process.stdout.write("before-cancel");setTimeout(()=>{},5000)']);
    for (let i = 0; i < 100 && store.status('owner', run.id).stdoutBytes === 0; i++) await pause(20);
    expect(Buffer.from(store.read('owner', run.id, 'stdout', 0, 64).data, 'base64').toString()).toBe('before-cancel');
    expect(store.cancel('owner', run.id).state).toBe('running');
    {
      for (let i = 0; i < 150 && store.status('owner', run.id).state === 'running'; i++) await pause(20);
      expect(store.status('owner', run.id).state).toBe('cancelled');
    }
    await pause(200);
  }));
  lifecycleIt('does not relaunch a persisted ambiguous intent after restart', async () => fixture(async root => {
    const first = new ExecutionStore(root);
    const run = first.start('owner-a', 'slow', process.execPath, ['-e', 'setTimeout(() => {}, 3000)']);
    const recovered = new ExecutionStore(root);
    expect(recovered.start('owner-a', 'slow', process.execPath, ['-e', 'setTimeout(() => {}, 3000)']).id).toBe(run.id);
    expect(recovered.status('owner-a', run.id).state).toBe('unknown');
    expect(recovered.cancel('owner-a', run.id).state).toBe('unknown');
    first.cancel('owner-a', run.id);
    await pause(200);
  }));
  lifecycleIt('rejects malformed recovered metadata without relaunching its reservation', async () => fixture(async root => {
    const first = new ExecutionStore(root);
    const run = first.start('owner', 'malformed', process.execPath, ['-e', script]);
    const path = join(root, run.id, 'meta.json');
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    meta.stdoutBytes = -1;
    writeFileSync(path, JSON.stringify(meta));
    const restored = new ExecutionStore(root);
    expect(() => restored.start('owner', 'malformed', process.execPath, ['-e', script])).toThrow(/ambiguous/i);
  }));
  lifecycleIt('rejects a reparse run directory during recovery', async () => fixture(async root => {
    const live = new ExecutionStore(root);
    const run = live.start('owner', 'reparse', process.execPath, ['-e', script]);
    const source = join(root, run.id), target = join(root, 'target');
    for (let i = 0; i < 150 && live.status('owner', run.id).state === 'running'; i++) await pause(20);
    await pause(250);
    renameSync(source, target);
    symlinkSync(target, source, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new ExecutionStore(root).start('owner', 'reparse', process.execPath, ['-e', script])).toThrow(/ambiguous/i);
  }));
  lifecycleIt('reports complete output for a fully captured nonzero exit', async () => fixture(async root => {
    const store = new ExecutionStore(root);
    const run = store.start('owner', 'failed', process.execPath, ['-e', 'process.stderr.write("bad");process.exit(7)']);
    for (let i = 0; i < 100 && store.status('owner', run.id).state === 'running'; i++) await pause(20);
    expect(store.status('owner', run.id).state).toBe('failed');
    expect(store.read('owner', run.id, 'stderr', 0, 32).complete).toBe(true);
  }));
  lifecycleIt('bounds simultaneous newline-free streams on disk without raw spools', async () => fixture(async root => {
    if (process.platform !== 'win32') return;
    const store = new ExecutionStore(root);
    const code = 'const b=Buffer.alloc(65536,65);for(let i=0;i<200;i++){require("node:fs").writeSync(1,b);require("node:fs").writeSync(2,b)}';
    const { id } = store.start('owner', 'flood', process.execPath, ['-e', code]);
    let peak = 0;
    for (let i = 0; i < 1000 && store.status('owner', id).state === 'running'; i++) {
      const dir = join(root, id);
      peak = Math.max(peak, readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0));
      await pause(10);
    }
    const status = store.status('owner', id);
    expect(status.state).toBe('completed');
    expect(status.outputComplete).toBe(false);
    expect(status.stdoutBytes + status.stderrBytes).toBe(8_388_608);
    expect(readdirSync(join(root, id)).sort()).toEqual(['meta.json', 'stderr', 'stdout']);
    expect(peak).toBeLessThanOrEqual(8_388_608 + 4096);
  }), 20000);
  lifecycleIt('keeps a launched child accounted for when an asynchronous save fails', async () => fixture(async root => {
    let commits = 0;
    const store = new ExecutionStore(root, fs.fsyncSync, () => {
      if (++commits === 3) throw Error('injected asynchronous metadata failure');
    });
    const run = store.start('owner', 'lost-disk', process.execPath, ['-e', 'setTimeout(()=>process.stdout.write("later"), 100)']);
    for (let i = 0; i < 150 && store.status('owner', run.id).state === 'running'; i++) await pause(20);
    expect(commits).toBeGreaterThanOrEqual(3);
    expect(store.status('owner', run.id).state).toBe('unknown');
    expect(store.status('owner', run.id).outputComplete).toBe(false);
    expect(new ExecutionStore(root).status('owner', run.id).state).toBe('unknown');
  }));
  lifecycleIt('quotes Windows arguments without a command shell and fails closed on launch error', async () => fixture(async root => {
    if (process.platform !== 'win32') return;
    const store = new ExecutionStore(root);
    const values = ['', 'a b', 'embedded"quote', 'end\\', 'back\\"quote'];
    const run = store.start('owner', 'quoted', process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values], join(root, '..'));
    for (let i = 0; i < 150 && store.status('owner', run.id).state === 'running'; i++) await pause(20);
    expect(store.status('owner', run.id).state).toBe('completed');
    expect(JSON.parse(Buffer.from(store.read('owner', run.id, 'stdout', 0, 1024).data, 'base64').toString())).toEqual(values);
    const bad = store.start('owner', 'bad-program', join(root, '..', 'missing.exe'));
    for (let i = 0; i < 150 && store.status('owner', bad.id).state === 'running'; i++) await pause(20);
    expect(store.status('owner', bad.id).state).toBe('unknown');
  }), 20000);
  lifecycleIt('terminates the owned Windows tree but preserves an unrelated process', async () => fixture(async root => {
    if (process.platform !== 'win32') return;
    const base = join(root, '..');
    const marker = join(base, 'tree-markers');
    const tree = join(base, 'tree.cjs');
    writeFileSync(tree, `const {spawn}=require('node:child_process');const fs=require('node:fs');
const [role,marker]=process.argv.slice(2);fs.appendFileSync(marker,role+':'+process.pid+'\\n');
if(role!=='grandchild')spawn(process.execPath,[__filename,role==='parent'?'child':'grandchild',marker],{stdio:'ignore'}).unref();
setInterval(()=>{},1000);`);
    const control = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      const store = new ExecutionStore(root);
      const run = store.start('owner', 'tree', process.execPath, [tree, 'parent', marker]);
      let lines: string[] = [];
      for (let i = 0; i < 200; i++) {
        try { lines = readFileSync(marker, 'utf8').trim().split('\n'); } catch { /* not launched */ }
        if (lines.length === 3) break;
        await pause(25);
      }
      expect(lines.map(x => x.split(':')[0])).toEqual(['parent', 'child', 'grandchild']);
      store.cancel('owner', run.id);
      for (let i = 0; i < 200 && store.status('owner', run.id).state === 'running'; i++) await pause(25);
      expect(store.status('owner', run.id).state).toBe('cancelled');
      for (const line of lines) expect(() => process.kill(Number(line.split(':')[1]), 0)).toThrow();
      expect(() => process.kill(control.pid!, 0)).not.toThrow();
    } finally { control.kill(); }
  }), 20000);
  lifecycleIt('does not mutate an existing broadly accessible Windows root', () => {
    if (process.platform !== 'win32') return;
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'execution-acl-'));
    try {
      const before = spawnSync('icacls.exe', [root], { encoding: 'utf8' }).stdout;
      expect(() => new ExecutionStore(root)).toThrow(/ACL unsafe: \{.*"current":.*"owner":.*"rules":/i);
      expect(spawnSync('icacls.exe', [root], { encoding: 'utf8' }).stdout).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  lifecycleIt('inspects a private root under a pwsh-inherited module path without weakening ACL validation', async () => fixture(async root => {
    if (process.platform !== 'win32' || spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' }).status !== 0) return;
    const entry = join(root, '..', 'pwsh-parent.mjs');
    writeFileSync(entry, `import { ExecutionStore } from ${JSON.stringify(new URL('../src/execution-lifecycle.ts', import.meta.url).href)}; new ExecutionStore(process.argv[2]); new ExecutionStore(process.argv[2]);`);
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const command = `& ${quote(process.execPath)} --import ${quote(pathToFileURL(join(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href)} ${quote(entry)} ${quote(root)}; exit $LASTEXITCODE`;
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(() => new ExecutionStore(join(root, '..'))).toThrow(/ACL unsafe: \{.*"current":.*"owner":.*"rules":/i);
  }));
  lifecycleIt('creates a private Windows root atomically beneath an accessible parent', async () => fixture(async root => {
    if (process.platform !== 'win32') return;
    new ExecutionStore(root);
    const command = `$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $p=${JSON.stringify(root)}; $a=Get-Acl -LiteralPath $p; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or -not $a.AreAccessRulesProtected) { exit 1 }; foreach($r in $a.Access) { $s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if ($r.IsInherited -or ($s -ne $sid -and $s -ne 'S-1-5-18')) { exit 2 } }`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
    expect(result.status, (result.stderr || result.stdout).slice(0, 2048)).toBe(0);
  }));
  lifecycleIt('recovers missing and truncated completed outputs as unknown without replay', async () => fixture(async root => {
    const store = new ExecutionStore(root);
    const code = 'process.stdout.write("durable-output")';
    const run = store.start('owner', 'lost-output', process.execPath, ['-e', code]);
    for (let i = 0; i < 100 && store.status('owner', run.id).state === 'running'; i++) await pause(20);
    expect(store.status('owner', run.id).state).toBe('completed');
    truncateSync(join(root, run.id, 'stdout'), 3);
    const recovered = new ExecutionStore(root);
    expect(recovered.status('owner', run.id).state).toBe('unknown');
    expect(() => recovered.read('owner', run.id, 'stdout', 0, 64)).toThrow();
    expect(recovered.start('owner', 'lost-output', process.execPath, ['-e', code]).state).toBe('unknown');
    unlinkSync(join(root, run.id, 'stderr'));
    expect(new ExecutionStore(root).status('owner', run.id).state).toBe('unknown');
  }));
  lifecycleIt('flushes output before committing metadata and fails closed if output flush fails', async () => fixture(async root => {
    const events: string[] = [];
    const store = new ExecutionStore(root, fd => {
      events.push(`flush:${fd}`);
      fs.fsyncSync(fd);
    }, () => events.push('metadata'));
    const run = store.start('owner', 'flush', process.execPath, ['-e', 'process.stdout.write("x")']);
    for (let i = 0; i < 100 && store.status('owner', run.id).state === 'running'; i++) await pause(20);
    expect(events.some(e => e.startsWith('flush:'))).toBe(true);
    expect(events.lastIndexOf('metadata')).toBeGreaterThan(events.findIndex(e => e.startsWith('flush:')));
    const failed = new ExecutionStore(join(root, '..', 'failed-store'), () => { throw Error('flush failure'); });
    const second = failed.start('owner', 'flush-failure', process.execPath, ['-e', 'process.stdout.write("x")']);
    for (let i = 0; i < 100 && failed.status('owner', second.id).state === 'running'; i++) await pause(20);
    expect(failed.status('owner', second.id).state).toBe('unknown');
    expect(new ExecutionStore(failed.root).status('owner', second.id).state).toBe('unknown');
  }));
  lifecycleIt('bounds key-only orphan reservations', async () => fixture(async root => {
    const store = new ExecutionStore(root);
    for (let i = 0; i < 64; i++) writeFileSync(join(root, `${i.toString(16).padStart(64, '0')}.key`), '0'.repeat(48));
    expect(() => store.start('owner', 'new', process.execPath, ['-e', script])).toThrow(/capacity/i);
  }));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as fixture from './fixtures/packaged-process.mjs';
import { runCommand, runClient, startProcess, stopProcess } from './fixtures/packaged-process.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() >= end) throw Error(`Timed out: ${label}`);
    await delay(20);
  }
}
function dead(pid) {
  try { process.kill(pid, 0); return false; } catch (e) { if (e.code === 'ESRCH') return true; throw e; }
}
async function deadTree(file) {
  const pids = (await readFile(file, 'utf8')).trim().split('\n').map(Number);
  assert.equal(pids.length, 2, 'both lifecycle process and descendant actually started');
  await until(() => pids.every(dead), 'descendant exit');
}

// Real npm lifecycle scripts remain enabled, with no registry dependencies.
test('blocked npm lifecycle is asynchronous, cancellable and kills its owned tree only', { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'packaged-setup-fault-'));
  const file = join(dir, 'pids');
  const control = startProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  const controller = new AbortController();
  let rejected;
  try {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'blocked-setup-fixture', version: '1.0.0', scripts: { preinstall: 'node hang.cjs' } }));
    await writeFile(join(dir, 'hang.cjs'), `const {spawn}=require('node:child_process');const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(file)},process.pid+'\\n');if(!process.argv[2])spawn(process.execPath,[__filename,'descendant'],{stdio:'inherit'});setInterval(()=>{},1000);`);
    const npm = resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js');
    const command = process.platform === 'win32' ? process.execPath : 'npm';
    const prefix = process.platform === 'win32' ? [npm] : [];
    rejected = assert.rejects(runCommand(command, [...prefix, 'install', '--offline', '--no-audit', '--no-fund'], {
      cwd: dir, signal: controller.signal, label: 'controlled blocked npm install',
      env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` },
    }), /controlled npm cancellation/);
    await until(async () => {
      try { return (await readFile(file, 'utf8')).trim().split('\n').length === 2; } catch { return false; }
    }, 'npm lifecycle and descendant started', 20000);
    controller.abort(Error('controlled npm cancellation'));
    await rejected;
    assert.ok(ticks > 10, 'setup must leave the event loop responsive');
    await deadTree(file);
    assert.equal(dead(control.child.pid), false, 'unrelated process survives');
  } finally {
    controller.abort(Error('controlled npm cancellation'));
    await rejected;
    clearInterval(timer);
    await stopProcess(control);
    await rm(dir, { recursive: true, force: true });
  }
});

test('setup stage deadline interrupts a blocked child while timers run', { timeout: 10000 }, async () => {
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  try {
    await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 300, label: 'blocked stage' }), /Timed out: blocked stage/);
    assert.equal(ticked, true);
  } finally { clearTimeout(timer); }
});

test('setup cancellation stops a blocked child before returning', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const dir = await mkdtemp(join(tmpdir(), 'packaged-abort-'));
  const file = join(dir, 'pid');
  const running = runCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000)`], { signal: controller.signal, label: 'cancelled setup' });
  // Attach the rejection handler before aborting.
  const rejected = assert.rejects(running, /controlled cancellation/);
  try {
    await until(async () => { try { return Number(await readFile(file, 'utf8')) > 0; } catch { return false; } }, 'setup started');
    controller.abort(Error('controlled cancellation'));
    await rejected;
    assert.equal(dead(Number(await readFile(file, 'utf8'))), true);
  } finally {
    controller.abort(Error('controlled cancellation'));
    await rejected;
    await rm(dir, { recursive: true, force: true });
  }
});

test('setup spawn and nonzero failures fail closed with diagnostics', async () => {
  await assert.rejects(runCommand('missing-pr66-fixture-command', [], { label: 'missing setup' }), /missing setup failed.*ENOENT/s);
  await assert.rejects(runCommand(process.execPath, ['-e', "console.error('controlled failure');process.exit(7)"], { label: 'bad setup' }), /bad setup failed \(7\): controlled failure/);
});

test('client cancellation before ready closes the held process', { timeout: 10000 }, async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Error('ready cancelled')), 300);
  try {
    await assert.rejects(runClient('await new Promise(()=>{});', {}, () => assert.fail('proof must not run'), { signal: controller.signal }), /ready cancelled/);
  } finally { clearTimeout(timer); }
});

test('client observation failure closes the child and preserves the proof error', { timeout: 10000 }, async () => {
  let child;
  await assert.rejects(runClient('', {}, c => { child = c; throw Error('controlled proof failure'); }), /controlled proof failure/);
  assert.equal(dead(child.pid), true);
});

test('client ignoring release is bounded and killed', { timeout: 10000 }, async () => {
  let child;
  await assert.rejects(runClient('process.disconnect=()=>{};setInterval(()=>{},1000);', {}, c => { child = c; }, { releaseTimeout: 100 }), /Timed out: client release/);
  assert.equal(dead(child.pid), true);
});

test('client remains alive through asynchronous proof and closes after release', { timeout: 10000 }, async () => {
  let child;
  await runClient('', {}, async c => { child = c; await delay(100); assert.equal(dead(c.pid), false); });
  assert.equal(dead(child.pid), true);
});

test('both output pipes drain and retain bounded diagnostic tails', { timeout: 10000 }, async () => {
  const proc = startProcess(process.execPath, ['-e', "process.stdout.write('a'.repeat(3*1024*1024));process.stderr.write('b'.repeat(3*1024*1024));"]);
  try {
    const result = await proc.closed;
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 1024 * 1024);
    assert.equal(result.stderr.length, 1024 * 1024);
  } finally { await stopProcess(proc); }
});

test('failed client spawn settles readiness', { timeout: 10000 }, async () => {
  await assert.rejects(runClient('', { cwd: join(tmpdir(), 'pr66-missing-client-cwd') }, () => assert.fail('proof ran')), /ENOENT/);
});

test('client failure before ready preserves diagnostics', { timeout: 10000 }, async () => {
  await assert.rejects(runClient("throw Error('before-ready failure')", {}, () => assert.fail('proof ran')), /before-ready failure/);
});

test('late proof rejection after cancellation is consumed', { timeout: 10000 }, async () => {
  const controller = new AbortController(); let child;
  await assert.rejects(runClient('', {}, c => {
    child = c;
    setTimeout(() => controller.abort(Error('late-proof cancellation')), 20);
    return delay(100).then(() => { throw Error('late proof rejection'); });
  }, { signal: controller.signal }), /late-proof cancellation/);
  await delay(150);
  assert.equal(dead(child.pid), true);
});

for (const code of [0, 7]) for (const inherit of [false, true]) {
  test(`root-first group cleanup on ${code === 0 ? 'natural close' : 'failure'} (inherited pipes=${inherit})`, { timeout: 15000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'packaged-root-first-'));
    const file = join(dir, 'pid'), ready = join(dir, 'ready'), release = join(dir, 'release'); let pid, result;
    const controller = new AbortController();
    const control = startProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid));setInterval(()=>{},1000);`;
    // One existing case deliberately starts its descendant after the old 1s cutoff.
    const startupDelay = code === 7 && inherit ? 1200 : 0;
    const root = `const fs=require('node:fs');setTimeout(()=>{const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:${inherit ? "'inherit'" : "'ignore'"}});c.unref();const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(file)})){fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));clearInterval(t);const r=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(r);process.exit(${code})}},10)}},10)},${startupDelay});`;
    try {
      // Own settlement before readiness can fail; the outer signal also cancels setup.
      result = runCommand(process.execPath, ['-e', root], {
        signal: AbortSignal.any([t.signal, controller.signal]), timeout: 15000, label: 'root-first stage',
      }).then(() => null, e => e);
      await until(async () => {
        try {
          pid = Number(await readFile(file, 'utf8'));
          const rootPid = Number(await readFile(ready, 'utf8'));
          return pid > 0 && rootPid > 0 && !dead(pid) && !dead(rootPid);
        } catch { return false; }
      }, 'root and descendant ready', 5000);
      // Startup has its own bound. Exit and group cleanup share the original 1s proof.
      const deadline = Date.now() + 1000;
      await writeFile(release, 'exit');
      const error = await fixture.waitFor(result, { signal: t.signal, timeout: Math.max(1, deadline - Date.now()), label: 'root-first exit and cleanup' });
      if (code) assert.match(error?.message ?? '', /failed \(7\)/);
      else assert.equal(error, null);
      // Linux may retain an already killed orphan zombie until init reaps it.
      await until(async () => dead(pid) || (process.platform === 'linux' && /\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => ''))), 'ordinary descendant terminated', Math.max(1, deadline - Date.now()));
      assert.ok(Date.now() <= deadline, 'exit and descendant cleanup complete within 1000ms after readiness');
      assert.equal(dead(control.child.pid), false, 'unrelated owned group survives');
    } finally {
      controller.abort(Error('root-first scope closed'));
      await result;
      // Readiness can fail before publishing the PID; settle the command first.
      pid ??= Number(await readFile(file, 'utf8').catch(() => '0'));
      if (pid && !dead(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
      await stopProcess(control);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('unowned or closed POSIX group is never signalled', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const kill = process.kill, calls = [];
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    process.kill = (...args) => { calls.push(args); return true; };
    await stopProcess({ child: { pid: 424242, exitCode: 7, signalCode: null }, closed: Promise.resolve({ code: 7 }) });
    assert.deepEqual(calls, [], 'no stale/reused group signalling');
  } finally { process.kill = kill; Object.defineProperty(process, 'platform', descriptor); }
});

test('POSIX ownership remains live through command exit and is retired before repeat cleanup', { timeout: 10000 }, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const kill = process.kill, calls = []; let proc;
  const nativeWindows = process.platform === 'win32';
  try {
    // Executes the POSIX keeper protocol on Windows too; this is control-flow evidence,
    // not native POSIX group semantics. The synthetic command has no descendants.
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
    process.kill = (pid, signal) => {
      calls.push([pid, signal]);
      assert.equal(proc.child.exitCode, null, 'group leader is still owned and live');
      return kill(nativeWindows ? -pid : pid, signal);
    };
    proc = startProcess(process.execPath, ['-e', 'process.exit(7)']);
    const result = await proc.closed;
    await stopProcess(proc);
    await stopProcess(proc);
    assert.equal(result.code, 7, 'command status survives keeper termination');
    assert.deepEqual(calls, [[-proc.child.pid, 'SIGKILL']]);
  } finally {
    process.kill = kill; Object.defineProperty(process, 'platform', descriptor);
    if (proc && !dead(proc.child.pid)) proc.child.kill('SIGKILL');
  }
});

for (const kind of ['client', 'command']) {
  test(`${kind} primary failure survives termination-command rejection`, { timeout: 15000 }, async () => {
    // Real Windows failure path; POSIX group-kill injection exercises the same precedence.
    const originalExec = cp.execFile, originalKill = process.kill;
    const primary = Error(`original ${kind} failure`); let child, controller, commandResult;
    const dir = await mkdtemp(join(tmpdir(), 'packaged-cleanup-error-'));
    const file = join(dir, 'pid');
    const inject = () => {
      if (process.platform === 'win32') {
        cp.execFile = (...args) => queueMicrotask(() => args.at(-1)(Error('injected taskkill failure')));
        syncBuiltinESMExports();
      } else process.kill = (pid, signal) => { if (pid < 0) throw Error('injected group kill failure'); return originalKill(pid, signal); };
    };
    try {
      let observed;
      if (kind === 'client') {
        try { await runClient('', {}, c => { child = c; inject(); throw primary; }); } catch (e) { observed = e; }
      } else {
        controller = new AbortController();
        // Deliberately publish readiness after the former 300 ms abort deadline.
        // Own the rejection immediately, including when bounded readiness fails.
        commandResult = runCommand(process.execPath, ['-e', `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(file)},String(process.pid)),600);setInterval(()=>{},1000)`], { signal: controller.signal }).then(() => undefined, e => e);
        await until(async () => { try { return Number(await readFile(file, 'utf8')) > 0; } catch { return false; } }, 'delayed command started', 5000);
        inject();
        controller.abort(primary);
        observed = await commandResult;
      }
      assert.equal(observed.cause, primary);
      assert.ok(observed instanceof AggregateError);
      assert.match(observed.message, new RegExp(primary.message));
      assert.match(observed.errors.slice(1).map(e => e.message).join('\n'), /injected/);
      if (child) assert.equal(dead(child.pid), true, 'owned leader fallback was attempted before return');
      if (process.platform === 'win32' && kind === 'command') {
        assert.equal(dead(Number(await readFile(file, 'utf8'))), true, 'owned command fallback was attempted before return');
      }
    } finally {
      controller?.abort(primary);
      await commandResult;
      cp.execFile = originalExec; process.kill = originalKill; syncBuiltinESMExports();
      if (child && !dead(child.pid)) child.kill('SIGKILL');
      const pid = Number(await readFile(file, 'utf8').catch(() => '0'));
      if (pid && !dead(pid)) process.kill(pid, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('cleanup attempts every resource and bounds secondary diagnostics with primary cause', async () => {
  const primary = Error('original outer failure'), attempted = [];
  await assert.rejects(fixture.cleanup(primary, [
    () => { attempted.push('proxy'); throw Error('p'.repeat(20000)); },
    () => { attempted.push('collector'); throw Error('collector failure'); },
    () => { attempted.push('directory'); },
  ]), e => {
    assert.equal(e.cause, primary);
    assert.equal(e.errors[0], primary);
    assert.equal(e.errors.length, 3);
    assert.ok(e.errors[1].message.length <= 4096);
    assert.deepEqual(attempted, ['proxy', 'collector', 'directory']);
    return true;
  });
});

test('cleanup failure after success is reported after all resources are attempted', async () => {
  let removed = false;
  await assert.rejects(fixture.cleanup(undefined, [() => { throw Error('collector failure'); }, () => { removed = true; }]), /collector failure/);
  assert.equal(removed, true);
});

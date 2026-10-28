import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

// Only these records confer process-group ownership; never infer it from a PID.
const owners = new WeakMap();
// A POSIX keeper remains the live group leader after the command exits. Reporting
// exit (rather than close) also covers ordinary descendants holding inherited pipes.
// It never exits voluntarily; the parent kills its still-owned group and drains it.
// Scope: ordinary descendants in that group, while this keeper remains alive.
// Escaped groups, external keeper death and OS termination failures are excluded;
// after keeper exit we retire ownership rather than risk a reused numeric group.
const keeper = `
  const {spawn}=require('node:child_process');
  const {writeSync}=require('node:fs');
  const {command,args,ipc}=JSON.parse(process.argv[1]);
  setInterval(()=>{},1000);
  const child=spawn(command,args,{stdio:ipc?['inherit','inherit','inherit','ipc']:'inherit'});
  let reported=false;
  const report=result=>{if(!reported){reported=true;writeSync(4,JSON.stringify(result)+'\\n');}};
  child.on('error',e=>report({error:{message:e.message,code:e.code},code:null}));
  child.on('exit',(code,signal)=>report({code,signal}));
  if(ipc){
    child.on('message',message=>{if(process.connected)process.send(message,()=>{});});
    process.on('message',message=>{if(child.connected)child.send(message,()=>{});});
  }
`;

// All tasks run, even after failure. Keep the original failure as the explicit
// cause and first aggregate member; only secondary diagnostics are truncated.
export async function cleanup(primary, tasks) {
  const errors = [];
  for (const task of tasks) {
    try { await task(); } catch (e) { errors.push(Error(String(e?.message ?? e).slice(0, 4096))); }
  }
  if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors],
    `${primary === undefined ? 'Fixture cleanup failed' : String(primary?.message ?? primary)}; cleanup: ${errors.map(e => e.message).join('; ').slice(0, 8192)}`,
    primary === undefined ? undefined : { cause: primary });
  if (primary !== undefined) throw primary;
}

function killGroup(proc, state) {
  if (!state.active) return;
  state.active = false; // Never signal this numeric group again, including after close.
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;
  try { process.kill(-proc.child.pid, 'SIGKILL'); }
  catch (e) {
    if (e.code !== 'ESRCH') state.errors.push(e);
    // Still attempt the owned leader if group termination fails.
    try { proc.child.kill('SIGKILL'); } catch (fallback) { state.errors.push(fallback); }
  }
}

export function waitFor(promise, { signal, timeout = 15000, label = 'fixture' } = {}) {
  let timer, abort;
  return new Promise((resolve, reject) => {
    abort = () => reject(signal.reason);
    timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(resolve, reject);
  }).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

export function startProcess(command, args, options = {}) {
  const posix = process.platform !== 'win32';
  const ipc = Array.isArray(options.stdio) && options.stdio.includes('ipc');
  const stdio = options.stdio === 'ignore' ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'];
  const child = posix
    ? spawn(process.execPath, ['-e', keeper, JSON.stringify({ command, args, ipc })], {
      ...options, detached: true, windowsHide: true, stdio: [...stdio, ipc ? 'ipc' : 'ignore', 'pipe'],
    })
    : spawn(command, args, { ...options, detached: false, windowsHide: true });
  let stdout = '', stderr = '', error;
  // Always drain pipes, even when a caller only needs the exit status.
  child.stdout?.on('data', b => { stdout = (stdout + b).slice(-1024 * 1024); });
  child.stderr?.on('data', b => { stderr = (stderr + b).slice(-1024 * 1024); });
  child.on('error', e => { error = e; });
  let result;
  const state = { posix, active: posix, errors: [] };
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    state.active = false;
    resolve({ code, signal, ...result, error: error ?? (result?.error && Error(result.error.message)), stdout, stderr });
  }));
  const proc = { child, closed, output: () => stdout + stderr };
  owners.set(proc, state);
  if (posix) {
    let status = '';
    child.stdio[4].on('data', b => {
      status += b;
      if (!result && status.includes('\n')) {
        result = JSON.parse(status);
        killGroup(proc, state);
      }
    });
  }
  return proc;
}

export async function stopProcess(proc) {
  if (!proc) return;
  const state = owners.get(proc);
  let closeFailed = false;
  await cleanup(undefined, [
    async () => {
      if (state?.posix) {
        killGroup(proc, state);
        if (state.errors.length) throw new AggregateError(state.errors, state.errors.map(e => e.message).join('; '));
      } else if (state && proc.child.pid && proc.child.exitCode === null && proc.child.signalCode === null) {
        // Windows tree termination is scoped to a still-live root.
        await promisify(execFile)('taskkill.exe', ['/pid', String(proc.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(e => {
          if (proc.child.exitCode === null && proc.child.signalCode === null) throw e;
        });
      }
    },
    () => { if (state && !state.posix && proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL'); },
    async () => {
      try { await waitFor(proc.closed, { timeout: 5000, label: 'child close' }); }
      catch (e) { closeFailed = true; throw e; }
    },
    async () => {
      if (closeFailed && state) {
        await cleanup(undefined, [
          () => { if (proc.child.connected) proc.child.disconnect(); },
          ...(proc.child.stdio ?? []).map(stream => () => stream?.destroy?.()),
        ]);
      }
    },
  ]);
}

function checked(result, label) {
  if (result.error || result.code !== 0) throw Error(`${label} failed (${result.code ?? result.signal}): ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

export async function runCommand(command, args, { signal, timeout = 120000, label = 'setup', ...options } = {}) {
  signal?.throwIfAborted();
  const started = Date.now();
  console.log(`packaged fixture: ${label} started`);
  const proc = startProcess(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let primary;
  try {
    return checked(await waitFor(proc.closed, { signal, timeout, label }), label);
  } catch (e) {
    primary = e;
    console.error(`${label}: ${proc.output()}`);
  } finally {
    await cleanup(primary, [
      () => stopProcess(proc),
      () => console.log(`packaged fixture: ${label} cleanup finished after ${Date.now() - started}ms`),
    ]);
  }
}

export async function runClient(script, options, observe, { signal, releaseTimeout = 2000 } = {}) {
  signal?.throwIfAborted();
  const held = `const released = new Promise(resolve => process.once('message', resolve));\n${script}\nprocess.send('ready'); await released; process.disconnect();`;
  const proc = startProcess(process.execPath, ['--input-type=module', '-e', held], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const local = new AbortController();
  const observing = AbortSignal.any([local.signal, ...(signal ? [signal] : [])]);
  const prematureExit = proc.closed.then(r => { throw Error(`fixture exited before proof (${r.code}): ${r.error?.message ?? r.stderr}`); });
  let primary;
  try {
    await waitFor(Promise.race([once(proc.child, 'message'), prematureExit]), { signal: observing, label: 'client ready' });
    await waitFor(Promise.race([Promise.resolve().then(() => observe(proc.child, observing)), prematureExit]), { signal: observing, label: 'client proof' });
    if (proc.child.connected) proc.child.send('release', () => {});
    checked(await waitFor(proc.closed, { signal: observing, timeout: releaseTimeout, label: 'client release' }), 'client');
  } catch (e) { primary = e; } finally {
    local.abort(Error('client scope closed'));
    await cleanup(primary, [() => stopProcess(proc)]);
  }
}

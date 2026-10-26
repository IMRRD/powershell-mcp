import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { spawnOwned, CANCEL_BOUND_MS } from '../src/owned-process.js';
import { runProgram } from '../src/program.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); spawnMock.mockReset(); });
describe('owned supervisor failure safety', () => {
  for (const failure of ['failed kill', 'stalled kill', 'reused pid', 'broken channel', 'forged proof']) it(`${failure} returns unknown without PID fallback or retry`, async () => {
    vi.useFakeTimers();
    const supervisor = Object.assign(new EventEmitter(), { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn(), kill: vi.fn() });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const requests: string[] = [];
    supervisor.stdin.on('data', b => requests.push(String(b)));
    spawnMock.mockReturnValue(supervisor);
    const child = spawnOwned(process.execPath, ['-e', 'synthetic']);
    const close = vi.fn(); child.on('close', close); child.on('error', () => {});
    await Promise.resolve();
    const nonce = JSON.parse(requests[0]).nonce;
    supervisor.stdout.write(JSON.stringify({ event: 'started', nonce }) + '\n');
    if (failure === 'broken channel') vi.spyOn(supervisor.stdin, 'write').mockImplementation(() => { throw Error('closed'); });
    child.cancel(); child.cancel();
    if (failure === 'failed kill') supervisor.stdout.write(JSON.stringify({ event: 'unknown', nonce }) + '\n');
    if (failure === 'forged proof') supervisor.stdout.write(JSON.stringify({ event: 'finished', nonce: 'forged', exitCode: 0, active: 0, cancelled: true }) + '\n');
    if (failure === 'reused pid') supervisor.emit('close', null); // PID still names this unrelated test runner.
    await vi.advanceTimersByTimeAsync(CANCEL_BOUND_MS + 1);
    expect(close).toHaveBeenCalledExactlyOnceWith(null);
    expect(child.treeTerminated).toBe(false);
    expect(kill).not.toHaveBeenCalled(); expect(supervisor.kill).not.toHaveBeenCalled();
    expect(requests.filter(s => s.startsWith('cancel ')).length).toBeLessThanOrEqual(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

describe('bounded supervisor diagnostics', () => {
  async function fixture() {
    const supervisor = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() });
    const requests: string[] = [];
    supervisor.stdin.on('data', b => requests.push(String(b)));
    spawnMock.mockReturnValue(supervisor);
    const child = spawnOwned(process.execPath, []);
    let stdout = '', stderr = '';
    child.stdout!.on('data', b => { stdout += b; });
    child.stderr!.on('data', b => { stderr += b; });
    const closed = new Promise(resolve => child.once('close', resolve));
    await Promise.resolve();
    const nonce = JSON.parse(requests[0]).nonce;
    const frame = (m: object) => supervisor.stdout.write(JSON.stringify({ nonce, ...m }) + '\n');
    frame({ event: 'started' });
    frame({ event: 'chunk', stream: 'stdout', data: Buffer.from('|EOF').toString('base64') });
    return { supervisor, child, frame, closed, requests, text: () => ({ stdout, stderr }) };
  }

  for (const reason of ['proc_inspection_failed', 'pidfd_open_failed', 'ownership_changed', 'pidfd_signal_failed', 'stdout_drain_failed', 'stderr_drain_failed', 'subreaper_unavailable', 'termination_unconfirmed', 'drain_unconfirmed', 'supervisor_exception'])
    it(`retains only first fixed reason ${reason} and still rejects later finished proof`, async () => {
      const f = await fixture();
      f.frame({ event: 'unknown', reason, message: 'SECRET command/path' });
      f.frame({ event: 'unknown', reason: 'supervisor_exception' });
      f.frame({ event: 'finished', active: 0, exitCode: 0, cancelled: false });
      f.supervisor.emit('close', 0);
      expect(await f.closed).toBeNull();
      expect(f.child.treeTerminated).toBe(false);
      expect(f.child.supervisorReason).toBe(reason);
      expect(f.text()).toEqual({ stdout: '|EOF', stderr: '' });
      expect(f.requests.filter(s => s.startsWith('cancel '))).toHaveLength(1);
    });

  for (const reason of [undefined, 'SECRET command/path', 'x'.repeat(9000), { secret: 'SECRET' }, ['drain_unconfirmed'], '__proto__', 'stdin_error'])
    it(`rejects untrusted reason ${typeof reason === 'string' ? reason.slice(0, 24) : typeof reason}`, async () => {
      const f = await fixture();
      f.frame({ event: 'unknown', reason });
      f.supervisor.stderr.write('SECRET supervisor stderr');
      f.supervisor.emit('close', 0);
      expect(await f.closed).toBeNull();
      expect(f.child.supervisorReason).toBe(typeof reason === 'string' && reason.length > 8192 ? 'invalid_frame' : 'supervisor_unknown');
      expect(f.text()).toEqual({ stdout: '|EOF', stderr: '' });
    });

  it('does not trust a fixed reason with a forged nonce', async () => {
    const f = await fixture();
    f.frame({ event: 'unknown', nonce: 'forged', reason: 'drain_unconfirmed' });
    f.supervisor.emit('close', 0);
    expect(await f.closed).toBeNull();
    expect(f.child.supervisorReason).toBe('invalid_frame');
  });

  it('retains an unknown reason through the existing cancellation bound without early completion', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const close = vi.fn(); f.child.on('close', close);
    f.frame({ event: 'unknown', reason: 'drain_unconfirmed' });
    await vi.advanceTimersByTimeAsync(CANCEL_BOUND_MS - 1);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.closed).toBeNull();
    expect(close).toHaveBeenCalledExactlyOnceWith(null);
    expect(f.child.supervisorReason).toBe('drain_unconfirmed');
    expect(f.child.treeTerminated).toBe(false);
  });

  for (const code of [0, 7]) it(`preserves proven child exit ${code} and ignores reason fields on finished`, async () => {
    const f = await fixture();
    f.frame({ event: 'finished', active: 0, exitCode: code, cancelled: false, reason: 'SECRET' });
    f.supervisor.emit('close', 0);
    expect(await f.closed).toBe(code);
    expect(f.child.treeTerminated).toBe(true);
    expect(f.child.supervisorReason).toBeUndefined();
    expect(f.text()).toEqual({ stdout: '|EOF', stderr: '' });
  });

  for (const failure of ['stdin', 'missing proof', 'nonzero supervisor', 'residual', 'oversized control'])
    it(`keeps ${failure} unknown with a bounded transport reason`, async () => {
      const f = await fixture();
      if (failure === 'stdin') f.supervisor.stdin.emit('error', Error('SECRET'));
      else {
        if (failure !== 'missing proof') f.frame({ event: 'finished', active: 0, exitCode: 0, cancelled: false });
        if (failure === 'residual') f.supervisor.stdout.write('SECRET');
        if (failure === 'oversized control') f.supervisor.stdout.write('x'.repeat(131073));
        f.supervisor.emit('close', failure === 'nonzero supervisor' ? 1 : 0);
      }
      expect(await f.closed).toBeNull();
      expect(f.child.treeTerminated).toBe(false);
      expect(f.child.supervisorReason).toBe(({ stdin: 'stdin_error', 'missing proof': 'incomplete_completion', 'nonzero supervisor': 'supervisor_exit', residual: 'incomplete_completion', 'oversized control': 'control_limit' })[failure]);
    });

  it('exposes the bounded reason on native results without protocol in stdout/stderr', async () => {
    const supervisor = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), unref: vi.fn() });
    spawnMock.mockReturnValue(supervisor);
    supervisor.stdin.once('data', b => {
      const { nonce } = JSON.parse(String(b));
      supervisor.stdout.write(JSON.stringify({ event: 'unknown', nonce, reason: 'drain_unconfirmed' }) + '\n');
      supervisor.emit('close', 0);
    });
    const r = await runProgram(process.execPath);
    expect(r.exitCode).toBeNull();
    expect(r.treeTerminated).toBe(false);
    expect(r.supervisorReason).toBe('drain_unconfirmed');
    expect(r.stdout).toBe(''); expect(r.stderr).toBe('');
  });
});

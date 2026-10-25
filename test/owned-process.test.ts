import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { spawnOwned, CANCEL_BOUND_MS } from '../src/owned-process.js';

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

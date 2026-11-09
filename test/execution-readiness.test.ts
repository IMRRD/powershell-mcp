import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { OwnedChild } from '../src/owned-process.js';
import type { ExecutionStore } from '../src/execution-lifecycle.js';
import { waitForExecutionStdout } from './helpers/execution-readiness.js';

describe('durable fixture stdout readiness', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());
  const fixture = () => {
    const status = { id: 'synthetic', state: 'running', exitCode: null, stdoutBytes: 0, stderrBytes: 0,
      outputComplete: true, createdAt: '', updatedAt: '' } as ReturnType<ExecutionStore['status']>;
    const child: OwnedChild = Object.assign(new ChildProcess(), { stdout: new PassThrough(), pid: 123,
      treeTerminated: false, cancel() {} });
    const store = { status: vi.fn(() => ({ ...status })) };
    const wait = (deadline = 11_000) => waitForExecutionStdout(store, 'owner', status.id, child, 13, deadline);
    const clean = () => {
      expect(child.stdout!.listenerCount('data')).toBe(0);
      expect(child.listenerCount('close') + child.listenerCount('error')).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    };
    return { status, child, store, wait, clean };
  };
  it('waits beyond 100 polling turns for complete observed output before cancellation', async () => {
    const { status, child, wait, clean } = fixture();
    let ready = false;
    const pending = wait().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(100 * 20);
    expect(ready).toBe(false);
    expect(status.stdoutBytes).toBe(0);
    status.stdoutBytes = 6; child.stdout!.emit('data', Buffer.from('before'));
    await Promise.resolve();
    expect(ready).toBe(false);
    status.stdoutBytes = 13; child.stdout!.emit('data', Buffer.from('-cancel'));
    await pending;
    expect(ready).toBe(true);
    clean();
  });
  it('accepts output already observed by a live caller', async () => {
    const { status, wait, clean } = fixture();
    status.stdoutBytes = 13;
    await wait();
    clean();
  });
  it.each(['unknown', 'failed', 'completed', 'cancelled'] as const)('rejects %s even with enough bytes', async state => {
    const { status, wait, clean } = fixture();
    status.state = state; status.stdoutBytes = 13;
    await expect(wait()).rejects.toThrow(`"state":"${state}"`);
    clean();
  });
  it('retains state at the absolute deadline and releases its listeners', async () => {
    const { wait, clean } = fixture();
    const failed = expect(wait()).rejects.toThrow(/deadline expired: .*"state":"running".*"stdoutBytes":0.*"supervisorPid":123/);
    await vi.advanceTimersByTimeAsync(11_000);
    await failed;
    clean();
  });
  it.each(['close', 'error'] as const)('rejects an early child %s', async event => {
    const { child, wait, clean } = fixture();
    const failed = expect(wait()).rejects.toThrow(/Child (closed|errored) before stdout readiness/);
    child.emit(event, event === 'error' ? Error('synthetic launch error') : null);
    await failed;
    clean();
  });
  it('propagates a caller status error without retrying it', async () => {
    const { store, wait, clean } = fixture();
    const error = Error('synthetic caller state failure');
    store.status.mockImplementation(() => { throw error; });
    await expect(wait()).rejects.toBe(error);
    expect(store.status).toHaveBeenCalledTimes(1);
    clean();
  });
});

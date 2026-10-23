import { describe, it, expect } from 'vitest';
import { RemoteBatchStore } from '../src/remote-batch.js';
import { TOOL_NAMES, instrumentTool } from '../src/tool-instrumentation.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
describe('bounded remote batch', () => {
  it('includes batch lifecycle in the fixed telemetry allowlist', async () => {
    for (const name of ['start_remote_batch', 'remote_batch_status', 'cancel_remote_batch']) {
      expect(TOOL_NAMES).toContain(name);
      const calls: unknown[] = [];
      const wrapped = instrumentTool(name as any, async () => ({ content: [{ type: 'text', text: '{"status":"running"}' }] }),
        (...args) => calls.push(args));
      await wrapped();
      expect(calls[0]).toMatchObject([name, 'unknown', expect.any(String), 'remote']);
    }
  });
  it('retains exact ordered cardinality through mixed outcomes and bounded concurrency', async () => {
    let active = 0, peak = 0;
    const store = new RemoteBatchStore(async target => {
      active++; peak = Math.max(peak, active);
      await tick(); active--;
      if (target.host === 'bad') throw Error('unreachable');
      return { status: 'completed' as const, output: target.host };
    });
    const id = store.start({ targets: ['a','bad','c','d'].map(host => ({ transport: 'ssh', host, username: 'u', command: 'echo ok', password: 'secret', hostKeyPins: ['SHA256:' + 'A'.repeat(43)] })), concurrency: 2, timeoutMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 80));
    const state = store.status(id)!;
    expect(state.results.map(r => r.status)).toEqual(['completed','unknown','completed','completed']);
    expect(state.results).toHaveLength(4);
    expect(peak).toBe(2);
    expect(JSON.stringify(state)).not.toContain('secret');
  });
  it('cancels queued targets and reports active outcomes as unknown without proof of termination', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const store = new RemoteBatchStore(async () => { await gate; return { status: 'completed', output: 'late' }; });
    const id = store.start({ targets: ['a','b','c'].map(host => ({ transport: 'ssh', host, username: 'u', command: 'x', password: 'secret' })), concurrency: 1, timeoutMs: 1000 });
    expect(store.cancel(id)?.results.map(r => r.status)).toEqual(['unknown','cancelled','cancelled']);
    release(); await tick();
    expect(store.status(id)?.results.map(r => r.status)).toEqual(['unknown','cancelled','cancelled']);
  });
  it('deadline holds the real execution slot and rejects further admission', async () => {
    let release!: (value: any) => void, launched = 0;
    const gate = new Promise<any>(resolve => { release = resolve; });
    const store = new RemoteBatchStore(async () => { launched++; return gate; });
    const id = store.start({ targets: [{ transport: 'ssh', host: 'a', username: 'u', command: 'x', password: 'secret' }, { transport: 'ssh', host: 'b', username: 'u', command: 'x' }], concurrency: 1, timeoutMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 45));
    expect(store.status(id)?.results.map(r => r.status)).toEqual(['unknown','queued']);
    expect(launched).toBe(1);
    for (let i = 0; i < 7; i++) store.start({ targets: [{ transport: 'ssh', host: `c${i}`, username: 'u', command: 'x' }], concurrency: 1, timeoutMs: 20 });
    expect(() => store.start({ targets: [{ transport: 'ssh', host: 'overflow', username: 'u', command: 'x' }], concurrency: 1, timeoutMs: 20 })).toThrow(/capacity/i);
    store.cancel(id);
    release({ status: 'completed', output: 'late' }); await tick();
    expect(launched).toBe(8);
    expect(store.status(id)?.results.map(r => r.status)).toEqual(['unknown','cancelled']);
  });
  it('keeps exact cardinality across a hung target, a failure and a later success', async () => {
    let release!: () => void;
    const hung = new Promise<void>(resolve => { release = resolve; });
    const store = new RemoteBatchStore(async target => {
      if (target.host === 'hung') { await hung; return { status: 'completed', output: 'late' }; }
      if (target.host === 'bad') throw Error('unreachable');
      return { status: 'completed', output: 'ok' };
    });
    const targets = ['hung', 'bad', 'good'].map(host => ({ transport: 'ssh' as const, host, username: 'u', command: 'x' }));
    const id = store.start({ targets, concurrency: 2, timeoutMs: 20 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const snapshot = store.status(id)!;
    expect(snapshot.results.map(r => [r.index, r.host, r.status])).toEqual([
      [0, 'hung', 'unknown'], [1, 'bad', 'unknown'], [2, 'good', 'completed'],
    ]);
    expect(snapshot.status).toBe('partial');
    release(); await tick();
    expect(store.status(id)?.results).toEqual(snapshot.results);
  });
  it('expires settled jobs and bounds retained admission', async () => {
    let now = 0;
    const store = new RemoteBatchStore(async () => ({ status: 'completed', output: 'x' }), () => now);
    const req = { targets: [{ transport: 'ssh' as const, host: 'a', username: 'u', command: 'x' }], concurrency: 1, timeoutMs: 1000 };
    const id = store.start(req); await tick();
    for (let i = 1; i < 32; i++) { store.start(req); await tick(); }
    expect(() => store.start(req)).toThrow(/capacity/i);
    now = 61000;
    expect(store.status(id)).toBeUndefined();
    expect(store.cancel(id)).toBeUndefined();
    expect(() => store.start(req)).not.toThrow();
  });
  it('rejects a multibyte request one byte over 1 MiB before execution', () => {
    let invoked = 0;
    const store = new RemoteBatchStore(async () => { invoked++; return { status: 'completed' }; });
    const request = { targets: [{ transport: 'ssh' as const, host: 'a', username: 'u', command: '', password: '' }], concurrency: 1, timeoutMs: 1000 };
    const size = (command: string) => Buffer.byteLength(JSON.stringify({ ...request, targets: [{ ...request.targets[0], command }] }), 'utf8');
    const overhead = size('');
    request.targets[0].command = 'é'.repeat(Math.floor((1_048_576 - overhead) / 2)) + 'a'.repeat((1_048_576 - overhead) % 2);
    expect(size(request.targets[0].command)).toBe(1_048_576);
    expect(store.start(request)).toMatch(/^[a-f0-9]{48}$/);
    request.targets[0].command += 'a';
    expect(size(request.targets[0].command)).toBe(1_048_577);
    expect(() => store.start(request)).toThrow(/input capacity/);
    expect(invoked).toBe(1);
  });
  it('retains only two MiB of serialized UTF-8 results, including exact boundary', async () => {
    const payload = '界'.repeat(699050);
    const store = new RemoteBatchStore(async target => ({ status: 'completed', output: target.host === 'first' ? payload : '界' }));
    const request = (host: string) => ({ targets: [{ transport: 'ssh' as const, host, username: 'u', command: 'x' }], concurrency: 1, timeoutMs: 1000 });
    const first = store.start(request('first')); await tick();
    expect(Buffer.byteLength(JSON.stringify(store.status(first)!.results[0].result), 'utf8')).toBe(2_097_152);
    const second = store.start(request('second')); await tick();
    expect(store.status(second)!.results[0]).toMatchObject({ status: 'unknown', reason: expect.stringMatching(/capacity/) });
    expect(store.status(second)!.results[0].result).toBeUndefined();
  });
});

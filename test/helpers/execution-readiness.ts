import type { ExecutionStore } from '../../src/execution-lifecycle.js';
import type { OwnedChild } from '../../src/owned-process.js';

// Readiness is output observed by the real caller while its child is live.
// The caller reserves cancellation/cleanup time before supplying this deadline.
export function waitForExecutionStdout(store: Pick<ExecutionStore, 'status'>, owner: string, id: string,
  child: OwnedChild, minimumBytes: number, deadline: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const diagnostic = () => JSON.stringify({ status: store.status(owner, id),
      supervisorPid: child.pid ?? null, exitCode: child.exitCode,
      treeTerminated: child.treeTerminated, supervisorReason: child.supervisorReason ?? null });
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      child.stdout?.off('data', check);
      child.off('close', closed);
      child.off('error', failed);
      if (error) reject(error); else resolve();
    };
    const fail = (reason: string, cause?: unknown) => {
      try { finish(new Error(`${reason}: ${diagnostic()}`, { cause })); }
      catch (error) { finish(error); }
    };
    const check = () => {
      try {
        const status = store.status(owner, id);
        if (status.state !== 'running') fail('Execution stopped before stdout readiness');
        else if (performance.now() >= deadline) fail('Execution stdout readiness deadline expired');
        else if (status.stdoutBytes >= minimumBytes) finish();
      } catch (error) { finish(error); }
    };
    const closed = () => fail('Child closed before stdout readiness');
    const failed = (error: Error) => fail('Child errored before stdout readiness', error);
    const timer = setTimeout(() => fail('Execution stdout readiness deadline expired'), Math.max(0, deadline - performance.now()));
    child.stdout?.on('data', check);
    child.once('close', closed);
    child.once('error', failed);
    check();
  });
}

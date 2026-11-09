import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });
it.skipIf(process.platform !== 'win32')('bounds pending work before storage, discards queued captures on disable and preserves handler behavior', async () => {
  vi.resetModules();
  vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS', '1');
  vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS_DIR', 'C:\\unused-synthetic-store');
  vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION', 'synthetic-test');
  // Spy on the freshly loaded class used by the fresh diagnostics module.
  const { RestrictedDiagnosticsStore: Store } = await import('../src/diagnostics-store.js');
  const append = vi.spyOn(Store.prototype, 'append');
  const { beginDiagnostic, disableDiagnostics, diagnosticsStatus, drainDiagnostics } = await import('../src/internal-diagnostics.js');
  for (let i = 0; i < 10000; i++) beginDiagnostic('run_program')?.(3, { structuredContent: { terminationStatus: 'completed' } });
  expect(diagnosticsStatus()).toEqual({ pending: 6, dropped: 9994 });
  disableDiagnostics();
  await drainDiagnostics();
  expect(append).not.toHaveBeenCalled();
  expect(diagnosticsStatus()).toEqual({ pending: 0, dropped: 10000 });
  expect(beginDiagnostic('run_program')).toBeUndefined();
});

it.skipIf(process.platform !== 'win32')('never reads raw error getters and contains backend failures', async () => {
  vi.resetModules();
  vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS', '1');
  vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS_DIR', 'C:\\unused-synthetic-store');
  vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION', 'synthetic-test');
  const { RestrictedDiagnosticsStore: Store } = await import('../src/diagnostics-store.js');
  const append = vi.spyOn(Store.prototype, 'append').mockRejectedValue(new Error('SYNTHETIC-private-backend-failure'));
  const { instrumentTool } = await import('../src/tool-instrumentation.js');
  const { drainDiagnostics, diagnosticsStatus } = await import('../src/internal-diagnostics.js');
  const error = new Error('SYNTHETIC-secret');
  const getter = vi.fn(() => { throw Error('private getter accessed'); });
  // Replace V8's lazy stack before the message accessor; redefining it may materialize it.
  for (const name of ['stack', 'message', 'errno']) Object.defineProperty(error, name, { get: getter });
  const metrics = vi.fn();
  let sameError = false;
  try { await instrumentTool('run_program', async () => { throw error; }, metrics)(); }
  catch (caught) { sameError = caught === error; }
  expect(sameError).toBe(true);
  await drainDiagnostics();
  expect(getter).not.toHaveBeenCalled();
  expect(append).toHaveBeenCalledOnce();
  expect(append.mock.calls[0][0]).toEqual([
    expect.objectContaining({ stage: 'run_program.handler', type: 'started' }),
    expect.objectContaining({ stage: 'run_program.result', type: 'Error', nativeCode: null }),
  ]);
  expect(JSON.stringify(append.mock.calls)).not.toContain('SYNTHETIC');
  expect(diagnosticsStatus()).toEqual({ pending: 0, dropped: 1 });
  expect(metrics).toHaveBeenCalledWith('run_program', 'error', expect.any(String), 'execution');
});

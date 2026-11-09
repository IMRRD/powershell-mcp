import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { instrumentTool } from '../src/tool-instrumentation.js';
import { diagnosticPair, validDiagnosticPair, DIAGNOSTICS_POLICY } from '../src/diagnostics-schema.js';
import { diagnosticsStatus, drainDiagnostics, disableDiagnostics } from '../src/internal-diagnostics.js';

const privateText = 'SYNTHETIC-password=secret-CUSTOMER-target.invalid';
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('restricted diagnostics boundary', () => {
  it('defaults inactive and never treats cohort/user enrollment as diagnostic consent', async () => {
    vi.stubEnv('POWERSHELL_MCP_DIAGNOSTICS', '');
    vi.stubEnv('POWERSHELL_MCP_TELEMETRY_COHORT', 'internal');
    vi.stubEnv('POWERSHELL_MCP_TELEMETRY_USER_ID', randomUUID());
    const metrics = vi.fn();
    const result = { structuredContent: { terminationStatus: 'completed' }, stdout: privateText };
    expect(await instrumentTool('run_program', async () => result, metrics)({ command: privateText })).toBe(result);
    await drainDiagnostics();
    expect(diagnosticsStatus().pending).toBe(0);
    expect(metrics).toHaveBeenCalledWith('run_program', 'success', expect.any(String), 'execution');
    disableDiagnostics();
  });

  it('strictly validates the entire pair including stages, types, bounds and correlation', () => {
    const pair = diagnosticPair('run_program', randomUUID(), 12.9, 'transport_error', null);
    expect(validDiagnosticPair(pair)).toBe(true);
    const copy = () => structuredClone(pair) as any;
    for (const change of [
      (p: any) => { p[0].command = privateText; },
      (p: any) => { p[1].stage = privateText; },
      (p: any) => { p[1].type = privateText; },
      (p: any) => { p[1].nativeCode = privateText; },
      (p: any) => { p[1].nativeCode = 2 ** 40; },
      (p: any) => { p[1].elapsedMs = -1; },
      (p: any) => { p[1].elapsedMs = Infinity; },
      (p: any) => { p[1].correlationId = randomUUID(); },
      (p: any) => { p[1].stage = 'ssh_exec.result'; },
      (p: any) => { p.push(p[0]); },
    ]) { const value = copy(); change(value); expect(validDiagnosticPair(value)).toBe(false); }
    expect(DIAGNOSTICS_POLICY).toBe('restricted-local-v1');
  });

  it('drops all free text instead of attempting to redact arbitrary secret transformations', () => {
    const pair = diagnosticPair('ssh_exec', randomUUID(), 1e20, privateText, privateText);
    expect(validDiagnosticPair(pair)).toBe(true);
    expect(pair[1]).toMatchObject({ type: 'unknown', nativeCode: null, elapsedMs: 300000 });
    expect(JSON.stringify(pair)).not.toContain(privateText);
  });
});

import { describe, it, expect } from 'vitest';
import { RemoteBatchStore } from '../src/remote-batch.js';
import { instrumentTool } from '../src/tool-instrumentation.js';
import { WINRM_REASONS } from '../src/winrm-reason.js';
import { validQueuedEvent } from '../src/telemetry-wire.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('telemetry outcome propagation', () => {
  it.each(['failed', 'timeout', 'unknown'] as const)('keeps a partial batch with a %s target out of success', async status => {
    // Exercise the real snapshot producer without dispatching a remote command.
    const store = new RemoteBatchStore(async () => ({ status }));
    const id = store.start({
      targets: [{ transport: 'winrm', host: 'synthetic.invalid', command: 'synthetic' }],
      concurrency: 1, timeoutMs: 1000,
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(store.status(id)).toMatchObject({ status: 'partial', results: [{ status }] });
    const rows: unknown[][] = [];
    const poll = instrumentTool('remote_batch_status', async () => ({
      content: [{ type: 'text', text: JSON.stringify(store.status(id)) }],
    }), (...row) => rows.push(row));
    await poll();
    expect(rows).toEqual([['remote_batch_status', 'unknown', expect.any(String), 'remote']]);
  });

  it('retains completed, running and cancelled batch RPC classifications without per-target records', async () => {
    const rows: unknown[][] = [];
    for (const status of ['completed', 'running', 'cancelled']) {
      await instrumentTool('remote_batch_status', async () => ({
        content: [{ type: 'text', text: JSON.stringify({ status, results: [{ winrmReason: 'PRIVATE' }] }) }],
      }), (...row) => rows.push(row))();
    }
    expect(rows).toEqual(['success', 'unknown', 'cancelled'].map(outcome => ['remote_batch_status', outcome, expect.any(String), 'remote']));
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
  });

  it('persists every direct WinRM reason through the real recorder and worker with separate call streams', () => {
    const home = mkdtempSync(join(tmpdir(), 'telemetry-contract-'));
    try {
      const script = `
        import { instrumentTool } from './dist/tool-instrumentation.js';
        import { recordTool, flushCounters, telemetryStatus } from './dist/telemetry.js';
        import { WINRM_REASONS } from './dist/winrm-reason.js';
        for (const winrmReason of WINRM_REASONS) {
          const terminationStatus = winrmReason === 'completed' ? 'completed' :
            winrmReason === 'timeout' || winrmReason === 'cancelled' ? winrmReason : 'transport_error';
          await instrumentTool('winrm_exec', async () => ({ structuredContent: {
            terminationStatus, detail: { winrmReason }, stdout: 'PRIVATE', target: 'PRIVATE'
          } }), recordTool)({ command: 'PRIVATE', password: 'PRIVATE' });
        }
        flushCounters('0.8.0');
        while (telemetryStatus().outstanding) await new Promise(resolve => setTimeout(resolve, 10));
        if (telemetryStatus().dropped || telemetryStatus().failures) process.exitCode = 1;
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(), timeout: 15000, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home, POWERSHELL_MCP_NO_TELEMETRY: '0',
          POWERSHELL_MCP_TELEMETRY_USER_ID: '', POWERSHELL_MCP_TELEMETRY_COHORT: '',
          POWERSHELL_MCP_TELEMETRY_URL: 'http://127.0.0.1:1/telemetry' },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const root = join(home, '.powershell-mcp-telemetry');
      const events = readdirSync(root).filter(name => /^slot-\d{3}$/.test(name)).map(slot => {
        const dir = join(root, slot);
        const files = readdirSync(dir).filter(name => name === 'event.json' || name.startsWith('event.claim-'));
        expect(files).toHaveLength(1);
        return JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
      });
      expect(events).toHaveLength(2);
      expect(events.every(event => validQueuedEvent(event, event.eventId))).toBe(true);
      expect(JSON.stringify(events)).not.toContain('PRIVATE');
      expect(events.find(event => event.event === 'tool_counts').counts).toEqual({ winrm_exec: WINRM_REASONS.length });
      const metric = events.find(event => event.event === 'tool_metrics').metrics.winrm_exec;
      expect(metric.winrmReasons).toEqual(Object.fromEntries(WINRM_REASONS.map(reason => [reason, 1])));
      expect(metric.outcomes).toEqual({ success: 1, error: WINRM_REASONS.length - 3, timeout: 1, cancelled: 1 });
      for (const axis of Object.values(metric) as Record<string, number>[]) {
        expect(Object.values(axis).reduce((a, b) => a + b, 0)).toBe(WINRM_REASONS.length);
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 20000);
});

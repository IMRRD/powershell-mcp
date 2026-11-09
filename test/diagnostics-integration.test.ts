import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestrictedDiagnosticsStore } from '../src/diagnostics-store.js';
import { DIAGNOSTICS_POLICY, validDiagnosticPair } from '../src/diagnostics-schema.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const secret = 'SYNTHETIC-CUSTOMER-command-password-token-private-key-stack-target.invalid';
describe.skipIf(process.platform !== 'win32')('connected restricted diagnostics capture', () => {
  it('captures a genuine missing-executable failure through the actual MCP server and retrieves it locally', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mcp-diagnostic-mcp-'));
    const directory = join(parent, 'private');
    const store = new RestrictedDiagnosticsStore(directory, 'isolated-mcp');
    const client = new Client({ name: 'isolated-diagnostics-test', version: '1' });
    try {
      expect(await store.consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'ok' });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], stderr: 'pipe', env: {
        ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_DIAGNOSTICS: '1', POWERSHELL_MCP_DIAGNOSTICS_DIR: directory, POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION: 'isolated-mcp',
      } }));
      const start = performance.now();
      const reply = await client.callTool({ name: 'run_program', arguments: { program: join(parent, 'missing-SYNTHETIC-CUSTOMER.exe'), args: [secret] } });
      const rpcMs = Math.round(performance.now() - start);
      expect(reply.isError).toBe(true);
      expect(reply.structuredContent?.terminationStatus).toBe('transport_error');
      // Observe publication without taking the fail-fast storage lock from capture.
      // An eager read can legitimately win the admission race and drop best-effort capture.
      for (let attempt = 0; attempt < 200 && !readdirSync(directory).some(n => n.startsWith('record-')); attempt++)
        await new Promise(resolve => setTimeout(resolve, 50));
      const read = await store.read();
      expect(read?.status).toBe('ok'); expect(read?.pairs).toHaveLength(1);
      expect(read!.pairs![0][1]).toMatchObject({ stage: 'run_program.result', type: 'transport_error', nativeCode: null });
      expect(validDiagnosticPair(read!.pairs![0])).toBe(true);
      expect(JSON.stringify(read)).not.toMatch(/SYNTHETIC|CUSTOMER|missing|target\.invalid|stdout|stderr|stack|executionId/);
      console.log(JSON.stringify({ check: 'isolated-mcp-missing-executable', rpcMs, captureAndReadMs: Math.round(performance.now() - start) }));
      expect(await store.revoke()).toEqual({ status: 'ok' });
    } finally { await client.close(); rmSync(parent, { recursive: true, force: true }); }
  }, 45000);

  it('runs actual wrapped handlers, correlates stage/result, redacts by exclusion, and keeps public records unchanged', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mcp-diagnostic-capture-'));
    const directory = join(parent, 'private');
    try {
      const store = new RestrictedDiagnosticsStore(directory, 'synthetic-canary');
      expect(await store.consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'ok' });
      const script = `
        import {instrumentTool} from './dist/tool-instrumentation.js';
        import {drainDiagnostics,diagnosticsStatus,disableDiagnostics} from './dist/internal-diagnostics.js';
        const secret=${JSON.stringify(secret)};
        const response={structuredContent:{terminationStatus:'transport_error',target:secret,stdout:secret,stderr:secret,executionId:secret,detail:{message:secret,exceptionType:secret}},content:[{type:'text',text:secret}]};
        const rows=[];
        const before=JSON.stringify(response);
        const handler=instrumentTool('winrm_exec',async()=>response,(...row)=>rows.push(row));
        if(await handler({command:secret,password:secret,host:secret})!==response || JSON.stringify(response)!==before) throw Error('changed response');
        const error=new TypeError(secret); error.errno=-4058; error.code=secret;
        Object.defineProperty(error,'stack',{get(){throw Error('stack was read')}});
        try {await instrumentTool('run_program',async()=>{throw error},(...row)=>rows.push(row))({args:[secret]});throw Error('missing failure')}catch(e){if(e!==error)throw e}
        await drainDiagnostics();
        if(diagnosticsStatus().pending || diagnosticsStatus().dropped)throw Error('capture failed');
        disableDiagnostics();
        await handler({command:secret}); await drainDiagnostics();
        if(JSON.stringify(rows).includes(secret))throw Error('public leak');
        console.log(JSON.stringify(rows));
      `;
      const started = performance.now();
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 25000, windowsHide: true,
        env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_DIAGNOSTICS: '1', POWERSHELL_MCP_DIAGNOSTICS_DIR: directory, POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION: 'synthetic-canary' },
      });
      expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
      const rows = JSON.parse(child.stdout);
      expect(rows).toEqual([
        ['winrm_exec', 'error', expect.any(String), 'remote', 'unknown'],
        ['run_program', 'error', expect.any(String), 'execution'],
        ['winrm_exec', 'error', expect.any(String), 'remote', 'unknown'],
      ]);
      const reply = await store.read();
      expect(reply.status).toBe('ok'); expect(reply.pairs).toHaveLength(2);
      expect(reply.pairs!.every(validDiagnosticPair)).toBe(true);
      expect(reply.pairs!.map(p => p[1].type).sort()).toEqual(['TypeError', 'transport_error']);
      expect(new Set(reply.pairs!.map(p => p[0].correlationId)).size).toBe(2);
      expect(JSON.stringify(reply)).not.toContain(secret);
      expect(reply.pairs!.find(p => p[1].type === 'TypeError')![1].nativeCode).toBe(-4058);
      console.log(JSON.stringify({ check: 'isolated-capture-roundtrip', durationMs: Math.round(performance.now() - started), pairs: 2 }));
      expect(await store.revoke()).toEqual({ status: 'ok' });
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 45000);

  it('does no filesystem work by default and cannot capture with only an activation flag or mismatched consent', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'mcp-diagnostic-inactive-'));
    const directory = join(parent, 'private');
    const script = `
      import {instrumentTool} from './dist/tool-instrumentation.js';
      import {drainDiagnostics} from './dist/internal-diagnostics.js';
      await instrumentTool('run_program',async()=>({structuredContent:{terminationStatus:'completed'}}),()=>{})();
      await drainDiagnostics();
    `;
    try {
      for (const flag of ['', '1']) {
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 15000, env: {
          ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_DIAGNOSTICS: flag, POWERSHELL_MCP_DIAGNOSTICS_DIR: directory, POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION: 'synthetic-canary',
        } });
        expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
        expect(readdirSync(parent)).toEqual([]);
      }
      const store = new RestrictedDiagnosticsStore(directory, 'different-installation');
      expect(await store.consent(DIAGNOSTICS_POLICY)).toEqual({ status: 'ok' });
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true, timeout: 15000, env: {
        ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_DIAGNOSTICS: '1', POWERSHELL_MCP_DIAGNOSTICS_DIR: directory, POWERSHELL_MCP_DIAGNOSTICS_INSTALLATION: 'synthetic-canary',
      } });
      expect(child.status, child.stderr).toBe(0);
      expect((await store.read()).pairs).toEqual([]);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 45000);
});

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runProgram } from '../src/program.js';
import { runPowerShell } from '../src/powershell.js';
import { ExecutionStore } from '../src/execution-lifecycle.js';
import { spawnOwned } from '../src/owned-process.js';

const exe = process.env.MCP_REQUIRED_ENGINE === 'powershell' ? 'powershell.exe' : 'pwsh';
const callers = ['program', 'powershell', 'durable'] as const;
type Caller = typeof callers[number];

async function invoke(caller: Caller, base: string, cwd?: string, policy = false) {
  const source = policy ? 'process.stdout.write(process.env.PSExecutionPolicyPreference)' : 'process.stdout.write(process.cwd())';
  if (caller === 'program') return runProgram(process.execPath, ['-e', source], { cwd });
  if (caller === 'powershell') return runPowerShell(policy ? '[Console]::Write($env:PSExecutionPolicyPreference)' : '[Console]::Write((Get-Location).Path)', { exe, cwd });
  const store = new ExecutionStore(join(base, 'store'));
  const run = store.start('fixture', 'once', process.execPath, ['-e', source], cwd);
  try {
    const deadline = Date.now() + 15000;
    let status = store.status('fixture', run.id);
    while (['reserved', 'running'].includes(status.state) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
      status = store.status('fixture', run.id);
    }
    expect(status.state).toBe('completed');
    const page = store.read('fixture', run.id, 'stdout', 0, 4096);
    return { exitCode: status.exitCode, stdout: Buffer.from(page.data, 'base64').toString(), timedOut: false };
  } finally { store.cancel('fixture', run.id); }
}

describe('owned process actual adapters', () => {
  for (const caller of callers) {
    it(`${caller} recognizes directory aliases while rejecting another directory`, async () => {
      const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'owned-alias-'));
      const work = join(base, 'real directory'), alias = join(base, 'alias');
      mkdirSync(work);
      symlinkSync(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        const result = await invoke(caller, base, alias);
        expect(result.exitCode).toBe(0);
        expect(realpathSync.native(result.stdout)).toBe(realpathSync.native(work));
        expect(realpathSync.native(result.stdout)).not.toBe(realpathSync.native(base));
      } finally { rmSync(base, { recursive: true, force: true }); }
    });
    for (const kind of ['absolute', 'relative', 'omitted'] as const) it(`${caller} preserves ${kind} cwd`, async () => {
      const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'owned-cwd-'));
      const work = join(base, 'work with spaces'); mkdirSync(work);
      const cwd = kind === 'omitted' ? undefined : kind === 'absolute' ? work : relative(process.cwd(), work);
      try {
        const result = await invoke(caller, base, cwd);
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        const actual = realpathSync.native(result.stdout);
        const expected = realpathSync.native(kind === 'omitted' ? process.cwd() : work);
        expect(actual).toBe(expected);
        // Canonicalization must still reject a real change of working directory.
        expect(actual).not.toBe(realpathSync.native(kind === 'omitted' ? work : base));
      } finally { rmSync(base, { recursive: true, force: true }); }
    });

    it.skipIf(process.platform !== 'win32')(`${caller} bypasses synthetic Restricted only in helper process and preserves parent env`, async () => {
      const base = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'owned-policy-'));
      const before = process.env.PSExecutionPolicyPreference;
      vi.stubEnv('PSExecutionPolicyPreference', 'Restricted');
      try {
        const result = await invoke(caller, base, undefined, true);
        expect(result.exitCode).toBe(0);
        expect(result.timedOut).toBe(false);
        expect(result.stdout).toBe('Bypass');
        expect(process.env.PSExecutionPolicyPreference).toBe('Restricted');
      } finally {
        vi.unstubAllEnvs();
        expect(process.env.PSExecutionPolicyPreference).toBe(before);
        rmSync(base, { recursive: true, force: true });
      }
    });
  }

  it('drains both streams before proving concurrent short-lived children finished', async () => {
    await Promise.all([0, 7, 0, 7].map(code => new Promise<void>((resolve, reject) => {
      const child = spawnOwned(process.execPath, ['-e', `process.stdout.write('ready💫');process.stderr.write('diagnostic');process.exitCode=${code}`]);
      let stdout = '', stderr = '';
      child.stdout!.setEncoding('utf8').on('data', b => { stdout += b; });
      child.stderr!.setEncoding('utf8').on('data', b => { stderr += b; });
      child.once('error', reject);
      child.once('close', actual => {
        try {
          expect(actual).toBe(code);
          expect(child.treeTerminated).toBe(true);
          expect(stdout).toBe('ready💫');
          expect(stderr).toBe('diagnostic');
          resolve();
        } catch (error) { reject(error); }
      });
    })));
  });
});

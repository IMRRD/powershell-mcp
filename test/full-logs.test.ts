import { describe, it, expect, vi } from 'vitest';
import { runProgram } from '../src/program.js';
import { runPowerShell } from '../src/powershell.js';
import { logStore } from '../src/full-logs.js';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';

const scratchRoot = () => process.env.TMPDIR ?? process.env.RUNNER_TEMP ?? tmpdir();
const logParent = () => process.env.POWERSHELL_MCP_LOG_PARENT ?? process.env.TMPDIR ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : tmpdir());

describe('opt-in output logs', () => {
  it('does not launch a child when total log quota is exhausted', async () => {
    const held: ReturnType<typeof logStore.create>[] = [];
    let scratch: string | undefined;
    try {
      scratch = mkdtempSync(join(scratchRoot(), 'quota-marker-'));
      const marker = join(scratch, 'marker');
      for (let i = 0; i < 8; i++) held.push(logStore.create());
      await expect(runProgram(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], { logOutput: true })).rejects.toThrow('Log quota unavailable');
      await expect(runPowerShell(`'bad'`, { logOutput: true })).rejects.toThrow('Log quota unavailable');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(() => lstatSync(marker)).toThrow();
    } finally { for (const item of held) logStore.delete(item.finish().handle); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  });
  it('does not launch on injected log-create failure', async () => {
    let scratch: string | undefined;
    let spy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      scratch = mkdtempSync(join(scratchRoot(), 'io-marker-'));
      const marker = join(scratch, 'marker');
      spy = vi.spyOn(logStore, 'create').mockImplementation(() => { throw Error('synthetic IO failure'); });
      await expect(runProgram(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`], { logOutput: true })).rejects.toThrow('synthetic IO failure');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(() => lstatSync(marker)).toThrow();
    } finally { spy?.mockRestore(); if (scratch) rmSync(scratch, { recursive: true, force: true }); }
  });
  it('releases partial quota reservations when fixture setup fails', () => {
    const held: ReturnType<typeof logStore.create>[] = [];
    const create = logStore.create;
    let calls = 0;
    const spy = vi.spyOn(logStore, 'create').mockImplementation(() => {
      if (++calls === 4) throw Error('synthetic setup failure');
      return create();
    });
    try {
      expect(() => { for (let i = 0; i < 8; i++) held.push(logStore.create()); }).toThrow('synthetic setup failure');
      expect(held).toHaveLength(3);
    } finally {
      spy.mockRestore();
      for (const item of held) logStore.delete(item.finish().handle);
    }
    const fullQuota: ReturnType<typeof logStore.create>[] = [];
    try {
      for (let i = 0; i < 8; i++) fullQuota.push(logStore.create());
      expect(() => logStore.create()).toThrow('Log quota unavailable');
    }
    finally { for (const item of fullQuota) logStore.delete(item.finish().handle); }
  });
  it('does not write through a deleted active descriptor or claim completeness', () => {
    const active = logStore.create(20);
    active.append('stdout', Buffer.from('a'));
    const meta = active.finish();
    const pending = logStore.create(20);
    pending.append('stdout', Buffer.from('x'));
    expect(logStore.delete(pending.finish().handle)).toBe(true);
    expect(logStore.delete(meta.handle)).toBe(true);
    active.append('stdout', Buffer.from('secret'));
    expect(active.finish().complete).toBe(false);
    expect(() => logStore.read(meta.handle, 'stdout', 0, 10)).toThrow();
  });
  it('expires an active log without closing its descriptor and preserves completeness', () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const active = logStore.create(20);
      active.append('stdout', Buffer.from('a'));
      spy.mockReturnValue(now + 60 * 60 * 1000 + 1);
      const other = logStore.create(20);
      active.append('stdout', Buffer.from('b'));
      const meta = active.finish();
      expect(meta.complete).toBe(true);
      expect(logStore.read(meta.handle, 'stdout', 0, 10).data).toBe('YWI=');
      logStore.delete(meta.handle);
      logStore.delete(other.finish().handle);
    } finally { spy.mockRestore(); }
  });
  it('does not create a handle by default', async () => {
    const r = await runProgram(process.execPath, ['-e', 'process.stdout.write("ok")']);
    expect(r.log).toBeUndefined();
  });
  it('persists more output than the display and reads bounded pages with opaque handles', async () => {
    const r = await runProgram(process.execPath, ['-e', 'process.stdout.write("abcdef");process.stderr.write("uvwxyz")'], { maxOutputBytes: 2, logOutput: true });
    expect(r.stdout).toBe('ab');
    expect(r.stderr).toBe('uv');
    expect(r.log?.complete).toBe(true);
    expect(logStore.read(r.log!.handle, 'stdout', 2, 3)).toMatchObject({ data: 'Y2Rl', nextOffset: 5, totalBytes: 6 });
    expect(logStore.read(r.log!.handle, 'stderr', 0, 6).data).toBe('dXZ3eHl6');
    expect(() => logStore.read('../bad', 'stdout', 0, 2)).toThrow();
    expect(() => logStore.read(r.log!.handle, 'stdout', 0, 65537)).toThrow();
    logStore.delete(r.log!.handle);
    expect(() => logStore.read(r.log!.handle, 'stdout', 0, 2)).toThrow();
  });
  it('reports incomplete logs at quota while continuing to drain', async () => {
    const r = await runProgram(process.execPath, ['-e', 'process.stdout.write("abcdef")'], { logOutput: true, logQuotaBytes: 3 });
    expect(r.log?.complete).toBe(false);
    expect(r.log?.stdoutBytes).toBe(3);
    expect(logStore.read(r.log!.handle, 'stdout', 0, 10).data).toBe('YWJj');
    logStore.delete(r.log!.handle);
  });
  it.skipIf(process.platform !== 'win32')('protects the fresh directory with a private Windows ACL', async () => {
    const r = await runProgram(process.execPath, ['-e', 'process.stdout.write("secret")'], { logOutput: true });
    const parent = logParent();
    const dirs = readdirSync(parent).filter(x => x.startsWith('powershell-mcp-log-'));
    const own = dirs.find(x => readdirSync(join(parent, x)).includes(`${r.log!.handle}.out`));
    expect(own).toBeTruthy();
    const acl = execFileSync(join(process.env.SystemRoot!, 'System32', 'icacls.exe'), [join(parent, own!)], { encoding: 'utf8' });
    expect(acl).not.toMatch(/Everyone|Authenticated Users|BUILTIN\\Users/);
    expect(lstatSync(join(parent, own!)).isSymbolicLink()).toBe(false);
    logStore.delete(r.log!.handle);
  });
});

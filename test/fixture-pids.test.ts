import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFixturePids, witnessFixturePid } from './fixture-pids.mjs';

describe('fixture PID readiness', () => {
  it.each([
    ['empty', ''], ['whitespace', ' \n'], ['partial digits', '123'],
    ['partial role', 'child:'], ['zero', '0\n'], ['negative', '-1\n'],
    ['fraction', '1.5\n'], ['exponent', '1e3\n'], ['hex', '0x10\n'],
    ['leading zero', '0123\n'], ['sign', '+123\n'], ['spaces', ' 123\n'],
    ['NaN', 'NaN\n'], ['infinity', 'Infinity\n'], ['unsafe integer', '9007199254740992\n'],
    ['extra record', '123\n456\n'], ['trailing bytes', '123\nx'],
  ])('rejects %s before liveness is consulted', (_name, raw) => {
    const probed: number[] = [];
    const pids = parseFixturePids(raw);
    // A deterministic liveness seam: never call process.kill(0), even in RED.
    const ready = pids?.every(pid => { probed.push(pid); return true; }) ?? false;
    expect({ ready, probed }).toEqual({ ready: false, probed: [] });
  });

  it.each([
    ['partial final PID', 'root:123\nchild:45'],
    ['empty final PID', 'root:123\nchild:\n'],
    ['wrong role', 'root:123\nother:456\n'],
    ['duplicate role', 'root:123\nroot:456\n'],
    ['duplicate PID', 'root:123\nchild:123\n'],
    ['invalid final PID', 'root:123\nchild:0\n'],
  ])('rejects %s in a tree marker', (_name, raw) => {
    expect(parseFixturePids(raw, ['root', 'child'])).toBeUndefined();
  });

  it('admits complete positive PID records in the expected role order', () => {
    expect(parseFixturePids('123\n')).toEqual([123]);
    expect(parseFixturePids('root:123\nchild:456\n', ['root', 'child'])).toEqual([123, 456]);
  });

  it('requires the live PID to identify this owned fixture before cancellation', async () => {
    const base = mkdtempSync(join(tmpdir(), 'pid-identity-'));
    const marker = join(base, 'owned-marker');
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', marker], { stdio: 'ignore', windowsHide: true });
    const closed = once(child, 'close');
    try {
      await once(child, 'spawn');
      expect(() => witnessFixturePid(child.pid!, marker)).not.toThrow();
      // Liveness alone also accepts this same Node process for another fixture.
      expect(() => witnessFixturePid(child.pid!, join(base, 'unrelated-marker'))).toThrow(/fixture identity/);
      expect(() => witnessFixturePid(0, marker)).toThrow(/positive PID/);
    } finally { child.kill(); await closed; rmSync(base, { recursive: true, force: true }); }
  });
});

import { describe, it, expect } from 'vitest';
import { runProgram } from '../src/program.js';

// Mandatory in the Ubuntu CI suite: 64 real native invocations, four concurrent
// lanes. Each invocation retains the normal command and cancellation deadlines.
describe.skipIf(process.platform !== 'linux')('Linux supervisor repeated native echo/EOF', () => {
  for (let lane = 0; lane < 4; lane++) it.concurrent(`lane ${lane} proves completion for both stdin forms`, async () => {
    for (let iteration = 0; iteration < 8; iteration++) {
      for (const stdin of ['', 'héllo " \\ 💫']) {
        const r = await runProgram(process.execPath, ['-e', "process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.stdout.write('|EOF'))"], { stdin });
        // Synthetic inputs only; never serialize command arguments, raw frames,
        // exception messages, or supervisor stderr into failure evidence.
        const evidence = JSON.stringify({ lane, iteration, input: stdin === '' ? 'empty' : 'utf8', exitCode: r.exitCode, treeTerminated: r.treeTerminated, supervisorReason: r.supervisorReason, timedOut: r.timedOut, cancelled: r.cancelled, durationMs: r.durationMs });
        expect(r.stdout, evidence).toBe(stdin + '|EOF');
        expect(r.stderr, evidence).toBe('');
        expect(r.exitCode, evidence).toBe(0);
        expect(r.treeTerminated, evidence).toBe(true);
        expect(r.timedOut, evidence).toBe(false);
        expect(r.cancelled, evidence).toBe(false);
        expect(r.supervisorReason, evidence).toBeUndefined();
      }
    }
  }, 180_000);
});

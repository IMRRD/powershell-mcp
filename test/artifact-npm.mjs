import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCommand } from '../collector/fixtures/packaged-process.mjs';

const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')].find(p => p && existsSync(p));
export async function npm(args, cwd, signal, evidence) {
  const aborted = () => evidence?.start('commandAbort')();
  signal?.addEventListener('abort', aborted, { once: true });
  if (signal?.aborted) aborted();
  try {
    // Cancellation belongs to the waiter, never spawn: stopProcess must terminate
    // the still-owned tree before npm close or directory removal can win the race.
    // The caller's original shared 150s pack/install signal remains authoritative.
    return await runCommand(process.execPath, [npmCli, ...args], {
      cwd, signal, timeout: 150000, label: 'artifact npm', reportOutput: false, measure: evidence?.measure,
    });
  } finally { signal?.removeEventListener('abort', aborted); }
}

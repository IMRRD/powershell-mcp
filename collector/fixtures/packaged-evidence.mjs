// Fixture-only public diagnostics. Never serialize npm metadata, arbitrary timer
// names, raw output, errors, environment, argv, URLs or filesystem paths.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const phases = new Set(['acceptance', 'pack', 'install', 'proof', 'proxyClose', 'proxyConnectionsClose', 'proxyWaitClose', 'collectorClose', 'directoryRemove']);
const timers = new Set(['npm', 'command:install', 'idealTree', 'idealTree:init', 'idealTree:buildDeps', 'idealTree:fixDepFlags', 'reify', 'reify:loadTrees', 'reify:diffTrees', 'reify:retireShallow', 'reify:createSparse', 'reify:unpack', 'reify:unretire', 'reify:build', 'reify:trash', 'reify:save', 'build', 'build:deps', 'build:run:install', 'build:run:postinstall']);
const duration = value => Number.isSafeInteger(value) && value >= 0 && value <= 86400000;

export function installEvidence(file) {
  const data = { schemaVersion: 1, phases: {}, npm: { timing: {}, debugTiming: {} } };
  // Best effort only: diagnostics must never replace a proof/cancellation error
  // or prevent any cleanup. Snapshots survive incomplete finalization too.
  const save = () => {
    try {
      const text = JSON.stringify(data) + '\n';
      if (Buffer.byteLength(text) <= 8192) writeFileSync(file, text, { mode: 0o600 });
    } catch {}
  };
  function start(phase) {
    if (!phases.has(phase)) return () => {};
    const began = performance.now();
    data.phases[phase] = { status: 'started' }; save();
    return (failed = false) => {
      data.phases[phase] = { status: failed ? 'failed' : 'completed', durationMs: Math.min(86400000, Math.max(0, Math.round(performance.now() - began))) }; save();
    };
  }
  return {
    start,
    async measure(phase, task) {
      const finish = start(phase); let failed = false;
      try { return await task(); } catch (e) { failed = true; throw e; } finally { finish(failed); }
    },
    npm(directory) {
      try {
        for (const name of readdirSync(directory).filter(n => /-(?:timing\.json|debug-\d+\.log)$/.test(n)).slice(0, 4)) {
          try {
            const path = join(directory, name);
            if (!statSync(path).isFile() || statSync(path).size > 256 * 1024) continue;
            const text = readFileSync(path, 'utf8');
            if (name.endsWith('-timing.json')) {
              const values = JSON.parse(text).timers;
              for (const key of timers) if (duration(values?.[key])) data.npm.timing[key] = values[key];
            } else {
              for (const line of text.split(/\r?\n/)) {
                const timing = /^\d+ timing ([A-Za-z:]+) Completed in (\d+)ms$/.exec(line);
                if (timing && timers.has(timing[1]) && duration(Number(timing[2]))) data.npm.debugTiming[timing[1]] = Number(timing[2]);
                const exit = /^\d+ verbose exit (-?\d{1,3})$/.exec(line);
                if (exit) data.npm.exitCode = Number(exit[1]);
              }
            }
          } catch {} // Missing, incomplete, malformed or oversized: no raw fallback.
        }
      } catch {}
      save();
    },
  };
}

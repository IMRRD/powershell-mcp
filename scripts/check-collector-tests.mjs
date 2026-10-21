import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const files = ['collector/report.node-test.mjs', 'collector/optout.node-test.mjs', 'collector/snapshot.node-test.mjs', 'scripts/check-collector-tests.node-test.mjs'];
export const expectedTests = 12;
export function validTap(result) {
  if (result.error || result.status !== 0) return false;
  const text = result.stdout ?? '';
  const values = {};
  for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled']) {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (matches.length !== 1) return false;
    values[key] = Number(matches[0][1]);
  }
  return values.tests === expectedTests && values.pass === expectedTests && values.fail === 0 && values.skipped === 0 && values.cancelled === 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    encoding: 'utf8', env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1' }, maxBuffer: 4 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (!validTap(result)) {
    console.error('Collector test gate failed: incomplete, skipped or failing tests.');
    process.exitCode = 1;
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validTap, expectedTests, files } from './check-collector-tests.mjs';
test('mandatory collector gate includes installed packaged client and graceful exit', () => {
  assert.ok(files.includes('collector/packaged-client.node-test.mjs'));
  assert.ok(files.includes('collector/packaged-evidence.node-test.mjs'));
  assert.ok(files.includes('collector/packaged-process.node-test.mjs'));
  assert.ok(files.includes('collector/graceful-exit.node-test.mjs'));
  assert.ok(expectedTests > 21);
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /name: Retain failing test evidence\s+if: failure\(\)/);
  assert.match(ci, /path: \|\s+vitest-report\.json\s+test-evidence\/packaged-client\.json\s+if-no-files-found: warn/);
  assert.equal(ci.includes('test-evidence/**'), false);
});
const summary = (n = expectedTests) => `# tests ${n}\n# pass ${n}\n# fail 0\n# skipped 0\n# cancelled 0\n`;
test('gate requires exact count and single occurrence of every TAP summary field on Windows and POSIX', async () => {
  assert.equal(validTap({ status: 0, stdout: summary() }), true);
  for (const stdout of [summary(1), summary() + '# tests 1\n', summary().replace('# fail 0\n', ''), summary().replace('# skipped 0', '# skipped 1'), summary().replace('# pass ' + expectedTests, '# pass 0')]) assert.equal(validTap({ status: 0, stdout }), false);
  assert.equal(validTap({ status: 1, stdout: summary() }), false);
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    for (const [platform, count] of [['win32', 56], ['linux', 57]]) {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      const gate = await import(`./check-collector-tests.mjs?admission=${platform}`);
      assert.equal(gate.expectedTests, count);
      assert.equal(gate.validTap({ status: 0, stdout: summary(count) }), true);
      for (const wrong of [count - 1, count + 1, platform === 'win32' ? 38 : 39]) {
        assert.equal(gate.validTap({ status: 0, stdout: summary(wrong) }), false);
      }
    }
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});

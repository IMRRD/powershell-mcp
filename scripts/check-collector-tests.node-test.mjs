import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validTap, expectedTests, files } from './check-collector-tests.mjs';
test('mandatory collector gate includes installed packaged client and graceful exit', () => {
  assert.ok(files.includes('collector/packaged-client.node-test.mjs'));
  assert.ok(files.includes('collector/graceful-exit.node-test.mjs'));
  assert.ok(expectedTests > 21);
});
const summary = (n = expectedTests) => `# tests ${n}\n# pass ${n}\n# fail 0\n# skipped 0\n# cancelled 0\n`;
test('gate requires exact count and single occurrence of every TAP summary field', () => {
  assert.equal(validTap({ status: 0, stdout: summary() }), true);
  for (const stdout of [summary(1), summary() + '# tests 1\n', summary().replace('# fail 0\n', ''), summary().replace('# skipped 0', '# skipped 1'), summary().replace('# pass ' + expectedTests, '# pass 0')]) assert.equal(validTap({ status: 0, stdout }), false);
  assert.equal(validTap({ status: 1, stdout: summary() }), false);
});

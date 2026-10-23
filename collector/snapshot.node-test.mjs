import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNpm, validateTraffic } from './snapshot.mjs';
const from = '2026-10-06', to = '2026-10-19';
const days = Array.from({ length: 14 }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
test('snapshot sums complete labelled npm and GitHub event windows', () => {
  assert.equal(validateNpm({ package: 'powershell-mcp', start: from, end: to, downloads: days.map(day => ({ day, downloads: 2 })) }, 'powershell-mcp', from, to), 28);
  assert.deepEqual(validateTraffic({ count: 14, uniques: 3, clones: days.map(day => ({ timestamp: `${day}T00:00:00Z`, count: 1, uniques: 1 })) }, 'clones', from, to), { events: 14, uniqueGitHubEstimate: 3 });
});
test('snapshot refuses partial windows, duplicate days and mismatched totals', () => {
  const rows = days.map(day => ({ day, downloads: 1 }));
  for (const bad of [rows.slice(1), [...rows, rows[0]]]) assert.throws(() => validateNpm({ package: 'powershell-mcp', start: from, end: to, downloads: bad }, 'powershell-mcp', from, to));
  assert.throws(() => validateTraffic({ count: 99, uniques: 3, clones: days.map(day => ({ timestamp: `${day}T00:00:00Z`, count: 1, uniques: 1 })) }, 'clones', from, to));
});
test('snapshot bounds interval and daily uniques against corresponding events', () => {
  const rows = days.map(day => ({ timestamp: `${day}T00:00:00Z`, count: 1, uniques: 1 }));
  for (const bad of [
    { count: 14, uniques: 15, clones: rows },
    { count: 14, uniques: 2, clones: [{ ...rows[0], uniques: 2 }, ...rows.slice(1)] },
  ]) assert.throws(() => validateTraffic(bad, 'clones', from, to));
  assert.deepEqual(validateTraffic({ count: 14, uniques: 2, clones: rows }, 'clones', from, to), { events: 14, uniqueGitHubEstimate: 2 });
});

#!/usr/bin/env node
// Read-only aggregate download/traffic snapshot. No collector connection.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function validateNpm(data, name, from, to) {
  if (data.package !== name || data.start !== from || data.end !== to || !Array.isArray(data.downloads)) throw Error('npm window mismatch');
  const dates = new Set(); let total = 0;
  for (const row of data.downloads) {
    if (!/^\d{4}-\d\d-\d\d$/.test(row.day) || row.day < from || row.day > to || dates.has(row.day) || !Number.isSafeInteger(row.downloads) || row.downloads < 0) throw Error('invalid npm daily aggregate');
    dates.add(row.day); total += row.downloads;
  }
  if (!Number.isSafeInteger(total) || dates.size !== (Date.parse(to) - Date.parse(from)) / 86400000 + 1) throw Error('incomplete npm window');
  return total;
}
export function validateTraffic(data, kind, from, to) {
  const rows = data[kind];
  if (!Array.isArray(rows) || !Number.isSafeInteger(data.count) || data.count < 0 || !Number.isSafeInteger(data.uniques) || data.uniques < 0 || data.uniques > data.count) throw Error('invalid GitHub traffic');
  const dates = new Set(); let total = 0;
  for (const row of rows) {
    const day = row.timestamp?.slice(0, 10);
    if (row.timestamp !== `${day}T00:00:00Z` || day < from || day > to || dates.has(day) || !Number.isSafeInteger(row.count) || row.count < 0 || !Number.isSafeInteger(row.uniques) || row.uniques < 0 || row.uniques > row.count) throw Error('invalid GitHub daily aggregate');
    dates.add(day); total += row.count;
  }
  if (total !== data.count || dates.size !== (Date.parse(to) - Date.parse(from)) / 86400000 + 1) throw Error('incomplete GitHub window');
  return { events: total, uniqueGitHubEstimate: data.uniques };
}
async function main() {
  const [from, to, output] = process.argv.slice(2);
  if (process.argv.length !== 5 || !/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to) || from > to || !Number.isInteger((Date.parse(to) - Date.parse(from)) / 86400000) || (Date.parse(to) - Date.parse(from)) / 86400000 !== 13) throw Error('provide exact 14-day UTC window and output file');
  const npm = {};
  for (const name of ['@imrrd/powershell-mcp', 'powershell-mcp']) {
    const response = await fetch(`https://api.npmjs.org/downloads/range/${from}:${to}/${name}`);
    if (!response.ok) throw Error(`npm ${name} unavailable: HTTP ${response.status}`);
    npm[name] = validateNpm(await response.json(), name, from, to);
  }
  const github = {};
  for (const kind of ['clones', 'views']) {
    const r = spawnSync('gh', ['api', `repos/IMRRD/powershell-mcp/traffic/${kind}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (r.status !== 0 || r.error) throw Error(`GitHub ${kind} unavailable (requires authorized traffic access)`);
    github[kind] = validateTraffic(JSON.parse(r.stdout), kind, from, to);
  }
  writeFileSync(output, JSON.stringify({ windowUtc: { fromInclusive: from, toInclusive: to }, npmDownloadEvents: npm, githubTraffic: github, interpretation: 'Download and clone events are not installations or people; GitHub unique estimates are not user counts. Internal/test traffic may be present.' }, null, 2) + '\n', { flag: 'wx' });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });

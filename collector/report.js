#!/usr/bin/env node
// Maintainer-only, offline aggregate of a local collector JSONL export.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const tools = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const validDate = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
// Only bounded numeric release triples are output; all other source labels collapse.
const versionBucket = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})$/.test(value) ? value : 'other';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!['--file', '--classification', '--from', '--to'].includes(key) || own(options, key) || !argv[i + 1]) throw Error('invalid arguments');
    options[key] = argv[i + 1];
  }
  if (Object.keys(options).length !== 4 || !validDate(options['--from']) || !validDate(options['--to']) || options['--from'] >= options['--to']) throw Error('invalid UTC window');
  return options;
}
function boundedRead(path) {
  if (statSync(path).size > 16 * 1024 * 1024) throw Error('input too large');
  return readFileSync(path, 'utf8');
}
function classify(text) {
  const c = JSON.parse(text);
  if (!object(c) || Object.keys(c).sort().join(',') !== 'internalHostIds,testHostIds' || !Array.isArray(c.internalHostIds) || !Array.isArray(c.testHostIds)) throw Error('invalid classification');
  const internal = new Set(c.internalHostIds), test = new Set(c.testHostIds);
  if (internal.size !== c.internalHostIds.length || test.size !== c.testHostIds.length || [...internal, ...test].some(x => typeof x !== 'string' || !x || x.length > 256) || [...internal].some(x => test.has(x))) throw Error('invalid classification');
  return { internal, test };
}
function group() { return { observedInstallations: 0, activeInstallations: 0, startupOnlyInstallations: 0, versions: Object.create(null), os: Object.create(null), toolCounts: Object.create(null) }; }
function aggregate(text, classification, from, to) {
  const groups = { internal: group(), test: group(), unknownOrigin: group() };
  const hosts = new Map();
  const rows = text.split('\n');
  if (rows.length > 100001) throw Error('too many rows');
  for (let i = 0; i < rows.length; i++) {
    if (i === rows.length - 1 && rows[i] === '') break;
    let r;
    try { r = JSON.parse(rows[i]); } catch { throw Error('invalid row'); }
    if (!object(r) || typeof r.hostId !== 'string' || !r.hostId || r.hostId.length > 256 || !['startup', 'tool_counts'].includes(r.event) || !validDate(r.ts) || typeof r.version !== 'string' || r.version.length > 256 || !['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'].includes(r.os) || (own(r, '_receivedAt') && !validDate(r._receivedAt))) throw Error('invalid row');
    if (r.event === 'tool_counts' && (!object(r.counts) || !Object.keys(r.counts).length || Object.entries(r.counts).some(([name, count]) => !tools.has(name) || !Number.isSafeInteger(count) || count <= 0))) throw Error('invalid counts');
    if (r.ts < from || r.ts >= to) continue;
    const bucket = classification.internal.has(r.hostId) ? 'internal' : classification.test.has(r.hostId) ? 'test' : 'unknownOrigin';
    const key = bucket + ':' + r.hostId;
    if (!hosts.has(key)) hosts.set(key, { bucket, startup: false, active: false, version: versionBucket(r.version), os: r.os, first: r.ts });
    const h = hosts.get(key);
    if (r.ts < h.first) { h.first = r.ts; h.version = versionBucket(r.version); h.os = r.os; }
    if (r.event === 'startup') h.startup = true;
    else {
      h.active = true;
      for (const [name, count] of Object.entries(r.counts)) {
        const previous = groups[bucket].toolCounts[name] ?? 0;
        if (!Number.isSafeInteger(previous + count)) throw Error('count overflow');
        groups[bucket].toolCounts[name] = previous + count;
      }
    }
  }
  for (const h of hosts.values()) {
    const g = groups[h.bucket];
    g.observedInstallations++;
    if (h.active) g.activeInstallations++;
    else if (h.startup) g.startupOnlyInstallations++;
    g.versions[h.version] = (g.versions[h.version] ?? 0) + 1;
    g.os[h.os] = (g.os[h.os] ?? 0) + 1;
  }
  return { windowUtc: { from, toExclusive: to }, groups };
}
try {
  const o = parseArgs(process.argv.slice(2));
  const c = classify(boundedRead(resolve(o['--classification'])));
  const report = aggregate(boundedRead(resolve(o['--file'])), c, o['--from'], o['--to']);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} catch {
  process.stderr.write('Report failed: invalid, unavailable, or oversized local input. No partial report emitted.\n');
  process.exitCode = 1;
}

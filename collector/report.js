#!/usr/bin/env node
// Maintainer-only, offline aggregate of a local collector JSONL export.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tools = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program', 'runtime_capabilities', 'start_execution', 'execution_status', 'read_execution_output', 'cancel_execution', 'read_output_log', 'delete_output_log', 'start_remote_batch', 'remote_batch_status', 'cancel_remote_batch']);
const outcomes = new Set(['success','nonzero','error','timeout','cancelled','unknown']);
const durations = new Set(['lt100','lt1000','lt10000','gte10000']);
const features = new Set(['execution','inspection','remote','transfer','lifecycle','logs']);
const validAxis = (axis, keys) => object(axis) && Object.keys(axis).length > 0 && Object.entries(axis).every(([key,n]) => keys.has(key) && Number.isSafeInteger(n) && n > 0);
const validMetrics = metrics => object(metrics) && Object.keys(metrics).length > 0 && Object.keys(metrics).length <= tools.size && Object.entries(metrics).every(([name,row]) => {
  if (!tools.has(name) || !object(row) || Object.keys(row).sort().join(',') !== 'durations,features,outcomes' || !validAxis(row.outcomes,outcomes) || !validAxis(row.durations,durations) || !validAxis(row.features,features)) return false;
  const sum = axis => Object.values(axis).reduce((a,b) => a+b, 0);
  return Number.isSafeInteger(sum(row.outcomes)) && sum(row.outcomes) === sum(row.durations) && sum(row.outcomes) === sum(row.features);
});
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
export function classify(text) {
  const c = JSON.parse(text);
  if (!object(c) || !['internalHostIds,testHostIds','enrollments,internalHostIds,testHostIds'].includes(Object.keys(c).sort().join(',')) || !Array.isArray(c.internalHostIds) || !Array.isArray(c.testHostIds)) throw Error('invalid classification');
  const internal = new Set(c.internalHostIds), test = new Set(c.testHostIds);
  if (internal.size !== c.internalHostIds.length || test.size !== c.testHostIds.length || [...internal, ...test].some(x => typeof x !== 'string' || !x || x.length > 256) || [...internal].some(x => test.has(x))) throw Error('invalid classification');
  const enrollments = new Map();
  if (c.enrollments !== undefined && !Array.isArray(c.enrollments)) throw Error('invalid enrollment');
  for (const e of c.enrollments ?? []) {
    if (!object(e) || Object.keys(e).sort().join(',') !== 'cohort,fromReceiptUtc,hostId' || typeof e.hostId !== 'string' || !userToken.test(e.hostId) || !['internal','test'].includes(e.cohort) || !validDate(e.fromReceiptUtc) || internal.has(e.hostId) || test.has(e.hostId) || enrollments.has(e.hostId)) throw Error('invalid enrollment');
    enrollments.set(e.hostId, e);
  }
  if (internal.size + test.size + enrollments.size > 10000) throw Error('classification too large');
  return { internal, test, enrollments };
}
const userToken = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function group() { return { observedInstallations: 0, activeInstallations: 0, startupOnlyInstallations: 0, coveredInstallations: 0, unknownUserInstallations: 0, userProxies: 0, versions: Object.create(null), os: Object.create(null), toolCounts: Object.create(null), toolMetrics: Object.create(null) }; }
export function aggregate(text, classification, from, to) {
  const groups = { internal: group(), test: group(), unknownOrigin: group(), externalSelfDeclared: group(), cohortConflict: group() };
  const users = new Map(Object.keys(groups).map(k => [k, new Set()]));
  const hosts = new Map();
  const rows = text.split('\n');
  if (rows.length > 100001) throw Error('too many rows');
  for (let i = 0; i < rows.length; i++) {
    if (i === rows.length - 1 && rows[i] === '') break;
    let r;
    try { r = JSON.parse(rows[i]); } catch { throw Error('invalid row'); }
    if (!object(r) || typeof r.hostId !== 'string' || !r.hostId || r.hostId.length > 256 || !['startup', 'tool_counts', 'tool_metrics'].includes(r.event) || !validDate(r.ts) || typeof r.version !== 'string' || r.version.length > 256 || !['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'].includes(r.os) || (own(r, '_receivedAt') && !validDate(r._receivedAt))) throw Error('invalid row');
    if (r.event === 'tool_metrics' && (r.schemaVersion !== 2 || !validMetrics(r.metrics))) throw Error('invalid metrics');
    if (r.event === 'tool_counts' && (!object(r.counts) || !Object.keys(r.counts).length || Object.entries(r.counts).some(([name, count]) => !tools.has(name) || !Number.isSafeInteger(count) || count <= 0))) throw Error('invalid counts');
    if (r.ts < from || r.ts >= to) continue;
    if (own(r, 'userId') && (typeof r.userId !== 'string' || !userToken.test(r.userId)) || own(r, 'cohort') && r.cohort !== 'external_self_declared') throw Error('invalid privacy fields');
    let bucket = classification.internal.has(r.hostId) ? 'internal' : classification.test.has(r.hostId) ? 'test' : 'unknownOrigin';
    const entry = classification.enrollments.get(r.hostId);
    if (entry && validDate(r._receivedAt) && r._receivedAt >= entry.fromReceiptUtc) bucket = entry.cohort;
    if (r.cohort === 'external_self_declared') bucket = bucket === 'unknownOrigin' ? 'externalSelfDeclared' : 'cohortConflict';
    const key = bucket + ':' + r.hostId;
    if (!hosts.has(key)) hosts.set(key, { bucket, startup: false, active: false, version: versionBucket(r.version), os: r.os, first: r.ts, users: new Set(), missingUser: false });
    const h = hosts.get(key);
    if (r.userId) h.users.add(r.userId); else h.missingUser = true;
    if (r.ts < h.first) { h.first = r.ts; h.version = versionBucket(r.version); h.os = r.os; }
    if (r.event === 'startup') h.startup = true;
    else if (r.event === 'tool_metrics') {
      h.active = true;
      // Independent aggregate; do not double count versioned metrics as legacy calls.
      for (const [name, row] of Object.entries(r.metrics)) {
        const target = groups[bucket].toolMetrics[name] ??= { outcomes: Object.create(null), durations: Object.create(null), features: Object.create(null) };
        for (const axis of ['outcomes','durations','features']) for (const [label, count] of Object.entries(row[axis])) {
          const next = (target[axis][label] ?? 0) + count;
          if (!Number.isSafeInteger(next)) throw Error('metric overflow');
          target[axis][label] = next;
        }
      }
    } else {
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
    if (!h.missingUser && h.users.size === 1) { g.coveredInstallations++; users.get(h.bucket).add([...h.users][0]); }
    else g.unknownUserInstallations++;
    if (h.active) g.activeInstallations++;
    else if (h.startup) g.startupOnlyInstallations++;
    g.versions[h.version] = (g.versions[h.version] ?? 0) + 1;
    g.os[h.os] = (g.os[h.os] ?? 0) + 1;
  }
  for (const [key, set] of users) groups[key].userProxies = set.size;
  return { windowUtc: { from, toExclusive: to }, groups };
}
export function suppress(report) {
  const small = n => n > 0 && n < 10;
  const partition = values => values.some(small) || values.some(n => small(values.reduce((a,b) => a+b,0)-n));
  for (const g of Object.values(report.groups)) {
    if ([g.observedInstallations,g.activeInstallations,g.startupOnlyInstallations,g.observedInstallations-g.activeInstallations,g.observedInstallations-g.startupOnlyInstallations,g.observedInstallations-g.activeInstallations-g.startupOnlyInstallations,g.coveredInstallations,g.unknownUserInstallations,g.userProxies,g.coveredInstallations-g.userProxies].some(small) || [g.versions,g.os,g.toolCounts].some(p => partition(Object.values(p))) || Object.values(g.toolMetrics).some(m => Object.values(m).some(p => partition(Object.values(p))))) {
      return { windowUtc: report.windowUtc, withheld: true, note: 'Counts withheld: small cells or derivable complements; no zero implied. External is self-declared. User proxies are optional pseudonyms, not verified humans.' };
    }
  }
  return { ...report, withheld: false, note: 'Installation and optional user pseudonym proxies, not verified humans. External is self-declared; unknown is not external. Cohorts can overlap across events; do not add distinct counts.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) try {
  const o = parseArgs(process.argv.slice(2));
  const c = classify(boundedRead(resolve(o['--classification'])));
  const report = aggregate(boundedRead(resolve(o['--file'])), c, o['--from'], o['--to']);
  process.stdout.write(JSON.stringify(suppress(report), null, 2) + '\n');
} catch {
  process.stderr.write('Report failed: invalid, unavailable, or oversized local input. No partial report emitted.\n');
  process.exitCode = 1;
}

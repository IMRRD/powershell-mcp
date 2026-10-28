#!/usr/bin/env node
/**
 * Telemetry collector for @imrrd/powershell-mcp
 *
 * Accepts POST /api/telemetry  { event, version, hostId, os, ts, counts? }
 * Appends each record as a JSON line to ./telemetry.jsonl
 *
 * Usage:
 *   node server.js
 *
 * Env:
 *   PORT                        (default 4242)
 *   TELEMETRY_TOKEN             optional shared secret (X-Telemetry-Token header)
 *   TELEMETRY_FILE              path to JSONL file (default ./telemetry.jsonl)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from 'node:crypto';

const PORT = parseInt(process.env.PORT ?? "4242", 10);
const TOKEN = process.env.TELEMETRY_TOKEN ?? "";
const DATA_FILE = process.env.TELEMETRY_FILE ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "telemetry.jsonl",
);

const MAX_BODY_BYTES = 16 * 1024;
const TOOLS = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program', 'runtime_capabilities', 'start_execution', 'execution_status', 'read_execution_output', 'cancel_execution', 'read_output_log', 'delete_output_log', 'start_remote_batch', 'remote_batch_status', 'cancel_remote_batch']);
const OUTCOMES = new Set(['success','nonzero','error','timeout','cancelled','unknown']);
const DURATIONS = new Set(['lt100','lt1000','lt10000','gte10000']);
const FEATURES = new Set(['execution','inspection','remote','transfer','lifecycle','logs']);
const WINRM_REASONS = new Set(['completed','remote_script_error','authentication_exception','access_exception','remoting_transport_exception','invoke_exception','wrapper_result_invalid','frame_invalid','frame_body_invalid','local_host_error','local_launch_error','timeout','cancelled','unknown']);
function validAxis(axis, allowed) { return object(axis) && Object.keys(axis).length > 0 && Object.entries(axis).every(([key, count]) => allowed.has(key) && Number.isSafeInteger(count) && count > 0); }
function validMetrics(metrics) {
  return object(metrics) && Object.keys(metrics).length > 0 && Object.keys(metrics).length <= TOOLS.size && Object.entries(metrics).every(([name,row]) => {
    if (!TOOLS.has(name) || !object(row) || Object.keys(row).sort().join(',') !== ('winrmReasons' in row ? 'durations,features,outcomes,winrmReasons' : 'durations,features,outcomes') || !validAxis(row.outcomes, OUTCOMES) || !validAxis(row.durations, DURATIONS) || !validAxis(row.features, FEATURES)) return false;
    const total = axis => Object.values(axis).reduce((n,v) => n + v, 0);
    if ('winrmReasons' in row && (name !== 'winrm_exec' || !validAxis(row.winrmReasons, WINRM_REASONS) || total(row.winrmReasons) !== total(row.outcomes))) return false;
    return Number.isSafeInteger(total(row.outcomes)) && total(row.outcomes) === total(row.durations) && total(row.outcomes) === total(row.features);
  });
}
const OS = new Set(['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android']);
const date = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function writeAll(fd, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw Error('incomplete storage write');
    offset += written;
  }
}
let storageReady = true;
const INDEX = `${DATA_FILE}.receipts`;
function syncDirectory(dir) {
  // Windows cannot open directories with node:fs; collector production is Linux.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function receiptPath(id) { return path.join(INDEX, crypto.createHash('sha256').update(id).digest('hex')); }
function receipt(id, hash) {
  const target = receiptPath(id);
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') !== `${id} ${hash}\n`) throw Error('event collision');
    return;
  }
  const fd = fs.openSync(target, 'wx', 0o600);
  try { writeAll(fd, `${id} ${hash}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  syncDirectory(INDEX);
}
// A startup-only bounded-memory rebuild makes the JSONL the authority even if
// a crash occurred between its fsync and indexing. No request scans history.
function rebuildReceipts() {
  // Sidecar is disposable: recreate it from authoritative JSONL on every restart.
  // An interrupted prior index write cannot poison future admissions.
  if (fs.existsSync(INDEX)) fs.rmSync(INDEX, { recursive: true, force: true });
  fs.mkdirSync(INDEX, { mode: 0o700 });
  syncDirectory(path.dirname(INDEX));
  if (!fs.existsSync(DATA_FILE)) return;
  const fd = fs.openSync(DATA_FILE, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0), position = 0, n;
    const ingest = line => {
      if (!line.length) return;
      const row = JSON.parse(line.toString('utf8'));
      if (![1, 2].includes(row.schemaVersion) || typeof row.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.eventId)) return; // legacy rows preserved
      const { _receivedAt, ...payload } = row;
      receipt(row.eventId, digest(payload));
    };
    while ((n = fs.readSync(fd, chunk, 0, chunk.length, position)) > 0) {
      position += n;
      let start = 0;
      for (let i = 0; i < n; i++) if (chunk[i] === 10) {
        const line = Buffer.concat([pending, chunk.subarray(start, i)]);
        ingest(line); pending = Buffer.alloc(0); start = i + 1;
      }
      pending = Buffer.concat([pending, chunk.subarray(start, n)]);
      if (pending.length > MAX_BODY_BYTES + 1024) throw Error('oversized historical line');
    }
    if (pending.length) throw Error('incomplete historical line');
  } finally { fs.closeSync(fd); }
}

// A torn final line cannot be followed by a new append: it would make both
// records unreadable. Preserve its bytes separately before truncation.
try {
  if (fs.existsSync(DATA_FILE)) {
    const fd = fs.openSync(DATA_FILE, 'r+');
    try {
      const size = fs.fstatSync(fd).size;
      if (size) {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 10) {
          const start = Math.max(0, size - MAX_BODY_BYTES - 1);
          const tail = Buffer.alloc(size - start);
          fs.readSync(fd, tail, 0, tail.length, start);
          const boundary = tail.lastIndexOf(10);
          if (boundary < 0 && start > 0) throw Error('oversized incomplete tail');
          const offset = start + boundary + 1;
          const fragment = tail.subarray(boundary + 1);
          if (fragment.length > MAX_BODY_BYTES) throw Error('oversized incomplete tail');
          let complete = false;
          try { complete = object(JSON.parse(fragment.toString('utf8'))); } catch { /* torn tail */ }
          if (complete) {
            fs.writeSync(fd, Buffer.from('\n'), 0, 1, size);
            fs.fsyncSync(fd);
          } else {
            const quarantine = fs.openSync(`${DATA_FILE}.corrupt-${Date.now()}-${process.pid}`, 'wx', 0o600);
            try { writeAll(quarantine, fragment); fs.fsyncSync(quarantine); }
            finally { fs.closeSync(quarantine); }
            syncDirectory(path.dirname(DATA_FILE));
            fs.ftruncateSync(fd, offset);
            fs.fsyncSync(fd);
            process.stderr.write('[telemetry] incomplete tail quarantined\n');
          }
        }
      }
    } finally { fs.closeSync(fd); }
  }
  if (storageReady) rebuildReceipts();
} catch { storageReady = false; process.stderr.write('[telemetry] storage recovery failed\n'); }
let pending = Promise.resolve();
let waiting = 0;
function serialized(task) {
  if (++waiting > 32) { waiting--; return Promise.reject(Error('busy')); }
  const next = pending.then(task);
  pending = next.catch(() => {}).finally(() => { waiting--; });
  return next;
}
function validPayload(p) {
  if (!object(p) || !['startup', 'tool_counts', 'tool_metrics'].includes(p.event)) return false;
  const versioned = ((p.schemaVersion === 1 && p.event !== 'tool_metrics') || (p.schemaVersion === 2 && p.event === 'tool_metrics')) && typeof p.eventId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.eventId);
  if (p.event === 'tool_metrics' && !versioned) return false;
  if (('eventId' in p || 'schemaVersion' in p) && !versioned) return false;
  const expected = p.event === 'startup' ? ['event', 'hostId', 'os', 'ts', 'version'] : p.event === 'tool_counts' ? ['counts', 'event', 'hostId', 'os', 'ts', 'version'] : ['metrics','event','hostId','os','ts','version'];
  if (versioned) expected.push('eventId', 'schemaVersion');
  if ('userId' in p) { if (!versioned || typeof p.userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(p.userId)) return false; expected.push('userId'); }
  if ('cohort' in p) { if (!versioned || p.cohort !== 'external_self_declared') return false; expected.push('cohort'); }
  expected.sort();
  if (Object.keys(p).sort().join(',') !== expected.join(',')) return false;
  if (typeof p.hostId !== 'string' || !p.hostId || p.hostId.length > 256 || typeof p.version !== 'string' || !p.version || p.version.length > 256 || !OS.has(p.os) || !date(p.ts)) return false;
  if (p.event === 'startup') return true;
  if (p.event === 'tool_metrics') return validMetrics(p.metrics);
  return object(p.counts) && Object.keys(p.counts).length > 0 && Object.entries(p.counts).every(([name, count]) => TOOLS.has(name) && Number.isSafeInteger(count) && count > 0);
}
let activeBodies = 0;
function readBody(req) {
  if (activeBodies >= 32) { req.resume(); return Promise.reject(Error('busy')); }
  activeBodies++;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const done = (error, body) => {
      if (finished) return;
      finished = true; activeBodies--;
      if (error) reject(error); else resolve(body);
    };
    req.on('aborted', () => done(Error('aborted')));
    req.on('close', () => { if (!req.complete) done(Error('closed')); });
    req.on("data", c => {
      if (finished) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) { chunks.length = 0; done(Error('too large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (bytes <= MAX_BODY_BYTES) done(null, Buffer.concat(chunks).toString('utf8')); });
    req.on("error", done);
  });
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(storageReady ? 200 : 503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: storageReady }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/api/telemetry") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Optional token check
  if (TOKEN && req.headers["x-telemetry-token"] !== TOKEN) {
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(err.message === 'too large' ? 413 : err.message === 'busy' ? 503 : 400);
    res.end("Bad request");
    return;
  }

  // Validate JSON
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end("Invalid JSON");
    return;
  }

  // Accept only the legacy allowlisted envelope; never persist arbitrary submitted fields.
  if (!validPayload(payload)) {
    res.writeHead(422);
    res.end("Invalid telemetry payload");
    return;
  }

  // The lookup and append share one serialized critical section. JSONL is
  // authoritative across restarts; a lost ACK is safely replayable.
  if (!storageReady) { res.writeHead(503); res.end('Storage unavailable'); return; }
  try {
    await serialized(async () => {
      if (!storageReady) throw Error('storage unavailable');
      const hash = payload.eventId ? digest(payload) : null;
      if (payload.eventId && fs.existsSync(receiptPath(payload.eventId))) {
        if (fs.readFileSync(receiptPath(payload.eventId), 'utf8') !== `${payload.eventId} ${hash}\n`) throw Error('event collision');
        return;
      }
      const line = JSON.stringify({ ...payload, _receivedAt: new Date().toISOString() }) + '\n';
      let fd;
      try {
        fd = fs.openSync(DATA_FILE, 'a', 0o600);
        writeAll(fd, line); fs.fsyncSync(fd); syncDirectory(path.dirname(DATA_FILE));
        if (payload.eventId) receipt(payload.eventId, hash);
      }
      catch (err) { storageReady = false; throw err; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    });
  } catch (err) {
    process.stderr.write('[telemetry] storage error\n');
    res.writeHead(err.message === 'event collision' ? 409 : 503);
    res.end("Storage error");
    return;
  }

  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload.eventId ? { ok: true, eventId: payload.eventId } : { ok: true }));
});

server.listen(PORT, () => {
  process.stderr.write(`[telemetry] collector listening on :${PORT}\n`);
  process.stderr.write(`[telemetry] writing to ${DATA_FILE}\n`);
  if (TOKEN) process.stderr.write(`[telemetry] token auth enabled\n`);
});

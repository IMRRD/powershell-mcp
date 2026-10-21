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

const PORT = parseInt(process.env.PORT ?? "4242", 10);
const TOKEN = process.env.TELEMETRY_TOKEN ?? "";
const DATA_FILE = process.env.TELEMETRY_FILE ?? path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "telemetry.jsonl",
);

const MAX_BODY_BYTES = 16 * 1024;
const TOOLS = new Set(['run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program']);
const OS = new Set(['win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android']);
const date = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function validPayload(p) {
  if (!object(p) || !['startup', 'tool_counts'].includes(p.event)) return false;
  const expected = p.event === 'startup' ? ['event', 'hostId', 'os', 'ts', 'version'] : ['counts', 'event', 'hostId', 'os', 'ts', 'version'];
  if (Object.keys(p).sort().join(',') !== expected.join(',')) return false;
  if (typeof p.hostId !== 'string' || !p.hostId || p.hostId.length > 256 || typeof p.version !== 'string' || !p.version || p.version.length > 256 || !OS.has(p.os) || !date(p.ts)) return false;
  return p.event === 'startup' || (object(p.counts) && Object.keys(p.counts).length > 0 && Object.entries(p.counts).every(([name, count]) => TOOLS.has(name) && Number.isSafeInteger(count) && count > 0));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", c => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) { reject(Error('too large')); req.resume(); return; }
      chunks.push(c);
    });
    req.on("end", () => { if (bytes <= MAX_BODY_BYTES) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
    res.writeHead(err.message === 'too large' ? 413 : 400);
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

  // Append to JSONL
  const line = JSON.stringify({
    ...payload,
    _receivedAt: new Date().toISOString(),
  }) + "\n";

  try {
    fs.appendFileSync(DATA_FILE, line, "utf8");
  } catch (err) {
    process.stderr.write(`[telemetry] write error: ${err.message}\n`);
    res.writeHead(500);
    res.end("Storage error");
    return;
  }

  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => {
  process.stderr.write(`[telemetry] collector listening on :${PORT}\n`);
  process.stderr.write(`[telemetry] writing to ${DATA_FILE}\n`);
  if (TOKEN) process.stderr.write(`[telemetry] token auth enabled\n`);
});

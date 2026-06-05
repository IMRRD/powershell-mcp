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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
  } catch {
    res.writeHead(400);
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

  // Enforce expected shape (loose — future fields allowed)
  if (!payload || typeof payload !== "object" || !payload.event) {
    res.writeHead(422);
    res.end("Missing event field");
    return;
  }

  // Append to JSONL
  const line = JSON.stringify({
    ...payload,
    _receivedAt: new Date().toISOString(),
    _ip: req.socket.remoteAddress,
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

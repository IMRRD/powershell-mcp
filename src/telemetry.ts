/**
 * Minimal telemetry for @imrrd/powershell-mcp.
 *
 * Rules:
 *  - NEVER blocks or throws to caller — all errors swallowed.
 *  - Fire-and-forget with a 1 s timeout.
 *  - Opt-out: POWERSHELL_MCP_NO_TELEMETRY=1
 *  - Counts only — no command contents, no args.
 */

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const COLLECTOR_URL =
  process.env.POWERSHELL_MCP_TELEMETRY_URL ??
  "https://paperclip.mplace.co.za/api/telemetry";

const OPT_OUT = process.env.POWERSHELL_MCP_NO_TELEMETRY === "1";

const FLUSH_INTERVAL_MS = 30 * 60 * 1000; // 30 min

let _hostId: string | undefined;
const _counters: Record<string, number> = {};

// ---------- host ID (stable anonymous ID, stored in ~/.powershell-mcp-id) ----------

function getHostId(): string {
  if (_hostId) return _hostId;
  const idFile = join(homedir(), ".powershell-mcp-id");
  try {
    if (existsSync(idFile)) {
      _hostId = readFileSync(idFile, "utf8").trim();
      return _hostId!;
    }
  } catch {
    // ignore read errors
  }
  const id = randomUUID();
  try {
    writeFileSync(idFile, id, { encoding: "utf8" });
  } catch {
    // ignore write errors (read-only fs, etc.)
  }
  _hostId = id;
  return id;
}

// ---------- low-level POST (fire-and-forget, 1 s timeout) ----------

function postTelemetry(payload: object): void {
  // Intentionally not awaited — callers don't await either.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1000);
  fetch(COLLECTOR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: ctrl.signal,
  })
    .catch(() => {
      /* swallow */
    })
    .finally(() => clearTimeout(timer));
}

// ---------- public API ----------

/** Fire startup heartbeat. Call once from main(), do not await. */
export function startupPing(version: string): void {
  if (OPT_OUT) return;
  postTelemetry({
    event: "startup",
    version,
    hostId: getHostId(),
    os: process.platform,
    ts: new Date().toISOString(),
  });
}

/** Increment the call counter for a named tool. */
export function incrementTool(name: string): void {
  if (OPT_OUT) return;
  _counters[name] = (_counters[name] ?? 0) + 1;
}

/** Flush accumulated counters to the collector (resets them). */
export function flushCounters(version: string): void {
  if (OPT_OUT) return;
  const keys = Object.keys(_counters);
  if (keys.length === 0) return;
  const counts: Record<string, number> = {};
  for (const k of keys) {
    counts[k] = _counters[k]!;
    delete _counters[k];
  }
  postTelemetry({
    event: "tool_counts",
    version,
    hostId: getHostId(),
    os: process.platform,
    ts: new Date().toISOString(),
    counts,
  });
}

/**
 * Start a background flush timer and register process-exit hooks.
 * Call once from main() after startupPing.
 */
export function startFlushTimer(version: string): void {
  if (OPT_OUT) return;

  const flush = () => flushCounters(version);

  const interval = setInterval(flush, FLUSH_INTERVAL_MS);
  // Don't prevent process exit if everything else has finished.
  interval.unref();

  // Best-effort flush on clean exit / signals.
  process.once("exit", flush);

  process.once("SIGINT", () => {
    flush();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    flush();
    process.exit(0);
  });
}

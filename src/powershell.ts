import { spawnOwned, type SupervisorReason } from "./owned-process.js";
import os from "node:os";
import { OutputCollector, captureDiagnostic, type StreamCapture } from "./output-collector.js";
import { PRODUCER_BOOTSTRAP, PRODUCER_PIPELINE } from "./producer-output.js";
import { captureFromEnvelope, frameLimit, payloadLimit, protectedPayload } from "./envelope-output.js";
import { randomBytes } from "node:crypto";
import { logStore } from "./full-logs.js";
import { PARAMETER_BOOTSTRAP, validateParameters, INPUT_LIMIT } from "./typed-input.js";

const TYPED_BOOTSTRAP = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${PARAMETER_BOOTSTRAP}
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
$params = Convert-Parameter $payload.parameters
& ([ScriptBlock]::Create([string]$payload.source)) @params`;

export interface ErrorRecordSummary { category: string; fullyQualifiedErrorId: string; exceptionType: string; message: string }

/** Result of a PowerShell invocation. */
export interface PsResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** The caller deadline elapsed; does not itself prove termination. */
  timedOut: boolean;
  cancelled?: boolean;
  treeTerminated?: boolean;
  /** Fixed, bounded supervisor failure code; never child output or exception text. */
  supervisorReason?: SupervisorReason;
  durationMs: number;
  /** The executable that was used (e.g. "pwsh" or "powershell.exe"). */
  shell: string;
  /** True if stdout/stderr was truncated at maxOutputBytes. */
  truncated: boolean;
  stdoutCapture?: StreamCapture;
  stderrCapture?: StreamCapture;
  outputLimitBytes?: number;
  spawnError?: string;
  invocationStatus?: "completed" | "remote_error" | "transport_error";
  errorRecords?: ErrorRecordSummary[];
  errorRecordsTruncated?: boolean;
  scriptError?: boolean;
  protocolError?: boolean;
  log?: { handle: string; complete: boolean; stdoutBytes: number; stderrBytes: number; expiresAt: string };
}

export interface RunOptions {
  /** JSON-safe named script parameters, bound without source interpolation. */
  parameters?: Record<string, unknown>;
  /** Working directory for the command. */
  cwd?: string;
  /** Hard timeout in milliseconds (default 60000). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the PowerShell executable (default: env PWSH_MCP_EXE -> pwsh -> powershell.exe). */
  exe?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Optional data written to the child only after it has spawned. */
  stdin?: string;
  /** Cap captured stdout+stderr (bytes each, default 1 MiB). */
  maxOutputBytes?: number;
  tail?: boolean;
  /** Internal framed transport stderr cap; never a public tool option. */
  stderrLimitBytes?: number;
  stderrTail?: boolean;
  errorPolicy?: "legacy" | "strict";
  logOutput?: boolean;
  logQuotaBytes?: number;
}

const STRICT_BOOTSTRAP = `
$payloadLimit = [int]$env:PS_MCP_OUTPUT_LIMIT
$payloadTail = $env:PS_MCP_OUTPUT_TAIL -eq '1'
${PRODUCER_BOOTSTRAP}
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
$consoleOut = [Console]::Out
[Console]::SetOut($producer)
try {
  if ($parseErrors.Count -gt 0) {
    foreach ($entry in $parseErrors) { RecordError $entry }
  } else {
    try {
      # Command-level Stop avoids PS 5.1 promoting successful native stderr.
      $PSDefaultParameterValues['*:ErrorAction'] = 'Stop'
      $nativeErrorsAreDiagnostics = $true
      # Catch upstream so a terminating script error cannot stop the formatter
      # before it has drained output already emitted by the script.
      & { try { & ([ScriptBlock]::Create($source)) } catch { RecordError $_; [string]$_.Exception.Message } } 2>&1 3>&1 4>&1 5>&1 6>&1 | ${PRODUCER_PIPELINE}
    } catch { RecordError $_; $producer.WriteLine([string]$_.Exception.Message) }
  }
} finally { [Console]::SetOut($consoleOut) }
$source = $null
$body = $producer.Snapshot()
$body.failed = [bool]$producerState.failed
$body.records = @($errors.ToArray())
$body.recordsTruncated = [bool]$producerState.limited
[Console]::Out.WriteLine('PS-RESULT:' + $env:PS_MCP_FRAME + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress))))
`;

function strictFailure(result: PsResult, maxOutput: number, tail: boolean, diagnostic?: string): PsResult {
  const stderrCapture = diagnostic === undefined ? result.stderrCapture : captureDiagnostic(result.stderrCapture, `\n${diagnostic}`, maxOutput, tail);
  return { ...result, stdout: "", stdoutCapture: undefined, stderr: stderrCapture?.text ?? "",
    stderrCapture, truncated: !!stderrCapture?.truncated, outputLimitBytes: maxOutput,
    ...(diagnostic ? { protocolError: true } : {}) };
}

function decodeStrict(result: PsResult, frame: string, maxOutput: number, tail: boolean, logOutput = false, quota?: number, reservedLog?: ReturnType<typeof logStore.create>): PsResult {
  if (result.timedOut || result.cancelled || result.spawnError) return strictFailure(result, maxOutput, tail);
  const match = result.stdout.match(/^PS-RESULT:([0-9a-f]{48}):([A-Za-z0-9+/=]+)\r?\n$/);
  if (result.stdoutCapture?.truncated || result.exitCode !== 0 || !match || match[1] !== frame) return strictFailure(result, maxOutput, tail, "Missing or invalid strict result envelope");
  try {
    const body = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
    if (typeof body.output !== "string" || typeof body.failed !== "boolean" || typeof body.recordsTruncated !== "boolean" || !Array.isArray(body.records) || body.records.length > 8 || body.records.some((r: any) => !r || ["category", "fullyQualifiedErrorId", "exceptionType", "message"].some(k => typeof r[k] !== "string" || Buffer.byteLength(r[k], "utf8") > 1024)) || (body.failed && body.records.length === 0)) throw Error("Invalid strict result");
    const full = captureFromEnvelope(body, body.output);
    if (full.capturedBytes > payloadLimit(maxOutput, logOutput, quota)) throw Error("Output exceeds limit");
    const protectedResult = logOutput ? protectedPayload(body, maxOutput, tail, quota, reservedLog) : undefined;
    const stdoutCapture = protectedResult?.display ?? full;
    return { ...result, stdout: stdoutCapture.text, stdoutCapture, ...(protectedResult ? { log: protectedResult.log } : {}), outputLimitBytes: maxOutput,
      truncated: stdoutCapture.truncated || !!result.stderrCapture?.truncated,
      scriptError: body.failed, errorRecords: body.records, errorRecordsTruncated: body.recordsTruncated };
  } catch { return strictFailure(result, maxOutput, tail, "Invalid strict result body"); }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;


/**
 * Pick the PowerShell executable. Prefers an explicit override, then `pwsh`
 * (PowerShell 7+, cross-platform), then Windows `powershell.exe`.
 */
export function resolvePowerShellCandidates(
  override?: string,
  platform: NodeJS.Platform = os.platform(),
  envOverride: string | undefined = process.env.PWSH_MCP_EXE,
): string[] {
  const explicit = override?.trim();
  if (explicit) return [explicit];

  const configured = envOverride?.trim();
  if (configured) return [configured];

  return platform === "win32" ? ["pwsh", "powershell.exe"] : ["pwsh"];
}

export function resolvePowerShellExe(override?: string): string {
  return resolvePowerShellCandidates(override)[0];
}

/**
 * Build the argument vector for invoking a script string non-interactively.
 * Windows PowerShell honours -ExecutionPolicy; pwsh ignores it harmlessly.
 */
export function buildArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ];
}

/**
 * Run a PowerShell script in a HIDDEN process (no console window pops up — the
 * whole point: `windowsHide: true`). Captures stdout/stderr, enforces a hard
 * timeout, and never throws on a non-zero exit (it's reported in `exitCode`).
 */
export function runPowerShell(script: string, opts: RunOptions = {}): Promise<PsResult> {
  if (opts.signal?.aborted) return Promise.resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false,
    cancelled: true, durationMs: 0, shell: resolvePowerShellExe(opts.exe), truncated: false,
    outputLimitBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT });
  if (opts.parameters !== undefined) {
    validateParameters(opts.parameters);
    const json = JSON.stringify({ source: script, parameters: opts.parameters });
    if (Buffer.byteLength(json, "utf8") > INPUT_LIMIT) throw Error("input limit exceeded");
    if (opts.errorPolicy !== "strict") return runPowerShell(TYPED_BOOTSTRAP, { ...opts, parameters: undefined, stdin: Buffer.from(json, "utf8").toString("base64") });
  }
  if (opts.errorPolicy === "strict") {
    const reservedLog = opts.logOutput ? logStore.create(opts.logQuotaBytes) : undefined;
    const frame = randomBytes(24).toString("hex");
    const limit = opts.maxOutputBytes ?? 1_048_576;
    const captureLimit = payloadLimit(limit, opts.logOutput, opts.logQuotaBytes);
    const typed = opts.parameters !== undefined;
    const bootstrap = typed ? STRICT_BOOTSTRAP.replace(
      "$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
      `${PARAMETER_BOOTSTRAP}\n$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json\n$source = [string]$payload.source\n$params = Convert-Parameter $payload.parameters`,
    ).replace("& ([ScriptBlock]::Create($source)) }", "& ([ScriptBlock]::Create($source)) @params }") : STRICT_BOOTSTRAP;
    return runPowerShell(bootstrap, { ...opts, parameters: undefined, logOutput: false, maxOutputBytes: frameLimit(captureLimit), tail: false, stderrLimitBytes: limit, stderrTail: opts.tail, errorPolicy: "legacy", stdin: Buffer.from(typed ? JSON.stringify({ source: script, parameters: opts.parameters }) : script, "utf8").toString("base64"), env: { ...opts.env, PS_MCP_FRAME: frame, PS_MCP_OUTPUT_LIMIT: String(captureLimit), PS_MCP_OUTPUT_TAIL: opts.tail ? "1" : "0" } }).then(r => {
      const decoded = decodeStrict(r, frame, limit, opts.tail ?? false, opts.logOutput, opts.logQuotaBytes, reservedLog);
      if (reservedLog && !decoded.log) logStore.delete(reservedLog.finish(false).handle);
      return decoded;
    }, error => { if (reservedLog) logStore.delete(reservedLog.finish(false).handle); throw error; });
  }
  const candidates = resolvePowerShellCandidates(opts.exe);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<PsResult>((resolve, reject) => {
    let resolved = false;

    const failedResult = (exe: string, err: unknown): PsResult => {
      const stderrCapture = captureDiagnostic(undefined, `Failed to spawn ${exe}: ${(err as Error).message}`, opts.stderrLimitBytes ?? maxOutput, opts.stderrTail ?? opts.tail);
      return ({
      stdout: "",
      stderr: stderrCapture.text,
      stderrCapture,
      exitCode: null,
      timedOut: false,
      durationMs: Date.now() - started,
      shell: exe,
      truncated: stderrCapture.truncated,
      outputLimitBytes: maxOutput,
      spawnError: (err as Error).message,
    });
    };

    const attempt = (candidateIndex: number): void => {
      const exe = candidates[candidateIndex];
      const log = opts.logOutput ? logStore.create(opts.logQuotaBytes) : undefined;
      let child;
      try {
        child = spawnOwned(exe, buildArgs(script), {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
          windowsHide: true, // <-- no popup window, ever
          stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (err) {
        if (log) logStore.delete(log.finish().handle);
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && candidateIndex + 1 < candidates.length) {
          attempt(candidateIndex + 1);
        } else {
          resolved = true;
          resolve(failedResult(exe, err));
        }
        return;
      }

      const out = new OutputCollector(maxOutput, opts.tail);
      const errOut = new OutputCollector(opts.stderrLimitBytes ?? maxOutput, opts.stderrTail ?? opts.tail);
      let timedOut = false;
      let cancelled = false;
      let attemptFinished = false;

      if (opts.stdin !== undefined) {
        child.stdin?.on("error", () => { /* child error/close owns the result */ });
        child.once("spawn", () => child.stdin?.end(opts.stdin));
      }

      child.stdout?.on("data", (b: Buffer) => { out.append(b); log?.append("stdout", b); });
      child.stderr?.on("data", (b: Buffer) => { errOut.append(b); log?.append("stderr", b); });
      const captures = () => {
        const stdoutCapture = out.snapshot(), stderrCapture = errOut.snapshot();
        return { stdout: stdoutCapture.text, stderr: stderrCapture.text, stdoutCapture, stderrCapture,
          outputLimitBytes: maxOutput, truncated: stdoutCapture.truncated || stderrCapture.truncated };
      };

      const terminate = () => child.cancel();
      const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
      const abort = () => { cancelled = true; terminate(); };
      opts.signal?.addEventListener("abort", abort, { once: true });
      child.once("spawn", () => { if (opts.signal?.aborted) abort(); });

      child.on("error", (err) => {
        if (attemptFinished || resolved) return;
        attemptFinished = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && candidateIndex + 1 < candidates.length) {
          if (log) logStore.delete(log.finish().handle);
          try { attempt(candidateIndex + 1); } catch (failure) { reject(failure); }
          return;
        }
        resolved = true;
        errOut.append(Buffer.from(`\n[spawn error] ${(err as Error).message}`, "utf8"));
        resolve({
          ...captures(),
          spawnError: (err as Error).message,
          ...(log ? { log: log.finish(false) } : {}),
          exitCode: null,
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
          shell: exe,
        });
      });

      child.on("close", (code) => {
        if (attemptFinished || resolved) return;
        attemptFinished = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abort);
        resolved = true;
        resolve({
          ...captures(),
          exitCode: code,
          treeTerminated: child.treeTerminated,
          ...(child.supervisorReason ? { supervisorReason: child.supervisorReason } : {}),
          ...(log ? { log: log.finish(!timedOut && !cancelled && child.treeTerminated !== false) } : {}),
          timedOut,
          cancelled,
          durationMs: Date.now() - started,
          shell: exe,
        });
      });
    };

    attempt(0);
  });
}

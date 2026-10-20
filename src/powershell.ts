import { spawn } from "node:child_process";
import os from "node:os";
import { OutputCollector, captureDiagnostic, type StreamCapture } from "./output-collector.js";
import { LIMIT_BOOTSTRAP, captureFromEnvelope, FRAME_OUTPUT_LIMIT } from "./envelope-output.js";
import { randomBytes } from "node:crypto";

export interface ErrorRecordSummary { category: string; fullyQualifiedErrorId: string; exceptionType: string; message: string }

/** Result of a PowerShell invocation. */
export interface PsResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if the run was killed because it exceeded timeoutMs. */
  timedOut: boolean;
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
}

export interface RunOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Hard timeout in milliseconds (default 60000). */
  timeoutMs?: number;
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
}

const STRICT_BOOTSTRAP = `
$payloadLimit = [int]$env:PS_MCP_OUTPUT_LIMIT
$payloadTail = $env:PS_MCP_OUTPUT_TAIL -eq '1'
${LIMIT_BOOTSTRAP}
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
$items = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList
$failed = $false
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {
  $failed = $true
  foreach ($entry in $parseErrors) { [void]$errors.Add([pscustomobject]@{ category='ParserError'; fullyQualifiedErrorId=[string]$entry.ErrorId; exceptionType='ParseError'; message=[string]$entry.Message }) }
} else {
  try {
    # Command-level Stop avoids PS 5.1 promoting successful native stderr to a terminating error.
    $PSDefaultParameterValues['*:ErrorAction'] = 'Stop'
    & ([ScriptBlock]::Create($source)) 2>&1 3>&1 4>&1 5>&1 6>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) {
        if ($_.FullyQualifiedErrorId -ne 'NativeCommandError') { $failed = $true; [void]$errors.Add($_) }
        [void]$items.Add([string]$_.Exception.Message)
      } else { [void]$items.Add($_) }
    }
  } catch { $failed = $true; [void]$errors.Add($_); [void]$items.Add([string]$_.Exception.Message) }
}
$source = $null
function LimitText($value) {
  $text = [string]$value
  if ($text.Length -gt 256) { $text = $text.Substring(0,256); $script:limited = $true }
  return $text
}
$limited = $errors.Count -gt 8
$summaries = @()
foreach ($entry in @($errors | Select-Object -First 8)) {
  if ($entry -is [System.Management.Automation.ErrorRecord]) {
    $summaries += @{ category=(LimitText $entry.CategoryInfo.Category); fullyQualifiedErrorId=(LimitText $entry.FullyQualifiedErrorId); exceptionType=(LimitText $entry.Exception.GetType().FullName); message=(LimitText $entry.Exception.Message) }
  } else { $summaries += @{ category=(LimitText $entry.category); fullyQualifiedErrorId=(LimitText $entry.fullyQualifiedErrorId); exceptionType=(LimitText $entry.exceptionType); message=(LimitText $entry.message) } }
}
$bounded = LimitOutput ([string]($items.ToArray() | Out-String -Width 240))
$body = @{ output=$bounded.output; observedBytes=$bounded.observedBytes; capturedBytes=$bounded.capturedBytes; omittedBytes=$bounded.omittedBytes; truncated=$bounded.truncated; failed=[bool]$failed; records=@($summaries); recordsTruncated=[bool]$limited }
[Console]::Out.WriteLine('PS-RESULT:' + $env:PS_MCP_FRAME + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 5 -Compress))))
`;

function strictFailure(result: PsResult, maxOutput: number, tail: boolean, diagnostic?: string): PsResult {
  const stderrCapture = diagnostic === undefined ? result.stderrCapture : captureDiagnostic(result.stderrCapture, `\n${diagnostic}`, maxOutput, tail);
  return { ...result, stdout: "", stdoutCapture: undefined, stderr: stderrCapture?.text ?? "",
    stderrCapture, truncated: !!stderrCapture?.truncated, outputLimitBytes: maxOutput,
    ...(diagnostic ? { protocolError: true } : {}) };
}

function decodeStrict(result: PsResult, frame: string, maxOutput: number, tail: boolean): PsResult {
  if (result.timedOut || result.spawnError) return strictFailure(result, maxOutput, tail);
  const match = result.stdout.match(/^PS-RESULT:([0-9a-f]{48}):([A-Za-z0-9+/=]+)\r?\n$/);
  if (result.stdoutCapture?.truncated || result.exitCode !== 0 || !match || match[1] !== frame) return strictFailure(result, maxOutput, tail, "Missing or invalid strict result envelope");
  try {
    const body = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
    if (typeof body.output !== "string" || typeof body.failed !== "boolean" || typeof body.recordsTruncated !== "boolean" || !Array.isArray(body.records) || body.records.length > 8 || body.records.some((r: any) => !r || ["category", "fullyQualifiedErrorId", "exceptionType", "message"].some(k => typeof r[k] !== "string" || Buffer.byteLength(r[k], "utf8") > 1024)) || (body.failed && body.records.length === 0)) throw Error("Invalid strict result");
    const stdoutCapture = captureFromEnvelope(body, body.output);
    if (stdoutCapture.capturedBytes > maxOutput) throw Error("Output exceeds limit");
    return { ...result, stdout: body.output, stdoutCapture, outputLimitBytes: maxOutput,
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
  if (opts.errorPolicy === "strict") {
    const frame = randomBytes(24).toString("hex");
    const limit = opts.maxOutputBytes ?? 1_048_576;
    return runPowerShell(STRICT_BOOTSTRAP, { ...opts, maxOutputBytes: FRAME_OUTPUT_LIMIT, tail: false, stderrLimitBytes: limit, stderrTail: opts.tail, errorPolicy: "legacy", stdin: Buffer.from(script, "utf8").toString("base64"), env: { ...opts.env, PS_MCP_FRAME: frame, PS_MCP_OUTPUT_LIMIT: String(limit), PS_MCP_OUTPUT_TAIL: opts.tail ? "1" : "0" } }).then(r => decodeStrict(r, frame, limit, opts.tail ?? false));
  }
  const candidates = resolvePowerShellCandidates(opts.exe);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<PsResult>((resolve) => {
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
      let child;
      try {
        child = spawn(exe, buildArgs(script), {
          cwd: opts.cwd,
          env: { ...process.env, ...(opts.env ?? {}) },
          windowsHide: true, // <-- no popup window, ever
          stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        });
      } catch (err) {
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
      let attemptFinished = false;

      if (opts.stdin !== undefined) {
        child.stdin?.on("error", () => { /* child error/close owns the result */ });
        child.once("spawn", () => child.stdin?.end(opts.stdin));
      }

      child.stdout?.on("data", (b: Buffer) => out.append(b));
      child.stderr?.on("data", (b: Buffer) => errOut.append(b));
      const captures = () => {
        const stdoutCapture = out.snapshot(), stderrCapture = errOut.snapshot();
        return { stdout: stdoutCapture.text, stderr: stderrCapture.text, stdoutCapture, stderrCapture,
          outputLimitBytes: maxOutput, truncated: stdoutCapture.truncated || stderrCapture.truncated };
      };

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          // Kill the whole tree on Windows; plain kill elsewhere.
          if (os.platform() === "win32" && child.pid) {
            spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
          } else {
            child.kill("SIGKILL");
          }
        } catch { /* ignore */ }
      }, timeoutMs);

      child.on("error", (err) => {
        if (attemptFinished || resolved) return;
        attemptFinished = true;
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && candidateIndex + 1 < candidates.length) {
          attempt(candidateIndex + 1);
          return;
        }
        resolved = true;
        errOut.append(Buffer.from(`\n[spawn error] ${(err as Error).message}`, "utf8"));
        resolve({
          ...captures(),
          spawnError: (err as Error).message,
          exitCode: null,
          timedOut,
          durationMs: Date.now() - started,
          shell: exe,
        });
      });

      child.on("close", (code) => {
        if (attemptFinished || resolved) return;
        attemptFinished = true;
        clearTimeout(timer);
        resolved = true;
        resolve({
          ...captures(),
          exitCode: code,
          timedOut,
          durationMs: Date.now() - started,
          shell: exe,
        });
      });
    };

    attempt(0);
  });
}

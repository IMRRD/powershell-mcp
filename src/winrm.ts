import { runPowerShell, type PsResult } from "./powershell.js";
import { randomBytes } from "node:crypto";
import { PRODUCER_BOOTSTRAP, PRODUCER_PIPELINE } from "./producer-output.js";
import { displayCapture, captureFromEnvelope, frameLimit, payloadLimit, protectedPayload } from "./envelope-output.js";
import { captureDiagnostic, combineCaptures, OutputCollector } from "./output-collector.js";
import { logStore } from "./full-logs.js";
import { PARAMETER_BOOTSTRAP, validateParameters, INPUT_LIMIT } from "./typed-input.js";
import { WINRM_TRANSPORT_REASONS, type WinRmReason } from './winrm-reason.js';

export interface WinRmOptions {
  computerName: string;
  command: string;
  parameters?: Record<string, unknown>;
  username?: string;
  password?: string;
  useSsl?: boolean;
  /** Negotiate (default) | Kerberos | Basic | CredSSP | Default */
  authentication?: "Default" | "Negotiate" | "Kerberos" | "Basic" | "CredSSP";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal batch deadline, checked after synchronous preparation at launch. */
  dispatchDeadlineAt?: number;
  maxOutputBytes?: number;
  tail?: boolean;
  logOutput?: boolean;
  logQuotaBytes?: number;
}

export class WinRmDispatchDeadlineError extends Error {}

interface WinRmInput {
  computerName: string;
  command: string;
  parameters?: Record<string, unknown>;
  username?: string;
  password?: string;
  useSsl?: boolean;
  authentication?: WinRmOptions["authentication"];
  outputLimit?: number;
  outputTail?: boolean;
}

/**
 * Fixed, non-sensitive bootstrap. All caller-controlled values arrive as a
 * base64-encoded JSON payload over stdin and never enter process metadata.
 */
export const WINRM_BOOTSTRAP = [
  "$encoded = [Console]::In.ReadToEnd();",
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded));",
  "$payload = $json | ConvertFrom-Json;",
  "$payloadLimit = [int]$payload.outputLimit; $payloadTail = [bool]$payload.outputTail;",
  PARAMETER_BOOTSTRAP,
  "$encoded = $null;",
  "$json = $null;",
  "$invoke = @{",
  "  ComputerName = [string]$payload.computerName;",
  `  ScriptBlock = { param($source, $bound, $payloadLimit, $payloadTail)
${PRODUCER_BOOTSTRAP}
$producerErr = [McpBoundedWriter]::new([int]$payloadLimit, [bool]$payloadTail)
$consoleOut = [Console]::Out; $consoleErr = [Console]::Error
[Console]::SetOut($producer); [Console]::SetError($producerErr)
try {
  try { & ([ScriptBlock]::Create($source)) @bound 2>&1 3>&1 4>&1 5>&1 6>&1 | ${PRODUCER_PIPELINE} }
  catch { RecordError $_; $producer.WriteLine([string]$_.Exception.Message) }
} finally { [Console]::SetOut($consoleOut); [Console]::SetError($consoleErr) }
$bounded = $producer.Snapshot()
[pscustomobject]@{ Output = $bounded.output; observedBytes = $bounded.observedBytes; capturedBytes = $bounded.capturedBytes; omittedBytes = $bounded.omittedBytes; truncated = $bounded.truncated; stderr = $producerErr.Snapshot(); RemoteError = [bool]$producerState.failed; ErrorRecords = @($errors.ToArray()); ErrorRecordsTruncated = [bool]$producerState.limited }
};`,
  "  ArgumentList = @([string]$payload.command, $(if ($null -eq $payload.parameters) { @{} } else { Convert-Parameter $payload.parameters }), $payloadLimit, $payloadTail);",
  "};",
  "if ($payload.useSsl) { $invoke.UseSSL = $true; }",
  "if ($null -ne $payload.authentication -and [string]$payload.authentication -ne '') {",
  "  $invoke.Authentication = [string]$payload.authentication;",
  "}",
  "if ($null -ne $payload.username -and [string]$payload.username -ne '') {",
  "  $plain = if ($null -eq $payload.password) { '' } else { [string]$payload.password };",
  "  $secure = ConvertTo-SecureString $plain -AsPlainText -Force;",
  "  $invoke.Credential = [System.Management.Automation.PSCredential]::new([string]$payload.username, $secure);",
  "  $payload.password = $null;",
  "  $plain = $null;",
  "}",
  "$reason = 'invoke_exception';",
  "try {",
  "  $results = @(Invoke-Command @invoke -ErrorAction Stop);",
  "  $reason = 'wrapper_result_invalid';",
  "  if ($results.Count -ne 1 -or $null -eq $results[0] -or $null -eq $results[0].PSObject.Properties['Output'] -or $null -eq $results[0].PSObject.Properties['RemoteError'] -or $null -eq $results[0].PSObject.Properties['ErrorRecords'] -or $null -eq $results[0].PSObject.Properties['ErrorRecordsTruncated'] -or $results[0].Output -isnot [string] -or $results[0].RemoteError -isnot [bool] -or $results[0].ErrorRecordsTruncated -isnot [bool]) { throw 'Invalid WinRM wrapper result' };",
  "  $result = $results[0];",
  "  $bounded = $result;",
  "  $body = @{ status = $(if ($result.RemoteError) { 'remote_error' } else { 'completed' }); output = $bounded.Output; stderr = $result.stderr; observedBytes = $bounded.observedBytes; capturedBytes = $bounded.capturedBytes; omittedBytes = $bounded.omittedBytes; truncated = $bounded.truncated; records = @($result.ErrorRecords); recordsTruncated = $result.ErrorRecordsTruncated };",
  `} catch {
  # Inspect the caught local exception's exact runtime type, never its text,
  # remote ErrorRecord fields or a guessed numeric WSMan error mapping.
  if ($reason -eq 'invoke_exception') {
    switch ($_.Exception.GetType().FullName) {
      'System.Security.Authentication.AuthenticationException' { $reason = 'authentication_exception' }
      'System.UnauthorizedAccessException' { $reason = 'access_exception' }
      'System.Management.Automation.Remoting.PSRemotingTransportException' { $reason = 'remoting_transport_exception' }
    }
  }
  $body = @{ status = 'transport_error'; reason = $reason; output = ([string]$_).Substring(0, [Math]::Min(512, ([string]$_).Length)) }
}`,
  "[Console]::Out.WriteLine('WINRM-RESULT:' + $payload.frame + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress))));",
].join("\n");

export function buildWinRmInput(opts: WinRmOptions): string {
  const input: WinRmInput = {
    computerName: opts.computerName,
    command: opts.command,
    ...(opts.parameters !== undefined ? { parameters: opts.parameters } : {}),
  };

  if (opts.username !== undefined) {
    input.username = opts.username;
    input.password = opts.password ?? "";
  }
  if (opts.useSsl !== undefined) input.useSsl = opts.useSsl;
  if (opts.authentication !== undefined) input.authentication = opts.authentication;
  input.outputLimit = payloadLimit(opts.maxOutputBytes ?? 1_048_576, opts.logOutput, opts.logQuotaBytes);
  input.outputTail = opts.tail ?? false;

  return Buffer.from(JSON.stringify(input), "utf8").toString("base64");
}

/**
 * Run a command on a remote *Windows* host via PowerShell Remoting (WinRM),
 * using Invoke-Command -ComputerName. Native to Windows Server — no SSH server
 * or agent install required on the target, only WinRM enabled. Output is
 * captured by the local hidden PowerShell host (no console window).
 */
export function runWinRm(opts: WinRmOptions): Promise<PsResult> {
  if (opts.parameters !== undefined) validateParameters(opts.parameters);
  if (Buffer.byteLength(JSON.stringify({ command: opts.command, parameters: opts.parameters }), "utf8") > INPUT_LIMIT) throw Error("input limit exceeded");
  const reservedLog = opts.logOutput ? logStore.create(opts.logQuotaBytes) : undefined;
  const frame = randomBytes(24).toString("hex");
  const input = JSON.parse(Buffer.from(buildWinRmInput(opts), "base64").toString("utf8"));
  input.frame = frame;
  const stdin = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  const maxOutputBytes = frameLimit(2 * payloadLimit(opts.maxOutputBytes ?? 1_048_576, opts.logOutput, opts.logQuotaBytes));
  const remaining = opts.dispatchDeadlineAt === undefined ? opts.timeoutMs ?? 120_000 : Math.ceil(opts.dispatchDeadlineAt - Date.now());
  if (remaining <= 0) {
    if (reservedLog) logStore.delete(reservedLog.finish(false).handle);
    throw new WinRmDispatchDeadlineError("Invocation deadline elapsed before dispatch; remote execution unverified");
  }
  return runPowerShell(WINRM_BOOTSTRAP, {
    stdin,
    timeoutMs: remaining,
    signal: opts.signal,
    maxOutputBytes,
    stderrLimitBytes: payloadLimit(opts.maxOutputBytes ?? 1_048_576, opts.logOutput, opts.logQuotaBytes),
    stderrTail: opts.tail,
  }).then((result) => {
    const decoded = decodeWinRmResult(result, frame, opts.maxOutputBytes ?? 1_048_576, opts.tail, opts.logOutput, opts.logQuotaBytes, reservedLog);
    if (reservedLog && !decoded.log) logStore.delete(reservedLog.finish(false).handle);
    return decoded;
  }, error => { if (reservedLog) logStore.delete(reservedLog.finish(false).handle); throw error; });
}

/** Validate the local frame before interpreting remote output as data. */
export function decodeWinRmResult(result: PsResult, frame: string, maxOutput = 1_048_576, tail = false, logOutput = false, quota?: number, reservedLog?: ReturnType<typeof logStore.create>): PsResult {
    const failure = (reason: WinRmReason, diagnostic?: string): PsResult => {
      const stderrCapture = diagnostic === undefined
        ? result.stderrCapture && displayCapture(result.stderrCapture, maxOutput, tail)
        : captureDiagnostic(result.stderrCapture, `\n${diagnostic}`, maxOutput, tail);
      return { ...result, stdout: "", stdoutCapture: undefined, stderr: stderrCapture?.text ?? "",
        stderrCapture, truncated: !!stderrCapture?.truncated, outputLimitBytes: maxOutput, invocationStatus: "transport_error", winrmReason: reason };
    };
    if (result.timedOut) return failure('timeout');
    if (result.cancelled) return failure('cancelled');
    if (result.spawnError) return failure('local_launch_error');
    if (result.protocolError || result.exitCode !== 0) return failure('local_host_error', 'Missing or invalid WinRM result envelope');
    const match = result.stdout.match(/^WINRM-RESULT:([0-9a-f]{48}):([A-Za-z0-9+/=]+)\s*$/);
    if (result.stdoutCapture?.truncated || (result.truncated && !result.stderrCapture?.truncated) || !match || match[1] !== frame) {
      return failure('frame_invalid', "Missing or invalid WinRM result envelope");
    }
    try {
      const body = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
      if (!["completed", "remote_error", "transport_error"].includes(body.status) || typeof body.output !== "string") throw Error("Invalid result body");
      if ('reason' in body && (body.status !== 'transport_error' || !WINRM_TRANSPORT_REASONS.includes(body.reason))) throw Error('Invalid boundary reason');
      if (body.status !== "transport_error" && (typeof body.recordsTruncated !== "boolean" || !Array.isArray(body.records) || body.records.length > 8 || body.records.some((r: any) => !r || ["category", "fullyQualifiedErrorId", "exceptionType", "message"].some(k => typeof r[k] !== "string")) || (body.status === "remote_error" && body.records.length === 0))) throw Error("Invalid remote records");
      const records = body.status === "transport_error" ? undefined : body.records.map((r: any) => Object.fromEntries(["category", "fullyQualifiedErrorId", "exceptionType", "message"].map(k => [k, Buffer.from(r[k], "utf8").subarray(0, 256).toString("utf8")])));
      if (body.status === "transport_error") {
        const stderrCapture = captureDiagnostic(result.stderrCapture, body.output, maxOutput, tail);
        return { ...result, stdout: "", stdoutCapture: undefined, stderr: stderrCapture.text, stderrCapture,
          outputLimitBytes: maxOutput, truncated: stderrCapture.truncated, invocationStatus: "transport_error", winrmReason: body.reason ?? 'unknown' };
      }
      const remoteStderr = body.stderr === undefined ? undefined : captureFromEnvelope(body.stderr, body.stderr.output);
      if (remoteStderr && remoteStderr.capturedBytes > payloadLimit(maxOutput, logOutput, quota)) throw Error("Stderr exceeds limit");
      const full = captureFromEnvelope(body, body.output);
      if (full.capturedBytes > payloadLimit(maxOutput, logOutput, quota)) throw Error("Output exceeds limit");
      let localStderr = result.stderrCapture;
      if (!localStderr) {
        const collector = new OutputCollector(payloadLimit(maxOutput, logOutput, quota), tail);
        collector.append(Buffer.from(result.stderr, 'utf8'));
        localStderr = collector.snapshot();
      }
      const combinedStderr = combineCaptures([localStderr, ...(remoteStderr ? [remoteStderr] : [])], payloadLimit(maxOutput, logOutput, quota), tail);
      const protectedResult = logOutput ? protectedPayload(body, maxOutput, tail, quota, reservedLog, combinedStderr) : undefined;
      const stdoutCapture = protectedResult?.display ?? full;
      const stderrCapture = displayCapture(combinedStderr, maxOutput, tail);
      return { ...result, stdout: stdoutCapture.text, ...(protectedResult ? { log: protectedResult.log } : {}), stderr: stderrCapture?.text ?? result.stderr, stderrCapture, stdoutCapture,
        outputLimitBytes: maxOutput, truncated: !!stdoutCapture?.truncated || !!stderrCapture?.truncated,
        winrmReason: body.status === 'completed' ? 'completed' : 'remote_script_error',
        invocationStatus: body.status as PsResult["invocationStatus"], ...(records ? { errorRecords: records, errorRecordsTruncated: body.recordsTruncated || body.records.some((r: any) => ["category", "fullyQualifiedErrorId", "exceptionType", "message"].some(k => Buffer.byteLength(r[k], "utf8") > 256)) } : {}) };
    } catch {
      return failure('frame_body_invalid', "Invalid WinRM result body");
    }
}

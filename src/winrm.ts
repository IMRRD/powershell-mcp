import { runPowerShell, type PsResult } from "./powershell.js";
import { randomBytes } from "node:crypto";
import { LIMIT_BOOTSTRAP, captureFromEnvelope, frameLimit, payloadLimit, protectedPayload } from "./envelope-output.js";
import { captureDiagnostic } from "./output-collector.js";
import { logStore } from "./full-logs.js";
import { PARAMETER_BOOTSTRAP, validateParameters, INPUT_LIMIT } from "./typed-input.js";

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
  LIMIT_BOOTSTRAP,
  PARAMETER_BOOTSTRAP,
  "$encoded = $null;",
  "$json = $null;",
  "$invoke = @{",
  "  ComputerName = [string]$payload.computerName;",
  "  ScriptBlock = { param($source, $bound) $items = [System.Collections.ArrayList]::new(); $errors = [System.Collections.ArrayList]::new(); $failed = $false; try { & ([ScriptBlock]::Create($source)) @bound 2>&1 3>&1 4>&1 5>&1 6>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $failed = $true; [void]$errors.Add($_); [void]$items.Add([string]$_.Exception.Message) } else { [void]$items.Add($_) } } } catch { $failed = $true; [void]$errors.Add($_); [void]$items.Add([string]$_.Exception.Message) }; $limited = $errors.Count -gt 8; $records = @($errors | Select-Object -First 8 | ForEach-Object { $e = $_; $fields = @([string]$e.CategoryInfo.Category, [string]$e.FullyQualifiedErrorId, [string]$e.Exception.GetType().FullName, [string]$e.Exception.Message); for ($i=0; $i -lt $fields.Count; $i++) { if ($fields[$i].Length -gt 256) { $fields[$i] = $fields[$i].Substring(0,256); $limited = $true } }; [pscustomobject]@{ category=$fields[0]; fullyQualifiedErrorId=$fields[1]; exceptionType=$fields[2]; message=$fields[3] } }); [pscustomobject]@{ Output = [string]($items.ToArray() | Out-String -Width 240); RemoteError = [bool]$failed; ErrorRecords = $records; ErrorRecordsTruncated = [bool]$limited } };",
  "  ArgumentList = @([string]$payload.command, $(if ($null -eq $payload.parameters) { @{} } else { Convert-Parameter $payload.parameters }));",
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
  "try {",
  "  $results = @(Invoke-Command @invoke -ErrorAction Stop);",
  "  if ($results.Count -ne 1 -or $null -eq $results[0] -or $null -eq $results[0].PSObject.Properties['Output'] -or $null -eq $results[0].PSObject.Properties['RemoteError'] -or $null -eq $results[0].PSObject.Properties['ErrorRecords'] -or $null -eq $results[0].PSObject.Properties['ErrorRecordsTruncated'] -or $results[0].Output -isnot [string] -or $results[0].RemoteError -isnot [bool] -or $results[0].ErrorRecordsTruncated -isnot [bool]) { throw 'Invalid WinRM wrapper result' };",
  "  $result = $results[0];",
  "  $bounded = LimitOutput ([string]$result.Output);",
  "  $body = @{ status = $(if ($result.RemoteError) { 'remote_error' } else { 'completed' }); output = $bounded.output; observedBytes = $bounded.observedBytes; capturedBytes = $bounded.capturedBytes; omittedBytes = $bounded.omittedBytes; truncated = $bounded.truncated; records = @($result.ErrorRecords); recordsTruncated = $result.ErrorRecordsTruncated };",
  "} catch { $body = @{ status = 'transport_error'; output = ([string]$_).Substring(0, [Math]::Min(512, ([string]$_).Length)) } }",
  "[Console]::Out.WriteLine('WINRM-RESULT:' + $payload.frame + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))));",
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
  const maxOutputBytes = frameLimit(payloadLimit(opts.maxOutputBytes ?? 1_048_576, opts.logOutput, opts.logQuotaBytes));
  const remaining = opts.dispatchDeadlineAt === undefined ? opts.timeoutMs ?? 120_000 : Math.ceil(opts.dispatchDeadlineAt - Date.now());
  if (remaining <= 0) {
    if (reservedLog) logStore.delete(reservedLog.finish(false).handle);
    throw new WinRmDispatchDeadlineError("Invocation deadline elapsed before dispatch; remote execution unverified");
  }
  return runPowerShell(WINRM_BOOTSTRAP, {
    stdin,
    timeoutMs: remaining,
    maxOutputBytes,
    stderrLimitBytes: opts.maxOutputBytes ?? 1_048_576,
    stderrTail: opts.tail,
  }).then((result) => {
    const decoded = decodeWinRmResult(result, frame, opts.maxOutputBytes ?? 1_048_576, opts.tail, opts.logOutput, opts.logQuotaBytes, reservedLog);
    if (reservedLog && !decoded.log) logStore.delete(reservedLog.finish(false).handle);
    return decoded;
  }, error => { if (reservedLog) logStore.delete(reservedLog.finish(false).handle); throw error; });
}

/** Validate the local frame before interpreting remote output as data. */
export function decodeWinRmResult(result: PsResult, frame: string, maxOutput = 1_048_576, tail = false, logOutput = false, quota?: number, reservedLog?: ReturnType<typeof logStore.create>): PsResult {
    const failure = (diagnostic?: string): PsResult => {
      const stderrCapture = diagnostic === undefined ? result.stderrCapture : captureDiagnostic(result.stderrCapture, `\n${diagnostic}`, maxOutput, tail);
      return { ...result, stdout: "", stdoutCapture: undefined, stderr: stderrCapture?.text ?? "",
        stderrCapture, truncated: !!stderrCapture?.truncated, outputLimitBytes: maxOutput, invocationStatus: "transport_error" };
    };
    if (result.timedOut || result.spawnError) return failure();
    const match = result.stdout.match(/^WINRM-RESULT:([0-9a-f]{48}):([A-Za-z0-9+/=]+)\s*$/);
    if ((result.truncated && !result.stderrCapture?.truncated) || result.exitCode !== 0 || !match || match[1] !== frame) {
      return failure("Missing or invalid WinRM result envelope");
    }
    try {
      const body = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
      if (!["completed", "remote_error", "transport_error"].includes(body.status) || typeof body.output !== "string") throw Error("Invalid result body");
      if (body.status !== "transport_error" && (typeof body.recordsTruncated !== "boolean" || !Array.isArray(body.records) || body.records.length > 8 || body.records.some((r: any) => !r || ["category", "fullyQualifiedErrorId", "exceptionType", "message"].some(k => typeof r[k] !== "string")) || (body.status === "remote_error" && body.records.length === 0))) throw Error("Invalid remote records");
      const records = body.status === "transport_error" ? undefined : body.records.map((r: any) => Object.fromEntries(["category", "fullyQualifiedErrorId", "exceptionType", "message"].map(k => [k, Buffer.from(r[k], "utf8").subarray(0, 256).toString("utf8")])));
      if (body.status === "transport_error") {
        const stderrCapture = captureDiagnostic(result.stderrCapture, body.output, maxOutput, tail);
        return { ...result, stdout: "", stdoutCapture: undefined, stderr: stderrCapture.text, stderrCapture,
          outputLimitBytes: maxOutput, truncated: stderrCapture.truncated, invocationStatus: "transport_error" };
      }
      const protectedResult = logOutput ? protectedPayload(body, maxOutput, tail, quota, reservedLog) : undefined;
      const stdoutCapture = protectedResult?.display ?? captureFromEnvelope(body, body.output);
      if (!logOutput && stdoutCapture.capturedBytes > maxOutput) throw Error("Output exceeds limit");
      return { ...result, stdout: stdoutCapture.text, ...(protectedResult ? { log: protectedResult.log } : {}), stderr: body.status === "transport_error" ? body.output : result.stderr, stdoutCapture,
        outputLimitBytes: maxOutput, truncated: !!stdoutCapture?.truncated || !!result.stderrCapture?.truncated,
        invocationStatus: body.status as PsResult["invocationStatus"], ...(records ? { errorRecords: records, errorRecordsTruncated: body.recordsTruncated || body.records.some((r: any) => ["category", "fullyQualifiedErrorId", "exceptionType", "message"].some(k => Buffer.byteLength(r[k], "utf8") > 256)) } : {}) };
    } catch {
      return failure("Invalid WinRM result body");
    }
}

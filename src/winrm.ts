import { runPowerShell, type PsResult } from "./powershell.js";
import { randomBytes } from "node:crypto";

export interface WinRmOptions {
  computerName: string;
  command: string;
  username?: string;
  password?: string;
  useSsl?: boolean;
  /** Negotiate (default) | Kerberos | Basic | CredSSP | Default */
  authentication?: "Default" | "Negotiate" | "Kerberos" | "Basic" | "CredSSP";
  timeoutMs?: number;
}

interface WinRmInput {
  computerName: string;
  command: string;
  username?: string;
  password?: string;
  useSsl?: boolean;
  authentication?: WinRmOptions["authentication"];
}

/**
 * Fixed, non-sensitive bootstrap. All caller-controlled values arrive as a
 * base64-encoded JSON payload over stdin and never enter process metadata.
 */
export const WINRM_BOOTSTRAP = [
  "$encoded = [Console]::In.ReadToEnd();",
  "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded));",
  "$payload = $json | ConvertFrom-Json;",
  "$encoded = $null;",
  "$json = $null;",
  "$invoke = @{",
  "  ComputerName = [string]$payload.computerName;",
  "  ScriptBlock = { param($source) $items = [System.Collections.ArrayList]::new(); $failed = $false; try { & ([ScriptBlock]::Create($source)) 2>&1 3>&1 4>&1 5>&1 6>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $failed = $true }; [void]$items.Add($_) } } catch { $failed = $true; [void]$items.Add($_) }; [pscustomobject]@{ Output = [string]($items.ToArray() | Out-String -Width 240); RemoteError = [bool]$failed } };",
  "  ArgumentList = @([string]$payload.command);",
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
  "  if ($results.Count -ne 1 -or $null -eq $results[0] -or $null -eq $results[0].PSObject.Properties['Output'] -or $null -eq $results[0].PSObject.Properties['RemoteError'] -or $results[0].Output -isnot [string] -or $results[0].RemoteError -isnot [bool]) { throw 'Invalid WinRM wrapper result' };",
  "  $result = $results[0];",
  "  $body = @{ status = $(if ($result.RemoteError) { 'remote_error' } else { 'completed' }); output = $result.Output };",
  "} catch { $body = @{ status = 'transport_error'; output = [string]$_ } }",
  "[Console]::Out.WriteLine('WINRM-RESULT:' + $payload.frame + ':' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))));",
].join("\n");

export function buildWinRmInput(opts: WinRmOptions): string {
  const input: WinRmInput = {
    computerName: opts.computerName,
    command: opts.command,
  };

  if (opts.username !== undefined) {
    input.username = opts.username;
    input.password = opts.password ?? "";
  }
  if (opts.useSsl !== undefined) input.useSsl = opts.useSsl;
  if (opts.authentication !== undefined) input.authentication = opts.authentication;

  return Buffer.from(JSON.stringify(input), "utf8").toString("base64");
}

/**
 * Run a command on a remote *Windows* host via PowerShell Remoting (WinRM),
 * using Invoke-Command -ComputerName. Native to Windows Server — no SSH server
 * or agent install required on the target, only WinRM enabled. Output is
 * captured by the local hidden PowerShell host (no console window).
 */
export function runWinRm(opts: WinRmOptions): Promise<PsResult> {
  const frame = randomBytes(24).toString("hex");
  const input = JSON.parse(Buffer.from(buildWinRmInput(opts), "base64").toString("utf8"));
  input.frame = frame;
  return runPowerShell(WINRM_BOOTSTRAP, {
    stdin: Buffer.from(JSON.stringify(input), "utf8").toString("base64"),
    timeoutMs: opts.timeoutMs ?? 120_000,
  }).then((result) => decodeWinRmResult(result, frame));
}

/** Validate the local frame before interpreting remote output as data. */
export function decodeWinRmResult(result: PsResult, frame: string): PsResult {
    if (result.timedOut || result.spawnError) return result;
    const match = result.stdout.match(/^WINRM-RESULT:([0-9a-f]{48}):([A-Za-z0-9+/=]+)\s*$/);
    if (result.truncated || result.exitCode !== 0 || !match || match[1] !== frame) {
      return { ...result, invocationStatus: "transport_error" as const, stderr: `${result.stderr}\nMissing or invalid WinRM result envelope` };
    }
    try {
      const body = JSON.parse(Buffer.from(match[2], "base64").toString("utf8"));
      if (!["completed", "remote_error", "transport_error"].includes(body.status) || typeof body.output !== "string") throw Error("Invalid result body");
      return { ...result, stdout: body.status === "transport_error" ? "" : body.output, stderr: body.status === "transport_error" ? body.output : result.stderr, invocationStatus: body.status as PsResult["invocationStatus"] };
    } catch {
      return { ...result, invocationStatus: "transport_error" as const, stderr: `${result.stderr}\nInvalid WinRM result body` };
    }
}

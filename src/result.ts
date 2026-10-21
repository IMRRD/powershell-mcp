import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PsResult } from "./powershell.js";
import type { SshResult } from "./ssh.js";
import type { SftpResult } from "./sftp.js";
import type { StreamCapture } from "./output-collector.js";

const streamShape = z.object({ observedBytes: z.number().nonnegative(), capturedBytes: z.number().nonnegative(),
  omittedBytes: z.number().nonnegative(), truncated: z.boolean() });
function metrics(c?: StreamCapture) {
  return c && { observedBytes: c.observedBytes, capturedBytes: c.capturedBytes,
    omittedBytes: c.omittedBytes, truncated: c.truncated };
}

/** Version 1 describes observable execution, not application-level success. */
export const resultShape = {
  schemaVersion: z.literal(1),
  executionId: z.string(),
  transport: z.enum(["powershell", "program", "winrm", "ssh", "sftp"]),
  target: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().nonnegative(),
  timedOut: z.boolean(),
  truncation: z.object({ truncated: z.boolean(), limitBytesPerStream: z.number().nullable(),
    stdout: streamShape.optional(), stderr: streamShape.optional() }),
  terminationStatus: z.enum(["completed", "nonzero_exit", "script_error", "remote_error", "timeout", "cancelled", "transport_error", "unknown"]),
  errorRecords: z.array(z.object({ category: z.string(), fullyQualifiedErrorId: z.string(), exceptionType: z.string(), message: z.string() })).optional(),
  errorRecordsTruncated: z.boolean().optional(),
  terminationCertainty: z.enum(["unknown", "root_exited"]),
  log: z.object({ handle: z.string(), complete: z.boolean(), stdoutBytes: z.number(), stderrBytes: z.number(), expiresAt: z.string() }).optional(),
  detail: z.object({ shell: z.string().optional(), version: z.string().optional(), signal: z.string().optional(), error: z.string().optional(), direction: z.enum(["upload", "download"]).optional(), bytes: z.number().optional(), verification: z.enum(["not_started", "sha256_matched", "failed"]).optional(), finalized: z.boolean().optional(), cleanup: z.enum(["not_needed", "removed", "failed", "unknown"]).optional(), sha256: z.string().optional(), localExitCode: z.number().nullable().optional() }),
};
export type ExecutionResult = z.infer<ReturnType<typeof z.object<typeof resultShape>>>;

type Transport = ExecutionResult["transport"];
function base(transport: Transport, target: string, durationMs: number) {
  return { schemaVersion: 1 as const, executionId: randomUUID(), transport, target, durationMs };
}
export function fromProcess(r: PsResult, transport: "powershell" | "program" | "winrm", target: string): ExecutionResult {
  const status = r.timedOut ? "timeout" : r.spawnError || r.protocolError ? "transport_error"
    : transport === "winrm" ? (r.invocationStatus ?? "unknown")
    : r.scriptError ? "script_error" : r.exitCode === null ? "unknown" : r.exitCode === 0 ? "completed" : "nonzero_exit";
  return { ...base(transport, target, r.durationMs), stdout: r.stdout, stderr: r.stderr, ...(r.log ? { log: r.log } : {}),
    ...(r.errorRecords ? { errorRecords: r.errorRecords, errorRecordsTruncated: r.errorRecordsTruncated } : {}),
    // WinRM reports a local PowerShell host exit, not a remote command exit.
    exitCode: transport === "winrm" ? null : r.exitCode, timedOut: r.timedOut,
    truncation: { truncated: r.truncated, limitBytesPerStream: r.outputLimitBytes ?? 1_048_576,
      ...(r.stdoutCapture ? { stdout: metrics(r.stdoutCapture) } : {}),
      ...(r.stderrCapture ? { stderr: metrics(r.stderrCapture) } : {}) },
    terminationStatus: status, terminationCertainty: r.timedOut ? "unknown" : r.exitCode !== null ? "root_exited" : "unknown",
    detail: transport === "winrm" ? { shell: r.shell, localExitCode: r.exitCode, ...(r.spawnError ? { error: r.spawnError } : {}) } : { shell: r.shell, ...(r.spawnError ? { error: r.spawnError } : {}) },
  };
}
export function fromSsh(r: SshResult, target: string, limitBytesPerStream: number): ExecutionResult {
  const status = r.timedOut ? "timeout" : r.error ? "transport_error" : r.signal ? "unknown"
    : r.exitCode === null ? "unknown" : r.exitCode === 0 ? "completed" : "nonzero_exit";
  return { ...base("ssh", target, r.durationMs), stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, ...(r.log ? { log: r.log } : {}),
    timedOut: r.timedOut, truncation: { truncated: r.truncated, limitBytesPerStream,
      ...(r.stdoutCapture ? { stdout: metrics(r.stdoutCapture) } : {}),
      ...(r.stderrCapture ? { stderr: metrics(r.stderrCapture) } : {}) }, terminationStatus: status, terminationCertainty: "unknown",
    detail: { ...(r.signal ? { signal: r.signal } : {}), ...(r.error ? { error: r.error } : {}) },
  };
}
export function fromSftp(r: SftpResult, target: string, direction: "upload" | "download"): ExecutionResult {
  const status = r.timedOut ? "timeout" : r.ok ? "completed" : "transport_error";
  return { ...base("sftp", target, r.durationMs), stdout: "", stderr: r.error ?? "", exitCode: null,
    timedOut: r.timedOut ?? false, truncation: { truncated: false, limitBytesPerStream: null }, terminationStatus: status, terminationCertainty: "unknown",
    detail: { direction, ...(r.bytes !== undefined ? { bytes: r.bytes } : {}), ...(r.verification ? { verification: r.verification } : {}), ...(r.finalized !== undefined ? { finalized: r.finalized } : {}), ...(r.cleanup ? { cleanup: r.cleanup } : {}), ...(r.sha256 ? { sha256: r.sha256 } : {}), ...(r.error ? { error: r.error } : {}) },
  };
}
export function toolResult(data: ExecutionResult, text: string) {
  return { structuredContent: data, content: [{ type: "text" as const,
    text: `${text}\ntermination_status: ${data.terminationStatus}  exit_code: ${data.exitCode ?? "null"}` }],
    isError: data.terminationStatus !== "completed" };
}

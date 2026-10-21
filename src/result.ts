import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PsResult } from "./powershell.js";
import type { SshResult } from "./ssh.js";
import type { SftpResult } from "./sftp.js";

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
  truncation: z.object({ truncated: z.boolean(), limitBytesPerStream: z.number().nullable() }),
  terminationStatus: z.enum(["completed", "nonzero_exit", "remote_error", "timeout", "cancelled", "transport_error", "unknown"]),
  terminationCertainty: z.enum(["unknown", "root_exited"]),
  detail: z.object({ shell: z.string().optional(), signal: z.string().optional(), error: z.string().optional(), direction: z.enum(["upload", "download"]).optional(), bytes: z.number().optional(), localExitCode: z.number().nullable().optional() }),
};
export type ExecutionResult = z.infer<ReturnType<typeof z.object<typeof resultShape>>>;

type Transport = ExecutionResult["transport"];
function base(transport: Transport, target: string, durationMs: number) {
  return { schemaVersion: 1 as const, executionId: randomUUID(), transport, target, durationMs };
}
export function fromProcess(r: PsResult, transport: "powershell" | "program" | "winrm", target: string): ExecutionResult {
  const status = r.timedOut ? "timeout" : r.spawnError ? "transport_error"
    : transport === "winrm" ? (r.invocationStatus ?? "unknown")
    : r.exitCode === null ? "unknown" : r.exitCode === 0 ? "completed" : "nonzero_exit";
  return { ...base(transport, target, r.durationMs), stdout: r.stdout, stderr: r.stderr,
    // WinRM reports a local PowerShell host exit, not a remote command exit.
    exitCode: transport === "winrm" ? null : r.exitCode, timedOut: r.timedOut,
    truncation: { truncated: r.truncated, limitBytesPerStream: 1_048_576 },
    terminationStatus: status, terminationCertainty: r.timedOut ? "unknown" : r.exitCode !== null ? "root_exited" : "unknown",
    detail: transport === "winrm" ? { shell: r.shell, localExitCode: r.exitCode, ...(r.spawnError ? { error: r.spawnError } : {}) } : { shell: r.shell, ...(r.spawnError ? { error: r.spawnError } : {}) },
  };
}
export function fromSsh(r: SshResult, target: string, limitBytesPerStream: number): ExecutionResult {
  const status = r.timedOut ? "timeout" : r.error ? "transport_error" : r.signal ? "unknown"
    : r.exitCode === null ? "unknown" : r.exitCode === 0 ? "completed" : "nonzero_exit";
  return { ...base("ssh", target, r.durationMs), stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode,
    timedOut: r.timedOut, truncation: { truncated: r.truncated, limitBytesPerStream }, terminationStatus: status, terminationCertainty: "unknown",
    detail: { ...(r.signal ? { signal: r.signal } : {}), ...(r.error ? { error: r.error } : {}) },
  };
}
export function fromSftp(r: SftpResult, target: string, direction: "upload" | "download"): ExecutionResult {
  const status = r.timedOut ? "timeout" : r.ok ? "completed" : "transport_error";
  return { ...base("sftp", target, r.durationMs), stdout: "", stderr: r.error ?? "", exitCode: null,
    timedOut: r.timedOut ?? false, truncation: { truncated: false, limitBytesPerStream: null }, terminationStatus: status, terminationCertainty: "unknown",
    detail: { direction, ...(r.bytes !== undefined ? { bytes: r.bytes } : {}), ...(r.error ? { error: r.error } : {}) },
  };
}
export function toolResult(data: ExecutionResult, text: string) {
  return { structuredContent: data, content: [{ type: "text" as const,
    text: `${text}\ntermination_status: ${data.terminationStatus}  exit_code: ${data.exitCode ?? "null"}` }],
    isError: data.terminationStatus !== "completed" };
}

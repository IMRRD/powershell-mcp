import type { PsResult } from "./powershell.js";

/** Render a PsResult as readable text for the model. */
export function formatResult(r: PsResult): string {
  const parts: string[] = [];
  parts.push(
    `exit_code: ${r.exitCode ?? "null"}${r.timedOut ? " (TIMED OUT)" : ""}  shell: ${r.shell}  duration_ms: ${r.durationMs}`,
  );
  if (r.stdout) parts.push("--- stdout ---\n" + r.stdout);
  if (r.stderr) parts.push("--- stderr ---\n" + r.stderr);
  if (r.truncated) parts.push("[output truncated]");
  if (!r.stdout && !r.stderr) parts.push("(no output)");
  return parts.join("\n");
}

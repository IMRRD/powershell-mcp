import { spawn } from "node:child_process";
import os from "node:os";

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
  /** Cap captured stdout+stderr (bytes each, default 1 MiB). */
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

/**
 * Pick the PowerShell executable. Prefers an explicit override, then `pwsh`
 * (PowerShell 7+, cross-platform), then Windows `powershell.exe`.
 */
export function resolvePowerShellExe(override?: string): string {
  if (override && override.trim()) return override.trim();
  if (process.env.PWSH_MCP_EXE && process.env.PWSH_MCP_EXE.trim()) {
    return process.env.PWSH_MCP_EXE.trim();
  }
  // pwsh is the modern, cross-platform shell; fall back to Windows PowerShell.
  return os.platform() === "win32" ? "powershell.exe" : "pwsh";
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
  const exe = resolvePowerShellExe(opts.exe);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<PsResult>((resolve) => {
    let child;
    try {
      child = spawn(exe, buildArgs(script), {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        windowsHide: true, // <-- no popup window, ever
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: `Failed to spawn ${exe}: ${(err as Error).message}`,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        shell: exe,
        truncated: false,
      });
      return;
    }

    let out = "";
    let errStr = "";
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;

    const append = (buf: Buffer, which: "out" | "err") => {
      if (which === "out") {
        if (outBytes >= maxOutput) { truncated = true; return; }
        outBytes += buf.length;
        out += buf.toString("utf8");
      } else {
        if (errBytes >= maxOutput) { truncated = true; return; }
        errBytes += buf.length;
        errStr += buf.toString("utf8");
      }
    };

    child.stdout?.on("data", (b: Buffer) => append(b, "out"));
    child.stderr?.on("data", (b: Buffer) => append(b, "err"));

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
      clearTimeout(timer);
      resolve({
        stdout: out,
        stderr: errStr + `\n[spawn error] ${(err as Error).message}`,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - started,
        shell: exe,
        truncated,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: out.trimEnd(),
        stderr: errStr.trimEnd(),
        exitCode: code,
        timedOut,
        durationMs: Date.now() - started,
        shell: exe,
        truncated,
      });
    });
  });
}

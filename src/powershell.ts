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
  /** Optional data written to the child only after it has spawned. */
  stdin?: string;
  /** Cap captured stdout+stderr (bytes each, default 1 MiB). */
  maxOutputBytes?: number;
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
  const candidates = resolvePowerShellCandidates(opts.exe);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  return new Promise<PsResult>((resolve) => {
    let resolved = false;

    const failedResult = (exe: string, err: unknown): PsResult => ({
      stdout: "",
      stderr: `Failed to spawn ${exe}: ${(err as Error).message}`,
      exitCode: null,
      timedOut: false,
      durationMs: Date.now() - started,
      shell: exe,
      truncated: false,
    });

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

      let out = "";
      let errStr = "";
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;
      let attemptFinished = false;

      if (opts.stdin !== undefined) {
        child.stdin?.on("error", () => { /* child error/close owns the result */ });
        child.once("spawn", () => child.stdin?.end(opts.stdin));
      }

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
        if (attemptFinished || resolved) return;
        attemptFinished = true;
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT" && candidateIndex + 1 < candidates.length) {
          attempt(candidateIndex + 1);
          return;
        }
        resolved = true;
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
        if (attemptFinished || resolved) return;
        attemptFinished = true;
        clearTimeout(timer);
        resolved = true;
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
    };

    attempt(0);
  });
}

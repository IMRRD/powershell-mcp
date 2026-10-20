import { spawn } from "node:child_process";
import os from "node:os";
import { OutputCollector, captureDiagnostic } from "./output-collector.js";
import type { PsResult, RunOptions } from "./powershell.js";
import { logStore } from "./full-logs.js";
import { INPUT_LIMIT } from "./typed-input.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 1024 * 1024;

/**
 * Run a native executable DIRECTLY (no shell wrapper) in a hidden process.
 *
 * A native console program launched from inside a hidden (windowsHide) PowerShell
 * does NOT deliver its stdout to the captured pipe -- only PowerShell's own
 * pipeline streams are captured. A program spawned as a DIRECT child, however,
 * inherits real stdout/stderr pipes, so its output is captured cleanly. Use this
 * for gh / git / docker / node / python / etc. Returns separated stdout, stderr
 * and the exact exit code, with no shell quoting and no escape-sequence noise.
 */
export function runProgram(program: string, args: string[] = [], opts: RunOptions = {}): Promise<PsResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const started = Date.now();

  if (opts.stdin !== undefined && Buffer.byteLength(opts.stdin, "utf8") > INPUT_LIMIT) {
    return Promise.resolve({ stdout: "", stderr: "input limit exceeded", spawnError: "input limit exceeded", exitCode: null, timedOut: false, durationMs: 0, shell: program, truncated: false, outputLimitBytes: maxOutput });
  }

  return new Promise<PsResult>((resolve) => {
    const log = opts.logOutput ? logStore.create(opts.logQuotaBytes) : undefined;
    let child;
    try {
      child = spawn(program, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        windowsHide: true,
        stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (err) {
      if (log) logStore.delete(log.finish().handle);
      const stderrCapture = captureDiagnostic(undefined, `Failed to spawn ${program}: ${(err as Error).message}`, maxOutput, opts.tail);
      resolve({
        stdout: "",
        stderr: stderrCapture.text,
        stderrCapture,
        spawnError: (err as Error).message,
        exitCode: null,
        timedOut: false,
        durationMs: Date.now() - started,
        shell: program,
        truncated: stderrCapture.truncated,
        outputLimitBytes: maxOutput,
      });
      return;
    }

    const out = new OutputCollector(maxOutput, opts.tail);
    const errOut = new OutputCollector(maxOutput, opts.tail);
    let timedOut = false;
    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => { /* early child exit owns result */ });
      child.once("spawn", () => child.stdin?.end(opts.stdin));
    }

    child.stdout?.on("data", (b: Buffer) => { out.append(b); log?.append("stdout", b); });
    child.stderr?.on("data", (b: Buffer) => { errOut.append(b); log?.append("stderr", b); });
    const captures = () => {
      const stdoutCapture = out.snapshot(), stderrCapture = errOut.snapshot();
      return { stdout: stdoutCapture.text, stderr: stderrCapture.text, stdoutCapture, stderrCapture,
        outputLimitBytes: maxOutput, truncated: stdoutCapture.truncated || stderrCapture.truncated };
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (os.platform() === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      } catch { /* ignore */ }
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const stderrCapture = captureDiagnostic(errOut.snapshot(), `\n[spawn error] ${(err as Error).message}`, maxOutput, opts.tail);
      const stdoutCapture = out.snapshot();
      resolve({
        stdout: stdoutCapture.text, stderr: stderrCapture.text, stdoutCapture, stderrCapture,
        ...(log ? { log: log.finish(false) } : {}),
        outputLimitBytes: maxOutput, truncated: stdoutCapture.truncated || stderrCapture.truncated,
        spawnError: (err as Error).message,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - started,
        shell: program,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ...captures(),
        exitCode: code,
        ...(log ? { log: log.finish(!timedOut) } : {}),
        timedOut,
        durationMs: Date.now() - started,
        shell: program,
      });
    });
  });
}

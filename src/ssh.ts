import { Client } from "ssh2";
import { readFileSync } from "node:fs";

export interface SshOptions {
  host: string;
  username: string;
  command: string;
  port?: number;
  privateKeyPath?: string;
  passphrase?: string;
  password?: string;
  timeoutMs?: number;
  /** Cap captured stdout/stderr per stream (bytes, default 1 MiB). */
  maxOutputBytes?: number;
  /** When true, keep the LAST maxOutputBytes instead of the first (tail). */
  tail?: boolean;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
  durationMs: number;
}

const DEFAULT_OUTPUT_CAP = 1_048_576; // 1 MiB per stream

/**
 * Run a single command on a remote host over SSH, fully in-process (no ssh.exe,
 * no WSL). Works from a headless/windowless process. Returns structured output.
 */
export function runSsh(opts: SshOptions): Promise<SshResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const cap = opts.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;
  const started = Date.now();
  return new Promise<SshResult>((resolve) => {
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const finish = (r: Partial<SshResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
      resolve({
        stdout, stderr, exitCode: null, timedOut: false, truncated,
        durationMs: Date.now() - started, ...r,
      });
    };

    const timer = setTimeout(() => finish({ timedOut: true, error: `timed out after ${timeoutMs}ms` }), timeoutMs);

    const append = (cur: string, chunk: Buffer) => {
      const next = cur + chunk.toString("utf8");
      if (next.length <= cap) return next;
      truncated = true;
      // tail: keep the most recent bytes; otherwise keep the first cap bytes.
      return opts.tail ? next.slice(next.length - cap) : next.slice(0, cap);
    };

    conn.on("ready", () => {
      conn.exec(opts.command, (err, stream) => {
        if (err) { finish({ error: `exec failed: ${err.message}` }); return; }
        stream
          .on("close", (code: number | null, signal?: string) =>
            finish({ exitCode: code ?? null, signal }))
          .on("data", (d: Buffer) => { stdout = append(stdout, d); })
          .stderr.on("data", (d: Buffer) => { stderr = append(stderr, d); });
      });
    });

    conn.on("error", (e: Error & { level?: string }) =>
      finish({ error: `connection error${e.level ? ` (${e.level})` : ""}: ${e.message}` }));

    const cfg: Record<string, unknown> = {
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.username,
      readyTimeout: Math.min(timeoutMs, 120_000),
      keepaliveInterval: 0,
    };

    if (opts.privateKeyPath) {
      try { cfg.privateKey = readFileSync(opts.privateKeyPath); }
      catch (e) { finish({ error: `could not read key '${opts.privateKeyPath}': ${(e as Error).message}` }); return; }
      if (opts.passphrase) cfg.passphrase = opts.passphrase;
    }
    if (opts.password) cfg.password = opts.password;

    if (!cfg.privateKey && !cfg.password) {
      finish({ error: "no auth provided: supply privateKeyPath or password" });
      return;
    }

    try { conn.connect(cfg); }
    catch (e) { finish({ error: `connect threw: ${(e as Error).message}` }); }
  });
}

export function formatSsh(target: string, r: SshResult): string {
  const head = `$ ssh ${target}  (exit=${r.exitCode ?? "n/a"}${r.timedOut ? ", TIMED OUT" : ""}${r.truncated ? ", TRUNCATED" : ""}, ${r.durationMs}ms)`;
  const parts = [head];
  if (r.error) parts.push(`[error] ${r.error}`);
  if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
  if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  return parts.join("\n");
}

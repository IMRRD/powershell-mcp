import { Client } from "ssh2";
import type { ClientChannel } from "ssh2";
import { configuredProvider, resolveCredential, sanitizeCredentialResult, type CredentialProvider } from "./credentials.js";
import { hostTrust, type HostTrustOptions } from "./host-trust.js";
import { OutputCollector, type StreamCapture } from "./output-collector.js";
import { readFileSync } from "node:fs";
import { logStore } from "./full-logs.js";

export interface SshHop extends HostTrustOptions {
  username: string; credentialRef?: string; privateKeyPath?: string; passphrase?: string; password?: string;
}

export interface SshOptions extends HostTrustOptions {
  jumps?: SshHop[];
  /** Internal test override; MCP always uses the configured protected provider. */
  credentialProvider?: CredentialProvider;
  host: string;
  username: string;
  command: string;
  port?: number;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  timeoutMs?: number;
  /** Absolute process-local wall-clock deadline including caller credential lookup. */
  deadlineAt?: number;
  /** Cap captured stdout/stderr per stream (bytes, default 1 MiB). */
  maxOutputBytes?: number;
  /** When true, keep the LAST maxOutputBytes instead of the first (tail). */
  tail?: boolean;
  logOutput?: boolean;
  logQuotaBytes?: number;
}

export interface SshResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  truncated: boolean;
  stdoutCapture?: StreamCapture;
  stderrCapture?: StreamCapture;
  outputLimitBytes?: number;
  error?: string;
  durationMs: number;
  log?: { handle: string; complete: boolean; stdoutBytes: number; stderrBytes: number; expiresAt: string };
}

const DEFAULT_OUTPUT_CAP = 1_048_576; // 1 MiB per stream

/**
 * Run a single command on a remote host over SSH, fully in-process (no ssh.exe,
 * no WSL). Works from a headless/windowless process. Returns structured output.
 */
export function runSsh(opts: SshOptions): Promise<SshResult> {
  const timeoutMs = opts.deadlineAt === undefined ? opts.timeoutMs ?? 60_000 : Math.max(0, opts.deadlineAt - Date.now());
  const cap = opts.maxOutputBytes ?? DEFAULT_OUTPUT_CAP;
  const started = Date.now();
  const deadlineAt = opts.deadlineAt ?? started + timeoutMs;
  return new Promise<SshResult>((resolve) => {
    const conn = new Client();
    const owners: Client[] = [];
    const channels: ClientChannel[] = [];
    const hopSecrets: Array<{ password?: string; privateKey?: string; passphrase?: string }> = [];
    const out = new OutputCollector(cap, opts.tail);
    const errOut = new OutputCollector(cap, opts.tail);
    const log = opts.logOutput ? logStore.create(opts.logQuotaBytes) : undefined;
    let settled = false;
    let stdoutEnded = false, stderrEnded = false;

    const finish = (r: Partial<SshResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const channel of channels.reverse()) { try { channel.destroy(); } catch { /* ignore */ } }
      for (const client of [conn, ...owners.reverse()]) { try { client.end(); client.destroy(); } catch { /* ignore */ } }
      const result: SshResult = {
        stdout: out.snapshot().text, stderr: errOut.snapshot().text,
        stdoutCapture: out.snapshot(), stderrCapture: errOut.snapshot(), outputLimitBytes: cap,
        exitCode: null, timedOut: false, truncated: out.snapshot().truncated || errOut.snapshot().truncated,
        durationMs: Date.now() - started, ...r,
        ...(log ? { log: log.finish(!r.error && !r.timedOut && stdoutEnded && stderrEnded) } : {}),
      };
      resolve(hopSecrets.length ? hopSecrets.reduce((safe, auth) => sanitizeCredentialResult(safe, auth), result) : result);
    };

    const remaining = () => Math.max(0, deadlineAt - Date.now());
    const mayDispatch = () => {
      if (settled) return false;
      if (remaining() > 0) return true;
      finish({ timedOut: true, error: `timed out after ${timeoutMs}ms` });
      return false;
    };
    const timer = setTimeout(() => finish({ timedOut: true, error: `timed out after ${timeoutMs}ms` }), timeoutMs);
    if (timeoutMs <= 0) { finish({ timedOut: true, error: "invocation deadline elapsed before dispatch" }); return; }

    conn.on("ready", () => {
      if (!mayDispatch()) return;
      conn.exec(opts.command, (err, stream) => {
        if (settled) { stream?.destroy(); return; }
        if (err) { finish({ error: `exec failed: ${err.message}` }); return; }
        stream
          .on("close", (code: number | null, signal?: string) =>
            finish({ exitCode: code ?? null, signal }))
          .on("end", () => { stdoutEnded = true; })
          .on("data", (d: Buffer) => { if (!settled) { out.append(d); log?.append("stdout", d); } })
          .stderr.on("end", () => { stderrEnded = true; })
          .on("data", (d: Buffer) => { if (!settled) { errOut.append(d); log?.append("stderr", d); } });
      });
    });

    let trust: ReturnType<typeof hostTrust> | undefined;
    let rejectedHost = false;
    conn.on("error", (e: Error & { level?: string }) =>
      finish({ error: rejectedHost && trust ? trust.failure() : `connection error${e.level ? ` (${e.level})` : ""}: ${e.message}` }));

    try { trust = hostTrust(opts); }
    catch (e) { finish({ error: (e as Error).message }); return; }

    const cfg: Record<string, unknown> = {
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.username,
      readyTimeout: Math.min(timeoutMs, 120_000),
      keepaliveInterval: 0,
      hostVerifier: (key: Buffer) => { const accepted = trust.hostVerifier(key); if (!accepted) rejectedHost = true; return accepted; },
    };

    if (opts.privateKey) cfg.privateKey = opts.privateKey;
    if (opts.privateKeyPath) {
      try { cfg.privateKey = readFileSync(opts.privateKeyPath); }
      catch (e) { finish({ error: `could not read key '${opts.privateKeyPath}': ${(e as Error).message}` }); return; }
    }
    if (cfg.privateKey && opts.passphrase !== undefined) cfg.passphrase = opts.passphrase;
    if (opts.password) cfg.password = opts.password;

    if (!cfg.privateKey && !cfg.password) {
      finish({ error: "no auth provided: supply privateKeyPath or password" });
      return;
    }

    // A single clock covers credential lookup, every handshake and forwarded channel.
    const jumps = opts.jumps ?? [];
    if (!Array.isArray(jumps) || jumps.length > 4) { finish({ error: "invalid jump route" }); return; }
    void (async () => {
      let socket: ClientChannel | undefined;
      for (let i = 0; i < jumps.length; i++) {
        if (settled) return;
        const hop = jumps[i];
        if (!hop || !hop.host || !hop.username || !Number.isInteger(hop.port ?? 22) || (hop.port ?? 22) < 1 || (hop.port ?? 22) > 65535) throw Error('invalid jump route');
        const policy = hostTrust({ ...hop, knownHostsPath: opts.knownHostsPath });
        const auth = await resolveCredential({ credentialRef: hop.credentialRef, transport: 'ssh', host: hop.host, port: hop.port ?? 22, principal: hop.username, password: hop.password, passphrase: hop.passphrase, privateKeyPath: hop.privateKeyPath }, opts.credentialProvider ?? configuredProvider());
        hopSecrets.push({ ...auth, password: auth.password ?? hop.password, passphrase: auth.passphrase ?? hop.passphrase });
        if (settled) return;
        const client = new Client(); owners.push(client);
        let rejected = false;
        const hopCfg: Record<string, unknown> = { host: hop.host, port: hop.port ?? 22, username: hop.username, sock: socket,
          readyTimeout: Math.max(1, remaining()), keepaliveInterval: 0,
          hostVerifier: (key: Buffer) => { const ok = policy.hostVerifier(key); if (!ok) rejected = true; return ok; } };
        if (auth.privateKey) hopCfg.privateKey = auth.privateKey;
        else if (hop.privateKeyPath) hopCfg.privateKey = readFileSync(hop.privateKeyPath);
        if (auth.passphrase ?? hop.passphrase) hopCfg.passphrase = auth.passphrase ?? hop.passphrase;
        if (auth.password ?? hop.password) hopCfg.password = auth.password ?? hop.password;
        if (!hopCfg.privateKey && !hopCfg.password) throw Error('no auth provided');
        await new Promise<void>((done, fail) => {
          client.once('ready', done);
          client.once('error', (e: Error) => fail(Error(rejected ? policy.failure() : 'jump connection failed')));
          client.once('close', () => fail(Error('jump connection closed')));
          if (!mayDispatch()) return;
          hopCfg.readyTimeout = Math.max(1, remaining());
          try { client.connect(hopCfg); } catch { fail(Error('jump connection failed')); }
        });
        if (!mayDispatch()) return;
        const next = jumps[i + 1] ?? opts;
        socket = await new Promise<ClientChannel>((done, fail) => client.forwardOut('127.0.0.1', 0, next.host, next.port ?? 22,
          (error, channel) => { if (!mayDispatch()) { channel?.destroy(); return; } error ? fail(Error('jump forwarding failed')) : done(channel); }));
        channels.push(socket);
      }
      if (settled) return;
      if (socket) cfg.sock = socket;
      cfg.readyTimeout = Math.max(1, remaining());
      if (!mayDispatch()) return;
      conn.connect(cfg);
    })().catch(e => finish({ error: e instanceof Error && /^(invalid jump route|invalid host|host trust|host key|Credential |Mixed credential|no auth)/.test(e.message) ? e.message : 'jump route failed' }));

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

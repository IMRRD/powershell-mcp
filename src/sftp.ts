import { Client } from "ssh2";
import { hostTrust, type HostTrustOptions } from "./host-trust.js";
import { readFileSync, statSync } from "node:fs";

export interface SftpOptions extends HostTrustOptions {
  host: string;
  username: string;
  localPath: string;
  remotePath: string;
  direction: "upload" | "download";
  port?: number;
  privateKeyPath?: string;
  privateKey?: string;
  passphrase?: string;
  password?: string;
  timeoutMs?: number;
}

export interface SftpResult {
  ok: boolean;
  timedOut?: boolean;
  bytes?: number;
  error?: string;
  durationMs: number;
}

/**
 * Transfer a file to/from a remote host over SFTP, fully in-process (ssh2, no
 * scp.exe, no WSL — works headless). Replaces the base64-pipe workaround.
 */
export function runSftp(o: SftpOptions): Promise<SftpResult> {
  const timeoutMs = o.timeoutMs ?? 120_000;
  const started = Date.now();
  return new Promise<SftpResult>((resolve) => {
    const conn = new Client();
    let settled = false;
    const finish = (r: Partial<SftpResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
      resolve({ ok: false, durationMs: Date.now() - started, ...r });
    };
    const timer = setTimeout(() => finish({ timedOut: true, error: `timed out after ${timeoutMs}ms` }), timeoutMs);

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (err) { finish({ error: `sftp init failed: ${err.message}` }); return; }
        if (o.direction === "upload") {
          sftp.fastPut(o.localPath, o.remotePath, (e) => {
            if (e) { finish({ error: `upload failed: ${e.message}` }); return; }
            let bytes: number | undefined;
            try { bytes = statSync(o.localPath).size; } catch { /* ignore */ }
            finish({ ok: true, bytes });
          });
        } else {
          sftp.fastGet(o.remotePath, o.localPath, (e) => {
            if (e) { finish({ error: `download failed: ${e.message}` }); return; }
            let bytes: number | undefined;
            try { bytes = statSync(o.localPath).size; } catch { /* ignore */ }
            finish({ ok: true, bytes });
          });
        }
      });
    });

    let trust: ReturnType<typeof hostTrust> | undefined;
    let rejectedHost = false;
    conn.on("error", (e: Error & { level?: string }) =>
      finish({ error: rejectedHost && trust ? trust.failure() : `connection error${e.level ? ` (${e.level})` : ""}: ${e.message}` }));

    try { trust = hostTrust(o); }
    catch (e) { finish({ error: (e as Error).message }); return; }

    const cfg: Record<string, unknown> = {
      host: o.host,
      port: o.port ?? 22,
      username: o.username,
      readyTimeout: Math.min(timeoutMs, 120_000),
      hostVerifier: (key: Buffer) => { const accepted = trust.hostVerifier(key); if (!accepted) rejectedHost = true; return accepted; },
    };
    if (o.privateKey) cfg.privateKey = o.privateKey;
    if (o.privateKeyPath) {
      try { cfg.privateKey = readFileSync(o.privateKeyPath); }
      catch (e) { finish({ error: `could not read key '${o.privateKeyPath}': ${(e as Error).message}` }); return; }
    }
    if (cfg.privateKey && o.passphrase !== undefined) cfg.passphrase = o.passphrase;
    if (o.password) cfg.password = o.password;
    if (!cfg.privateKey && !cfg.password) {
      finish({ error: "no auth provided: supply privateKeyPath or password" });
      return;
    }
    try { conn.connect(cfg); }
    catch (e) { finish({ error: `connect threw: ${(e as Error).message}` }); }
  });
}

export function formatSftp(o: SftpOptions, r: SftpResult): string {
  const arrow = o.direction === "upload" ? "→" : "←";
  const head = `sftp ${o.direction}: ${o.localPath} ${arrow} ${o.username}@${o.host}:${o.remotePath}`;
  if (r.ok) return `${head}\nOK (${r.bytes ?? "?"} bytes, ${r.durationMs}ms)`;
  return `${head}\nFAILED: ${r.error} (${r.durationMs}ms)`;
}

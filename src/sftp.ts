import { Client } from "ssh2";
import { hostTrust, type HostTrustOptions } from "./host-trust.js";
import { readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, linkSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, basename, join, posix } from "node:path";
import type { SFTPWrapper } from "ssh2";

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
  staged?: boolean;
}

export interface SftpResult {
  ok: boolean;
  timedOut?: boolean;
  bytes?: number;
  error?: string;
  durationMs: number;
  verification?: "not_started" | "sha256_matched" | "failed";
  finalized?: boolean;
  cleanup?: "not_needed" | "removed" | "failed" | "unknown";
  sha256?: string;
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
    const fence = { cancelled: false, finalizationSent: false, finalized: false, creationPending: false, owned: false, verification: 'not_started' as SftpResult['verification'] };
    const finish = (r: Partial<SftpResult>) => {
      if (settled) return;
      settled = true;
      fence.cancelled = true;
      clearTimeout(timer);
      try { conn.end(); } catch { /* ignore */ }
      const observed = o.staged ? {
        verification: fence.verification,
        finalized: fence.finalized ? true : fence.finalizationSent ? undefined : false,
        cleanup: fence.creationPending || fence.owned ? 'unknown' as const : 'not_needed' as const,
      } : {};
      resolve({ ok: false, durationMs: Date.now() - started, ...observed, ...r,
        ...(o.staged && (fence.creationPending || fence.owned) && r.cleanup === 'not_needed' ? { cleanup: 'unknown' as const } : {}) });
    };
    const timer = setTimeout(() => finish({ timedOut: true, error: `timed out after ${timeoutMs}ms` }), timeoutMs);

    conn.on("ready", () => {
      conn.sftp((err, sftp) => {
        if (settled) return;
        if (err) { finish({ error: `sftp init failed: ${err.message}` }); return; }
        if (o.staged) {
          stagedTransfer(o, sftp, fence).then(finish, e => finish({ error: `staged transfer failed: ${(e as Error).message}` }));
          return;
        }
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

function invoke(fn: (cb: (err?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => fn(err => err ? reject(err) : resolve()));
}
async function digest(stream: NodeJS.ReadableStream): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function remoteDigest(sftp: SFTPWrapper, path: string): Promise<string> {
  // Open first so a failed OPEN cannot leave ssh2's destroy waiting for an
  // 'open' event that will never arrive. Own CLOSE explicitly, including after
  // EOF: ssh2's default autoClose runs after the readable side has completed.
  const handle = await new Promise<Buffer>((resolve, reject) =>
    sftp.open(path, 'r', (error, value) => error ? reject(error) : resolve(value)));
  return new Promise<string>((resolve, reject) => {
    const stream = sftp.createReadStream(path, { handle, autoClose: false });
    const hash = createHash('sha256');
    let closing = false;
    let failure: Error | undefined;
    const complete = (error?: Error) => {
      failure ??= error;
      if (closing) return;
      closing = true;
      stream.pause();
      stream.close(closeError => {
        failure ??= closeError ?? undefined;
        if (failure) reject(failure);
        else resolve(hash.digest('hex'));
      });
    };
    // Keep this owner attached through destroy's deferred error emission. A
    // CLOSE failure is also delivered to its callback and rejects the digest.
    stream.on('error', complete);
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.once('end', () => complete());
  });
}
async function stagedTransfer(o: SftpOptions, sftp: SFTPWrapper, fence: { cancelled: boolean; finalizationSent: boolean; finalized: boolean; creationPending: boolean; owned: boolean; verification: SftpResult['verification'] }): Promise<Partial<SftpResult>> {
  const dest = o.direction === 'upload' ? o.remotePath : o.localPath;
  const temp = join(dirname(dest), `.${basename(dest)}.mcp-${randomUUID()}.part`).replaceAll('\\', o.direction === 'upload' ? '/' : '\\');
  let owned = false;
  let finalized = false;
  let verification: SftpResult['verification'] = 'not_started';
  let bytes: number | undefined;
  try {
    if (o.direction === 'upload') {
      // ssh2 checks the advertised version itself before sending this extended request.
      // Never fall back to rename: SFTP v3 rename may overwrite the destination.
      fence.creationPending = true;
      const handle = await new Promise<Buffer>((resolve, reject) => sftp.open(temp, 'wx', 0o600, (e, h) => e ? reject(e) : resolve(h)));
      fence.creationPending = false;
      owned = fence.owned = true;
      await invoke(cb => sftp.close(handle, cb));
      if (fence.cancelled) throw new Error('staged transfer cancelled');
      await invoke(cb => sftp.fastPut(o.localPath, temp, cb));
      bytes = await new Promise<number>((resolve, reject) => sftp.stat(temp, (e, attrs) => e ? reject(e) : resolve(attrs.size)));
      verification = fence.verification = 'failed';
      const sourceHash = await digest(createReadStream(o.localPath));
      if (sourceHash !== await remoteDigest(sftp, temp)) throw new Error('SHA-256 readback mismatch');
      verification = fence.verification = 'sha256_matched';
      if (fence.cancelled) throw new Error('staged transfer cancelled');
      fence.finalizationSent = true;
      await invoke(cb => sftp.ext_openssh_hardlink(temp, o.remotePath, cb));
      finalized = fence.finalized = true;
      await invoke(cb => sftp.unlink(temp, cb)); owned = fence.owned = false;
      return { ok: true, bytes, sha256: sourceHash, verification, finalized: true, cleanup: 'removed' };
    }
    if (existsSync(o.localPath)) throw new Error('destination exists; staged mode refuses overwrite');
    const handle = openSync(temp, 'wx', 0o600);
    owned = fence.owned = true; closeSync(handle);
    await invoke(cb => sftp.fastGet(o.remotePath, temp, cb));
    bytes = statSync(temp).size;
    verification = fence.verification = 'failed';
    const sourceHash = await remoteDigest(sftp, o.remotePath);
    if (sourceHash !== await digest(createReadStream(temp))) throw new Error('SHA-256 readback mismatch');
    verification = fence.verification = 'sha256_matched';
    if (fence.cancelled) throw new Error('staged transfer cancelled');
    linkSync(temp, o.localPath); finalized = fence.finalized = true;
    unlinkSync(temp); owned = fence.owned = false;
    return { ok: true, bytes, sha256: sourceHash, verification, finalized: true, cleanup: 'removed' };
  } catch (e) {
    let cleanup: SftpResult['cleanup'] = fence.creationPending || fence.owned ? 'unknown' : 'not_needed';
    if (owned) {
      try {
        if (o.direction === 'upload') await invoke(cb => sftp.unlink(temp, cb));
        else unlinkSync(temp);
        cleanup = 'removed'; fence.owned = false;
      } catch { cleanup = 'failed'; }
    }
    return { error: (e as Error).message, bytes, verification, finalized: finalized ? true : fence.finalizationSent ? undefined : false, cleanup };
  }
}

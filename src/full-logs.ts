import { randomBytes } from 'node:crypto';
import { mkdtempSync, openSync, writeSync, closeSync, readSync, rmSync, statSync, lstatSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_RUN = 8 * 1024 * 1024;
const TTL = 60 * 60 * 1000;
const entries = new Map<string, Entry>();
let reserved = 0;
let directory: string | undefined;
type Entry = { paths: [string, string]; fds: [number, number]; sizes: [number, number]; quota: number; complete: boolean; expires: number; closed: boolean };

function root(): string {
  if (directory) return directory;
  // A fresh private child only: never change the ACL of a shared ancestor.
  const parent = process.env.POWERSHELL_MCP_LOG_PARENT ?? process.env.TMPDIR ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : tmpdir());
  const path = mkdtempSync(join(parent, 'powershell-mcp-log-'));
  try {
    if (process.platform === 'win32') {
      const csv = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = csv.match(/S-1-5-[0-9-]+/)?.[0];
      if (!sid) throw Error('Cannot identify current Windows user SID');
      execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
    } else chmodSync(path, 0o700);
    directory = path;
    return path;
  } catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
}
function safe(entry: Entry, index: number): string {
  const path = entry.paths[index];
  if (!directory || lstatSync(directory).isSymbolicLink() || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw Error('Log path is not a regular file');
  return path;
}
function prune(): void {
  for (const [handle, entry] of entries) if (entry.closed && Date.now() >= entry.expires) logStore.delete(handle);
}
export const logStore = {
  create(quota = MAX_RUN) {
    prune();
    if (!Number.isSafeInteger(quota) || quota < 1 || quota > MAX_RUN || reserved + quota > MAX_TOTAL) throw Error('Log quota unavailable');
    const dir = root();
    const handle = randomBytes(24).toString('hex');
    const paths: [string, string] = [join(dir, `${handle}.out`), join(dir, `${handle}.err`)];
    const fds: number[] = [];
    try {
      for (const path of paths) {
        const fd = openSync(path, 'wx', 0o600); fds.push(fd);
        if (process.platform !== 'win32') chmodSync(path, 0o600);
      }
    } catch (error) {
      for (const fd of fds) closeSync(fd);
      for (const path of paths) rmSync(path, { force: true });
      throw error;
    }
    const entry: Entry = { paths, fds: fds as [number, number], sizes: [0, 0], quota, complete: true, expires: Date.now() + TTL, closed: false };
    entries.set(handle, entry); reserved += quota;
    return {
      append(stream: 'stdout' | 'stderr', chunk: Buffer) {
        if (entry.closed) { entry.complete = false; return; }
        const i = stream === 'stdout' ? 0 : 1;
        const allowed = Math.min(chunk.length, Math.max(0, entry.quota - entry.sizes[0] - entry.sizes[1]));
        if (allowed < chunk.length) entry.complete = false;
        if (!allowed || entry.closed) return;
        try {
          let written = 0;
          while (written < allowed) {
            const n = writeSync(entry.fds[i], chunk, written, allowed - written);
            if (!n) throw Error('Log write made no progress');
            written += n; entry.sizes[i] += n;
          }
        } catch { entry.complete = false; }
      },
      finish(complete = true) {
        if (!complete) entry.complete = false;
        if (!entry.closed) {
          entry.closed = true;
          entry.expires = Date.now() + TTL;
          for (const fd of entry.fds) try { closeSync(fd); } catch { entry.complete = false; }
        }
        return { handle, complete: entry.complete, stdoutBytes: entry.sizes[0], stderrBytes: entry.sizes[1], expiresAt: new Date(entry.expires).toISOString() };
      },
    };
  },
  read(handle: string, stream: 'stdout' | 'stderr', offset: number, length: number) {
    prune();
    if (!/^[0-9a-f]{48}$/.test(handle) || !['stdout', 'stderr'].includes(stream) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw Error('Invalid log read');
    const entry = entries.get(handle);
    if (!entry || !entry.closed) throw Error('Unknown or unfinished log handle');
    const i = stream === 'stdout' ? 0 : 1;
    const path = safe(entry, i);
    const available = Math.min(length, Math.max(0, entry.sizes[i] - offset));
    const bytes = Buffer.alloc(available);
    const fd = openSync(path, 'r');
    try { if (readSync(fd, bytes, 0, available, offset) !== available) throw Error('Incomplete log read'); }
    finally { closeSync(fd); }
    return { data: bytes.toString('base64'), encoding: 'base64' as const, nextOffset: offset + available, totalBytes: entry.sizes[i], complete: entry.complete, expiresAt: new Date(entry.expires).toISOString() };
  },
  delete(handle: string) {
    const entry = entries.get(handle);
    if (!entry) return false;
    entries.delete(handle); reserved -= entry.quota;
    const wasClosed = entry.closed;
    entry.closed = true;
    entry.complete = false;
    if (!wasClosed) for (const fd of entry.fds) try { closeSync(fd); } catch { /* already invalid */ }
    for (let i = 0; i < 2; i++) { try { safe(entry, i); rmSync(entry.paths[i]); } catch { /* never follow replaced links */ } }
    return true;
  },
};
process.once('exit', () => { for (const handle of entries.keys()) logStore.delete(handle); if (directory) try { if (!lstatSync(directory).isSymbolicLink()) rmSync(directory); } catch { /* best effort */ } });

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, writeSync, readSync, statSync, readFileSync, renameSync, chmodSync, lstatSync, fsyncSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

type State = 'reserved' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
type Record = { id: string; ownerHash: string; keyHash: string; requestHash: string; state: State; exitCode: number | null; stdoutBytes: number; stderrBytes: number; outputComplete: boolean; createdAt: number; updatedAt: number; };
const LIMIT = 8_388_608;
const MAX_RUNS = 64;
const ID = /^[a-f0-9]{48}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const META_LIMIT = 4096;
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validRecord(value: unknown, id: string): value is Record {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record;
  return r.id === id && DIGEST.test(r.ownerHash) && DIGEST.test(r.keyHash) && DIGEST.test(r.requestHash)
    && ['reserved', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(r.state)
    && (r.exitCode === null || Number.isSafeInteger(r.exitCode))
    && Number.isSafeInteger(r.stdoutBytes) && r.stdoutBytes >= 0
    && Number.isSafeInteger(r.stderrBytes) && r.stderrBytes >= 0
    && r.stdoutBytes + r.stderrBytes <= LIMIT && typeof r.outputComplete === 'boolean'
    && Number.isSafeInteger(r.createdAt) && r.createdAt > 0
    && Number.isSafeInteger(r.updatedAt) && r.updatedAt >= r.createdAt;
}
function regular(path: string) { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink(); }
function createPrivateRoot(path: string) {
  if (process.platform !== 'win32') { mkdirSync(path, { mode: 0o700 }); return; }
  // Apply the descriptor in the creation API, never after inherited permissions are exposed.
  const literal = path.replace(/'/g, "''");
  const command = `$ErrorActionPreference='Stop'; $p='${literal}'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $security=New-Object Security.AccessControl.DirectorySecurity; $security.SetOwner($sid); $security.SetAccessRuleProtection($true,$false); foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) { $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $security.AddAccessRule($rule) }; [void][IO.Directory]::CreateDirectory($p,$security)`;
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  execFileSync(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'pipe' });
}
function verifyRoot(path: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw Error('Unsafe execution store');
  if (process.platform !== 'win32') {
    if (info.mode & 0o077) throw Error('Execution store permissions too broad');
    return;
  }
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const quoted = path.replace(/'/g, "''");
  const command = `$ErrorActionPreference='Stop'; try { Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath '${quoted}'; $owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value; $rules=@($a.Access | ForEach-Object { $identity=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; [pscustomobject]@{ sid=$identity; inherited=$_.IsInherited; type=[string]$_.AccessControlType; rights=[string]$_.FileSystemRights } }); $safe=($owner -eq $sid -and $a.AreAccessRulesProtected); foreach($r in $rules) { if($r.inherited -or $r.type -ne 'Allow' -or ($r.sid -ne $sid -and $r.sid -ne 'S-1-5-18')) { $safe=$false } }; if(-not $safe) { [pscustomobject]@{ current=$sid; owner=$owner; protected=$a.AreAccessRulesProtected; rules=$rules } | ConvertTo-Json -Compress -Depth 4; exit 2 } } catch { [pscustomobject]@{ diagnostic='ACL inspection failed'; errorType=$_.Exception.GetType().Name } | ConvertTo-Json -Compress; exit 3 }`;
  try { execFileSync(join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) {
    const detail = (error as { stdout?: string }).stdout?.trim().slice(0, 2048);
    throw Error(`Execution store owner or ACL unsafe${detail ? `: ${detail}` : ''}`);
  }
}
/** Local-only durable records. A new server never adopts or kills a previous server's processes. */
export class ExecutionStore {
  private children = new Map<string, ChildProcess>();
  private nonces = new Map<string, string>();
  private records = new Map<string, Record>();
  constructor(readonly root: string = join(process.env.POWERSHELL_MCP_EXEC_PARENT ?? process.env.TMPDIR ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : tmpdir()), 'powershell-mcp-executions'), private readonly flushOutput: (fd: number) => void = fsyncSync, private readonly metadataCommitted: () => void = () => {}) {
    if (!existsSync(root)) createPrivateRoot(root);
    verifyRoot(root);
    for (const name of readdirSync(root)) {
      if (!ID.test(name)) continue;
      const path = join(root, name, 'meta.json');
      if (!existsSync(path)) continue;
      try {
        if (lstatSync(join(root, name)).isSymbolicLink() || !lstatSync(join(root, name)).isDirectory() || !regular(path) || statSync(path).size > META_LIMIT) continue;
        const record: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (validRecord(record, name)) {
          let intact = false;
          try { intact = (['stdout', 'stderr'] as const).every(stream => {
            const output = join(root, name, stream);
            return regular(output) && statSync(output).size >= record[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes']
              && (!['completed', 'failed', 'cancelled'].includes(record.state) || statSync(output).size === record[stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes']);
          }); } catch { /* Missing output is ambiguous, not a completed result. */ }
          if (!intact) { record.state = 'unknown'; record.outputComplete = false; }
          this.records.set(name, record);
        }
      } catch { /* Invalid records are never adopted. */ }
    }
  }
  private save(record: Record) {
    record.updatedAt = Date.now();
    const dir = join(this.root, record.id);
    const temp = join(dir, `${randomBytes(12).toString('hex')}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temp, join(dir, 'meta.json')); this.metadataCommitted(); } catch (error) { try { unlinkSync(temp); } catch { /* retain original failure */ } throw error; }
  }
  private get(owner: string, id: string): Record {
    if (!owner || !ID.test(id)) throw Error('Unknown execution');
    const record = this.records.get(id);
    if (!record || record.ownerHash !== hash(owner)) throw Error('Unknown execution');
    return record;
  }
  status(owner: string, id: string) {
    const r = this.get(owner, id);
    const state = (r.state === 'running' || r.state === 'reserved') && !this.children.has(id) ? 'unknown' : r.state;
    return { id, state, exitCode: state === 'completed' || state === 'failed' || state === 'cancelled' ? r.exitCode : null, stdoutBytes: r.stdoutBytes, stderrBytes: r.stderrBytes, outputComplete: r.outputComplete && state !== 'unknown', createdAt: new Date(r.createdAt).toISOString(), updatedAt: new Date(r.updatedAt).toISOString() };
  }
  start(owner: string, key: string, program: string, args: string[] = [], cwd?: string) {
    if (!owner || !key || owner.length > 256 || key.length > 256 || !program || program.length > 4096 || args.length > 256 || args.some(a => a.length > 65536)) throw Error('Invalid execution request');
    const ownerHash = hash(owner), keyHash = hash([owner, key]), requestHash = hash([program, args, cwd ?? null]);
    for (const r of this.records.values()) if (r.keyHash === keyHash) {
      if (r.requestHash !== requestHash) throw Error('Idempotency conflict');
      return this.status(owner, r.id);
    }
    const keyPath = join(this.root, `${keyHash}.key`);
    if (existsSync(keyPath)) {
      if (!regular(keyPath) || statSync(keyPath).size !== 48) throw Error('Ambiguous idempotency reservation; refusing relaunch');
      const existingId = readFileSync(keyPath, 'utf8');
      if (!ID.test(existingId)) throw Error('Ambiguous idempotency reservation; refusing relaunch');
      const existing = this.records.get(existingId);
      if (!existing) throw Error('Ambiguous idempotency reservation; refusing relaunch');
      if (existing.ownerHash !== ownerHash || existing.requestHash !== requestHash) throw Error('Idempotency conflict');
      return this.status(owner, existingId);
    }
    const entries = readdirSync(this.root);
    if (entries.filter(n => ID.test(n)).length >= MAX_RUNS || entries.filter(n => n.endsWith('.key') && DIGEST.test(n.slice(0, -4))).length >= MAX_RUNS) throw Error('Execution capacity exhausted');
    const id = randomBytes(24).toString('hex');
    let keyFd: number;
    try { keyFd = openSync(keyPath, 'wx', 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Idempotency reservation exists; retry status, never relaunch'); throw error; }
    try { writeSync(keyFd, id); fsyncSync(keyFd); } finally { closeSync(keyFd); }
    const dir = join(this.root, id);
    mkdirSync(dir, { mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    const fds: number[] = [];
    try { fds.push(openSync(join(dir, 'stdout'), 'wx', 0o600)); fds.push(openSync(join(dir, 'stderr'), 'wx', 0o600)); }
    catch (error) { fds.forEach(closeSync); throw error; }
    const r: Record = { id, ownerHash, keyHash, requestHash, state: 'reserved', exitCode: null, stdoutBytes: 0, stderrBytes: 0, outputComplete: true, createdAt: Date.now(), updatedAt: Date.now() };
    this.records.set(id, r);
    try { this.save(r); } catch (error) { fds.forEach(closeSync); throw error; }
    let child: ChildProcess;
    const windows = process.platform === 'win32';
    const helper = join(dirname(fileURLToPath(import.meta.url)), '..', windows && import.meta.url.includes('/dist/') ? 'dist' : 'assets', 'job-supervisor.ps1');
    try {
      if (windows && !existsSync(helper)) throw Error('Packaged supervisor absent');
      child = windows
        ? spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-File', helper], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        : spawn(program, args, { cwd, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    }
    catch { r.state = 'unknown'; r.outputComplete = false; this.save(r); fds.forEach(closeSync); return this.status(owner, id); }
    this.children.set(id, child);
    const durable = { stdoutBytes: 0, stderrBytes: 0 };
    let outputFlushFailed = false;
    const persist = () => { try {
      if (!outputFlushFailed && (r.stdoutBytes !== durable.stdoutBytes || r.stderrBytes !== durable.stderrBytes)) {
        if (r.stdoutBytes !== durable.stdoutBytes) this.flushOutput(fds[0]);
        if (r.stderrBytes !== durable.stderrBytes) this.flushOutput(fds[1]);
        durable.stdoutBytes = r.stdoutBytes; durable.stderrBytes = r.stderrBytes;
      }
      // A failed flush can never make an uncommitted length durable.
      if (outputFlushFailed) { r.stdoutBytes = durable.stdoutBytes; r.stderrBytes = durable.stderrBytes; r.state = 'unknown'; r.outputComplete = false; }
      this.save(r);
    } catch { outputFlushFailed = true; r.state = 'unknown'; r.outputComplete = false; r.stdoutBytes = durable.stdoutBytes; r.stderrBytes = durable.stderrBytes; try { this.save(r); } catch { /* preserve unknown in memory */ } } };
    const append = (index: number, bytes: Buffer) => {
      if (outputFlushFailed) return;
      const field = index === 0 ? 'stdoutBytes' : 'stderrBytes';
      const allowed = Math.min(bytes.length, LIMIT - r.stdoutBytes - r.stderrBytes);
      if (allowed < bytes.length) r.outputComplete = false;
      try { if (allowed) {
        let written = 0;
        while (written < allowed) {
          const n = writeSync(fds[index], bytes, written, allowed - written);
          if (!n) throw Error('Output write made no progress');
          written += n; r[field] += n;
        }
        if (r.stdoutBytes + r.stderrBytes - durable.stdoutBytes - durable.stderrBytes >= 262144) persist();
      } }
      catch { r.state = 'unknown'; r.outputComplete = false; persist(); }
    };
    const nonce = randomBytes(24).toString('hex');
    if (windows) this.nonces.set(id, nonce);
    let control = '';
    let result: { event: string; cancelled?: boolean; exitCode?: number; active?: number } | undefined;
    let started = false;
    if (windows) {
      child.stdin?.on('error', () => { r.state = 'unknown'; r.outputComplete = false; });
      child.stdin?.write(JSON.stringify({ program, args, cwd, nonce }) + '\n');
      child.stdout?.on('data', (b: Buffer) => {
        control += b.toString('utf8');
        if (control.length > 131072) { r.state = 'unknown'; r.outputComplete = false; control = ''; return; }
        const lines = control.split('\n'); control = lines.pop() ?? '';
        for (const line of lines) {
          try {
            if (line.length > 8192) throw Error('Oversized supervisor frame');
            const message = JSON.parse(line);
            if (message.nonce !== nonce) throw Error('Unauthenticated supervisor frame');
            if (message.event === 'started' && !started && !result) started = true;
            else if (message.event === 'chunk' && started && !result && (message.stream === 'stdout' || message.stream === 'stderr') && typeof message.data === 'string' && /^[A-Za-z0-9+/]{0,5462}={0,2}$/.test(message.data)) {
              const bytes = Buffer.from(message.data, 'base64');
              if (bytes.length < 1 || bytes.length > 4096 || bytes.toString('base64') !== message.data) throw Error('Invalid chunk');
              append(message.stream === 'stdout' ? 0 : 1, bytes);
            } else if (message.event === 'finished' && started && !result && message.active === 0 && typeof message.cancelled === 'boolean' && Number.isSafeInteger(message.exitCode)) result = message;
            else if (message.event === 'unknown') { r.state = 'unknown'; r.outputComplete = false; }
            else throw Error('Invalid supervisor frame');
          } catch { r.state = 'unknown'; r.outputComplete = false; }
        }
      });
      child.stderr?.resume();
    } else {
      child.stdout?.on('data', (b: Buffer) => append(0, b));
      child.stderr?.on('data', (b: Buffer) => append(1, b));
    }
    child.once('error', () => { r.state = 'unknown'; r.outputComplete = false; persist(); });
    child.once('close', code => {
      if (windows && control.trim()) { r.state = 'unknown'; r.outputComplete = false; }
      // The terminal metadata may only reference flushed output bytes.
      persist();
      fds.forEach(fd => { try { closeSync(fd); } catch { /* already closed */ } });
      this.children.delete(id);
      this.nonces.delete(id);
      if (r.state !== 'unknown') {
        if (windows) {
          if (code === 0 && result) { r.state = result.cancelled ? 'cancelled' : result.exitCode === 0 ? 'completed' : 'failed'; r.exitCode = result.exitCode ?? null; }
          else { r.state = 'unknown'; r.outputComplete = false; }
        } else { r.state = code === 0 ? 'completed' : 'failed'; r.exitCode = code; }
      }
      persist();
    });
    r.state = 'running'; persist();
    return this.status(owner, id);
  }
  read(owner: string, id: string, stream: 'stdout' | 'stderr', offset: number, length: number) {
    const r = this.get(owner, id);
    if (!['stdout', 'stderr'].includes(stream) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 65536) throw Error('Invalid output page');
    const size = stream === 'stdout' ? r.stdoutBytes : r.stderrBytes;
    const amount = Math.min(length, Math.max(0, size - offset));
    const bytes = Buffer.alloc(amount);
    const path = join(this.root, id, stream);
    if (!regular(path) || statSync(path).size < size || (r.state === 'unknown' && !this.children.has(id))) throw Error('Unsafe or incomplete output path');
    const fd = openSync(path, 'r');
    try { if (readSync(fd, bytes, 0, amount, offset) !== amount) throw Error('Incomplete output read'); }
    finally { closeSync(fd); }
    return { data: bytes.toString('base64'), encoding: 'base64' as const, nextOffset: offset + amount, totalBytes: size, complete: ['completed', 'failed', 'cancelled'].includes(this.status(owner, id).state) && r.outputComplete };
  }
  cancel(owner: string, id: string) {
    const r = this.get(owner, id), child = this.children.get(id);
    if (r.state !== 'running' || !child || !child.pid || child.exitCode !== null) return this.status(owner, id);
    if (process.platform === 'win32') {
      try { child.stdin?.write(`cancel ${this.nonces.get(id)}\n`); } catch { r.state = 'unknown'; r.outputComplete = false; this.save(r); }
      return this.status(owner, id);
    }
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* failed signal */ }
    r.state = 'unknown'; r.outputComplete = false; this.save(r);
    return this.status(owner, id);
  }
}
export const executionStore = new ExecutionStore();

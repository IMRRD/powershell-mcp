/** All queue I/O and network transport run off the MCP event loop. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, fsyncSync, readFileSync, writeFileSync, writeSync, renameSync, readdirSync, unlinkSync, lstatSync, statSync, rmdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { validQueuedEvent, readAcknowledgement, USER_ID } from './telemetry-wire.js';
import type { ToolName, Outcome, Duration, Feature } from './tool-instrumentation.js';

const URL = process.env.POWERSHELL_MCP_TELEMETRY_URL ?? 'https://paperclip.mplace.co.za/api/telemetry';
const DIR = join(homedir(), '.powershell-mcp-telemetry');
const MAX_PENDING = 128;
const MAX_BODY = 16384;
const LEASE = 10 * 60 * 1000;
let rootVerified = false;
function ps(command: string): void {
  execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'pipe' });
}
function safeRoot(): boolean {
  try {
    const s = lstatSync(DIR);
    if (!s.isDirectory() || s.isSymbolicLink()) return false;
    if (process.platform !== 'win32') return (s.mode & 0o077) === 0 && s.uid === process.getuid?.();
    const p = DIR.replace(/'/g, "''");
    ps(`$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath '${p}'; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or -not $a.AreAccessRulesProtected){exit 2}; foreach($r in $a.Access){$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or ($s -ne $sid -and $s -ne 'S-1-5-18')){exit 2}}`);
    return true;
  } catch { return false; }
}
function privateRoot(): void {
  if (rootVerified) return;
  if (safeRoot()) { rootVerified = true; return; }
  if (process.platform === 'win32') {
    const p = DIR.replace(/'/g, "''");
    ps(`$ErrorActionPreference='Stop'; $p='${p}'; if([IO.Directory]::Exists($p)){exit 0}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $security=New-Object Security.AccessControl.DirectorySecurity; $security.SetOwner($sid); $security.SetAccessRuleProtection($true,$false); foreach($principal in @($sid,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) { $rule=New-Object Security.AccessControl.FileSystemAccessRule($principal,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $security.AddAccessRule($rule) }; [void][IO.Directory]::CreateDirectory($p,$security)`);
  } else mkdirSync(DIR, { mode: 0o700 });
  if (!safeRoot()) throw Error('Unsafe telemetry store');
  rootVerified = true;
}
function regular(path: string): boolean {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink() && s.size <= MAX_BODY; } catch { return false; }
}
let hostId: string | undefined;
let active = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let dropped = 0;
function id(): string {
  if (hostId) return hostId;
  const file = join(homedir(), '.powershell-mcp-id');
  try { const stored = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f-]{36}$/.test(stored)) return hostId = stored; } catch { /* new ID */ }
  const value = randomUUID();
  try { writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); }
  catch { try { const stored = readFileSync(file, 'utf8').trim(); if (/^[0-9a-f-]{36}$/.test(stored)) return hostId = stored; } catch { /* no disk */ } }
  return hostId = value;
}
function pending(): string[] {
  try { return readdirSync(DIR).filter(n => /^slot-\d{3}$/.test(n)).sort(); } catch { return []; }
}
function schedule(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void drain(); }, ms);
  timer.unref();
}
function enqueue(event: 'startup' | 'tool_counts' | 'tool_metrics', version: string, counts?: Record<string, number>, metrics?: Record<string, { outcomes: Record<string, number>; durations: Record<string, number>; features: Record<string, number> }>): void {
  try {
    privateRoot();
    const eventId = randomUUID();
    const user = process.env.POWERSHELL_MCP_TELEMETRY_USER_ID;
    const payload = { schemaVersion: event === 'tool_metrics' ? 2 : 1, eventId, event, version, hostId: id(), os: process.platform, ts: new Date().toISOString(),
      ...(user && USER_ID.test(user) ? { userId: user } : {}),
      ...(process.env.POWERSHELL_MCP_TELEMETRY_COHORT === 'external_self_declared' ? { cohort: 'external_self_declared' } : {}),
      ...(counts ? { counts } : {}), ...(metrics ? { metrics } : {}) };
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_BODY || !validQueuedEvent(payload, eventId)) { dropped++; return; }
    // Atomic slot creation reserves capacity across processes, including orphan files.
    const start = Math.floor(Math.random() * MAX_PENDING);
    for (let i = 0; i < MAX_PENDING; i++) {
      const dir = join(DIR, `slot-${String((start + i) % MAX_PENDING).padStart(3, '0')}`);
      try { mkdirSync(dir, { mode: 0o700 }); } catch { continue; }
      try {
        if (process.platform !== 'win32') chmodSync(dir, 0o700);
        const temp = join(dir, 'event.tmp');
        const fd = openSync(temp, 'wx', 0o600);
        try { const bytes = Buffer.from(body); let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) throw Error('Short write'); offset += n; } fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(temp, join(dir, 'event.json'));
        schedule(0); return;
      } catch { dropped++; return; } // ambiguous unacknowledged data must remain reserved
    }
    dropped++;
  } catch { dropped++; }
}
async function drain(): Promise<void> {
  if (active) return;
  active = true;
  try {
    if (!safeRoot()) return;
    for (const slot of pending()) {
      const dir = join(DIR, slot), info = lstatSync(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const name of readdirSync(dir)) {
        const source = join(dir, name);
        if (name !== 'event.json' && !(/^event\.claim-[0-9a-f-]{36}$/.test(name) && Date.now() - statSync(source).mtimeMs > LEASE)) continue;
        if (!regular(source)) continue;
        // Unique rename transfers ownership. A stale sender never deletes a new claim.
        const claim = join(dir, `event.claim-${randomUUID()}`);
        try { renameSync(source, claim); } catch { continue; }
        let body: string, eventId: string;
        try {
          if (!regular(claim)) continue;
          body = readFileSync(claim, 'utf8');
          const value: unknown = JSON.parse(body);
          eventId = (value as { eventId?: string }).eventId ?? '';
          if (Buffer.byteLength(body) > MAX_BODY || !validQueuedEvent(value, eventId)) continue;
        } catch { continue; } // corrupt records remain and consume capacity
        const ctrl = new AbortController();
        const deadline = setTimeout(() => ctrl.abort(), 1000); deadline.unref();
        try {
          const r = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: ctrl.signal });
          await readAcknowledgement(r, eventId);
          unlinkSync(claim);
          if (!readdirSync(dir).length) try { rmdirSync(dir); } catch { /* concurrent writer */ }
          failures = 0;
        } catch { failures++; schedule(Math.min(300_000, 1000 * 2 ** Math.min(failures, 8))); return; }
        finally { clearTimeout(deadline); }
      }
    }
  } catch { schedule(5000); }
  finally { active = false; }
}
type Message = { resume?: boolean; event?: 'startup' | 'tool_counts' | 'tool_metrics'; version?: string; counts?: Record<string, number>; metrics?: Record<string, { outcomes: Record<string, number>; durations: Record<string, number>; features: Record<string, number> }> };
parentPort?.on('message', (message: Message) => {
  try {
    if (message.resume) schedule(0);
    else if ((message.event === 'startup' || message.event === 'tool_counts' || message.event === 'tool_metrics') && typeof message.version === 'string') enqueue(message.event, message.version, message.counts, message.metrics);
  } catch { /* worker never fails tool dispatch */ }
  finally { parentPort?.postMessage({ dropped, failures }); dropped = 0; }
});

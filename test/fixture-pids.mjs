import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, realpathSync } from 'node:fs';

// Read the live OS process, independently of its marker. A unique fixture path
// in argv binds the PID to this invocation; another live Node PID is insufficient.
/** @param {number} pid @param {string} marker */
export function witnessFixturePid(pid, marker) {
  assert(Number.isSafeInteger(pid) && pid > 0, 'fixture identity requires a positive PID');
  let executable, commandLine, created;
  if (process.platform === 'win32') {
    // WMI through 5.1 avoids dependence on inherited PSModulePath/autoloading.
    const script = `$p=[wmi]'Win32_Process.Handle="${pid}"'; foreach($v in @($p.ExecutablePath,$p.CommandLine,$p.CreationDate)){[Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$v)))}`;
    const rows = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trimEnd().split(/\r?\n/).map(row => Buffer.from(row, 'base64').toString('utf8'));
    [executable, commandLine, created] = rows;
  } else {
    executable = readlinkSync(`/proc/${pid}/exe`);
    commandLine = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    created = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  }
  assert(executable && commandLine && created, `fixture identity unavailable for PID ${pid}`);
  /** @param {string} path */
  const canonical = path => process.platform === 'win32' ? realpathSync.native(path).toLowerCase() : realpathSync.native(path);
  assert.equal(canonical(executable), canonical(process.execPath), `fixture identity executable mismatch for PID ${pid}`);
  assert(commandLine.includes(marker), `fixture identity command line mismatch for PID ${pid}: ${marker}`);
  process.kill(pid, 0);
  console.log(`FIXTURE_PID_IDENTITY ${JSON.stringify({ pid, executable, marker, created })}`);
}

// Test-only marker reader, shared by native lifecycle fixtures.
/** @param {string} raw @param {readonly string[]} roles @returns {number[] | undefined} */
export function parseFixturePids(raw, roles = ['']) {
  // A terminal newline is the commit delimiter; a positive digit prefix is
  // still a partial write. Never trim an incomplete/invalid record into shape.
  if (!raw.endsWith('\n')) return undefined;
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length !== roles.length) return undefined;
  /** @type {number[]} */
  const pids = [];
  for (const [index, line] of lines.entries()) {
    const prefix = roles[index] ? `${roles[index]}:` : '';
    if (!line.startsWith(prefix)) return undefined;
    const digits = line.slice(prefix.length);
    if (!/^[1-9][0-9]*$/.test(digits)) return undefined;
    const pid = Number(digits);
    if (!Number.isSafeInteger(pid) || pids.includes(pid)) return undefined;
    pids.push(pid);
  }
  return pids;
}

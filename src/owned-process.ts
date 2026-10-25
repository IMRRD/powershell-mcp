import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lstatSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

// No PID from a record or process listing is ever used as a cancellation target.
// The private pipe addresses a live supervisor which retains kernel ownership.
export const CANCEL_BOUND_MS = 6000;
function executable(name: string, env: NodeJS.ProcessEnv, cwd = process.cwd()): string {
  const candidates = isAbsolute(name) || name.includes('/') || name.includes('\\') ? [name]
    : (env.PATH ?? env.Path ?? '').split(delimiter).flatMap(dir => process.platform === 'win32'
      ? [join(dir, name), join(dir, `${name}.exe`)] : [join(dir, name)]);
  // lstat also recognizes Windows App Execution Aliases (existsSync follows them).
  const found = candidates.map(path => resolve(cwd, path)).find(path => { try { return !lstatSync(path).isDirectory(); } catch { return false; } });
  if (!found) throw Object.assign(Error(`spawn ${name} ENOENT`), { code: 'ENOENT' });
  return found;
}

export interface OwnedChild extends ChildProcess { cancel(): void; treeTerminated?: boolean; }
export function spawnOwned(program: string, args: string[], options: SpawnOptions = {}): OwnedChild {
  const output = new EventEmitter() as OwnedChild;
  const stdout = new PassThrough(), stderr = new PassThrough(), stdin = new PassThrough();
  Object.assign(output, { stdout, stderr, stdin, exitCode: null, signalCode: null, treeTerminated: false });
  let supervisor: ChildProcess | undefined;
  let done = false, requested = false, sent = false, timer: NodeJS.Timeout | undefined;
  const finish = (code: number | null, proven = false) => {
    if (done) return; done = true; clearTimeout(timer);
    Object.assign(output, { exitCode: code, treeTerminated: proven });
    supervisor?.stdin?.destroy(); supervisor?.stdout?.destroy(); supervisor?.stderr?.destroy();
    // Never kill a supervisor by PID as a fallback. A failed channel means unknown.
    supervisor?.unref(); stdout.end(); stderr.end(); stdin.destroy();
    output.emit('close', code);
  };
  const nonce = randomBytes(24).toString('hex');
  output.cancel = () => {
    if (done || requested) return; requested = true;
    timer = setTimeout(() => finish(null), CANCEL_BOUND_MS);
    try { if (sent) supervisor?.stdin?.write(`cancel ${nonce}\n`); }
    catch { finish(null); }
  };
  output.kill = () => { output.cancel(); return true; };
  queueMicrotask(() => {
    try {
      const env = options.env ?? process.env;
      const cwd = resolve(typeof options.cwd === 'string' ? options.cwd : options.cwd ? fileURLToPath(options.cwd) : process.cwd());
      const app = executable(program, env, cwd);
      const windows = process.platform === 'win32';
      if (!windows && process.platform !== 'linux') throw Error('Owned supervision requires Windows or Linux');
      const helper = join(dirname(fileURLToPath(import.meta.url)), import.meta.url.includes('/dist/') ? '.' : '../assets', windows ? 'job-supervisor.ps1' : 'linux-supervisor.ps1');
      const engine = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe') : executable('pwsh', env);
      const assembly = join(dirname(fileURLToPath(import.meta.url)), import.meta.url.includes('/dist/') ? '.' : '../dist', 'linux-supervisor.dll');
      supervisor = spawn(engine, ['-NoProfile', '-NonInteractive', ...(windows ? ['-ExecutionPolicy', 'Bypass'] : []), '-File', helper, ...(!windows ? ['-AssemblyPath', assembly] : [])], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      Object.assign(output, { pid: supervisor.pid });
      let control = '', invalid = false, started = false, result: { exitCode: number; cancelled: boolean } | undefined;
      supervisor.stdin?.on('error', () => finish(null));
      supervisor.stderr?.resume();
      supervisor.once('error', error => { output.emit('error', error); finish(null); });
      supervisor.stdout?.on('data', (bytes: Buffer) => {
        control += bytes.toString('utf8');
        if (control.length > 131072) { invalid = true; control = ''; output.cancel(); return; }
        const lines = control.split('\n'); control = lines.pop() ?? '';
        for (const line of lines) try {
          const m = JSON.parse(line);
          if (m.nonce !== nonce || line.length > 8192) throw Error('Invalid supervisor frame');
          if (m.event === 'started' && !started && !result) started = true;
          else if (m.event === 'chunk' && started && !result && ['stdout', 'stderr'].includes(m.stream) && typeof m.data === 'string') {
            const b = Buffer.from(m.data, 'base64');
            if (!b.length || b.length > 4096 || b.toString('base64') !== m.data) throw Error('Invalid chunk');
            (m.stream === 'stdout' ? stdout : stderr).write(b);
          } else if (m.event === 'finished' && started && !result && m.active === 0 && Number.isSafeInteger(m.exitCode) && typeof m.cancelled === 'boolean') result = m;
          else throw Error('Supervisor did not prove termination');
        } catch { invalid = true; output.cancel(); }
      });
      supervisor.once('close', code => finish(!invalid && !control.trim() && code === 0 && result ? result.exitCode : null, !invalid && !control.trim() && code === 0 && !!result));
      const send = (input?: Buffer) => {
        if (done) return;
        sent = true;
        supervisor!.stdin!.write(JSON.stringify({ program: app, args, cwd, nonce, input: input?.toString('base64') }) + '\n');
        if (requested) supervisor!.stdin!.write(`cancel ${nonce}\n`);
      };
      if (Array.isArray(options.stdio) && options.stdio[0] === 'pipe') {
        const chunks: Buffer[] = []; stdin.on('data', b => chunks.push(b)); stdin.once('end', () => send(Buffer.concat(chunks)));
      } else send();
      output.emit('spawn');
    } catch (error) { output.emit('error', error); finish(null); }
  });
  return output;
}

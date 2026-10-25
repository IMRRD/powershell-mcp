import { copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
for (const name of ['job-supervisor.ps1', 'linux-supervisor.ps1'])
  copyFileSync(new URL(`assets/${name}`, root), new URL(`dist/${name}`, root));
const assembly = fileURLToPath(new URL('dist/linux-supervisor.dll', root));
rmSync(assembly, { force: true });
const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
  fileURLToPath(new URL('assets/linux-supervisor.ps1', root)), '-CompileOnly', '-AssemblyPath', assembly],
  { windowsHide: true, stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) throw Error(`Linux supervisor compilation failed (${result.status})`);

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSdk, requireReferences, run } from './supervisor-toolchain.mjs';

const root = new URL('../', import.meta.url);
const assembly = fileURLToPath(new URL('dist/linux-supervisor.dll', root));
// A failed prerequisite must never leave a stale shippable assembly.
rmSync(assembly, { force: true });
const compiler = requireSdk();
const references = requireReferences();
const work = mkdtempSync(join(tmpdir(), 'mcp-supervisor-build-'));
try {
  const output = join(work, 'linux-supervisor.dll');
  run([compiler, '/noconfig', '/nostdlib+', '/target:library', '/deterministic+', '/optimize+',
    '/langversion:8.0', `/out:${output}`, ...references.map(path => `/reference:${path}`),
    fileURLToPath(new URL('assets/linux-supervisor.cs', root))], { stdio: 'inherit' });
  mkdirSync(new URL('dist/', root), { recursive: true });
  copyFileSync(output, assembly);
  for (const name of ['job-supervisor.ps1', 'linux-supervisor.ps1'])
    copyFileSync(new URL(`assets/${name}`, root), new URL(`dist/${name}`, root));
} finally { rmSync(work, { recursive: true, force: true }); }

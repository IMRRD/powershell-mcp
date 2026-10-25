import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directory, packages, requireSdk, requireReferences, run } from './supervisor-toolchain.mjs';
const work = mkdtempSync(join(tmpdir(), 'mcp-supervisor-restore-'));
try {
  requireSdk();
  run(['restore', join(directory, 'Supervisor.csproj'), '--configfile', join(directory, 'NuGet.Config'),
    '--packages', packages, `-p:BaseIntermediateOutputPath=${work}/`], { stdio: 'inherit' });
  requireReferences();
} finally { rmSync(work, { recursive: true, force: true }); }

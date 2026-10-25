import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const directory = fileURLToPath(new URL('./supervisor-build/', import.meta.url));
export const baseline = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8'));
export const packages = process.env.NUGET_PACKAGES || join(homedir(), '.nuget', 'packages');
export const dotnet = process.env.MCP_SUPERVISOR_DOTNET || 'dotnet';
export function run(args, options = {}) {
  const result = spawnSync(dotnet, args, { cwd: directory, windowsHide: true, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Pinned supervisor toolchain failed (${result.status}): ${result.stderr || result.stdout}`);
  return (result.stdout || '').trim();
}
export function requireSdk() {
  const actual = run(['--version']);
  if (actual !== baseline.sdk) throw Error(`Supervisor requires SDK ${baseline.sdk}; found ${actual}`);
  const entry = run(['--list-sdks']).split(/\r?\n/).find(line => line.startsWith(`${baseline.sdk} [`));
  if (!entry) throw Error('Pinned SDK directory is missing');
  return join(entry.slice(entry.indexOf('[') + 1, -1), baseline.sdk, 'Roslyn', 'bincore', 'csc.dll');
}
export function referenceDigest(directory) {
  const files = readdirSync(directory).filter(name => name.endsWith('.dll')).sort();
  const hash = createHash('sha256');
  for (const name of files) hash.update(`${name}\0${createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')}\n`);
  return { files, hash: hash.digest('hex') };
}
export function requireReferences() {
  const pack = join(packages, 'microsoft.netcore.app.ref', baseline.referenceVersion);
  const nupkg = readFileSync(join(pack, `microsoft.netcore.app.ref.${baseline.referenceVersion}.nupkg`));
  if (createHash('sha512').update(nupkg).digest('base64') !== baseline.packageSha512)
    throw Error('Supervisor reference package hash mismatch');
  const refs = join(pack, 'ref', 'netcoreapp3.1');
  const { files, hash } = referenceDigest(refs);
  if (hash !== baseline.referencesSha256) throw Error('Supervisor reference assemblies hash mismatch');
  return files.map(name => join(refs, name));
}

import { spawnSync } from 'node:child_process';

export type EngineEvidence = { exe: string; version: string };
export function probeIntegrationEngine(exe: string): string | null {
  const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8', timeout: 15000 });
  return result.status === 0 && /^\d+\.\d+/.test(result.stdout.trim()) ? result.stdout.trim() : null;
}
export function selectIntegrationEngines(required: string | null | undefined = process.env.MCP_REQUIRED_ENGINE, platform = process.platform, probe = probeIntegrationEngine): EngineEvidence[] {
  if (required != null && required !== 'powershell' && required !== 'pwsh') throw new Error(`Invalid MCP_REQUIRED_ENGINE: ${required}`);
  if (required === 'powershell' && platform !== 'win32') throw new Error('Required engine powershell unavailable on non-Windows platform');
  const choices = required === 'powershell' ? ['powershell.exe'] : required === 'pwsh' ? [platform === 'win32' ? 'pwsh.exe' : 'pwsh'] : platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh'];
  const found = choices.flatMap(exe => {
    const version = probe(exe);
    if (!version) return [];
    const expected = exe === 'powershell.exe' ? '5.' : '7.';
    if (required && !version.startsWith(expected)) throw new Error(`Required engine ${required} reported unexpected version ${version}`);
    return [{ exe, version }];
  });
  if (required && !found.length) throw new Error(`Required engine ${required} unavailable`);
  if (required) console.log(`INTEGRATION_ENGINE executable=${found[0].exe} version=${found[0].version}`);
  return found;
}

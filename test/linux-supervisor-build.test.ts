import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('loads the packaged Linux supervisor without compiling source at invocation time', () => {
  const assembly = fileURLToPath(new URL('../dist/linux-supervisor.dll', import.meta.url));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -Path $env:MCP_TEST_SUPERVISOR; [LinuxJob].Assembly.Location'], {
    env: { ...process.env, MCP_TEST_SUPERVISOR: assembly }, encoding: 'utf8', windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(realpathSync.native(result.stdout.trim())).toBe(realpathSync.native(assembly));
});

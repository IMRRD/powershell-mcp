import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

it.each([
  'upload-close-loss', 'download-close-loss',
  'upload-close-error', 'download-close-error',
  'upload-close-hang', 'download-close-hang',
  'upload-close-late', 'download-close-late',
  'upload-hardlink-loss', 'upload-hardlink-graceful',
  'upload-success', 'download-success',
])('owns verification stream lifetime in a standalone process: %s', async mode => {
  const { stdout, stderr } = await run(process.execPath, [
    '--import', './node_modules/tsx/dist/loader.mjs',
    'test/fixtures/sftp-stream-lifecycle.ts', mode,
  ], { cwd: root, timeout: 15_000, env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1' } });
  expect(stderr).toBe('');
  expect(stdout).toContain(`lifecycle regression passed ${mode}`);
}, 20_000);

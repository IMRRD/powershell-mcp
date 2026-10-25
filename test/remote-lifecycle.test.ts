import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';
import { runSsh } from '../src/ssh.js';
import { fromSsh, fromProcess } from '../src/result.js';
const fixture = vi.hoisted(() => ({ failure: '' }));
vi.mock('../src/powershell.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/powershell.js')>();
  return { ...actual, runPowerShell: (script: string, options: import('../src/powershell.js').RunOptions) => actual.runPowerShell(`function Invoke-Command { throw [UnauthorizedAccessException]::new('${fixture.failure}') };\n` + script, options) };
});
import { runWinRm } from '../src/winrm.js';

describe('remote lifecycle certainty', () => {
  it('SSH inaccessible loopback endpoint returns termination unknown without retry', async () => {
    const endpoint = createServer(); await new Promise<void>(r => endpoint.listen(0, '127.0.0.1', r));
    const port = (endpoint.address() as { port: number }).port; await new Promise<void>(r => endpoint.close(() => r()));
    const result = fromSsh(await runSsh({ host: '127.0.0.1', port, username: 'fixture', password: 'synthetic', command: 'never-dispatch', timeoutMs: 1000, hostKeyPins: ['SHA256:' + 'A'.repeat(43)] }), 'loopback', 1024);
    expect(result).toMatchObject({ terminationStatus: 'transport_error', terminationCertainty: 'unknown', exitCode: null });
  });
  for (const mode of ['unauthorized', 'timeout'] as const) it(`SSH ${mode} preserves unknown remote termination`, async () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
    const parsed = utils.parseKey(key); if (parsed instanceof Error || Array.isArray(parsed)) throw Error('fixture key');
    const pin = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
    let connections = 0, commands = 0;
    const peers = new Set<import('ssh2').Connection>();
    const server = new Server({ hostKeys: [key] }, peer => {
      connections++; peers.add(peer); peer.on('error', () => {});
      peer.on('authentication', ctx => mode === 'unauthorized' ? ctx.reject() : ctx.accept());
      peer.on('ready', () => peer.on('session', accept => accept().on('exec', acceptExec => { commands++; acceptExec().write('before-timeout'); })));
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    try {
      const raw = await runSsh({ host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'fixture', password: 'synthetic-only', command: 'fixture-only', hostKeyPins: [pin], timeoutMs: 1500 });
      expect(fromSsh(raw, 'loopback', 1024)).toMatchObject({ terminationStatus: mode === 'unauthorized' ? 'transport_error' : 'timeout', terminationCertainty: 'unknown', exitCode: null });
      expect(connections).toBe(1); expect(commands).toBe(mode === 'unauthorized' ? 0 : 1);
      if (mode === 'timeout') expect(raw.stdout).toBe('before-timeout');
    } finally { for (const peer of peers) peer.end(); await new Promise<void>(r => server.close(() => r())); }
  });
  it.each(['inaccessible synthetic endpoint', 'authorization denied'])('WinRM %s through production dispatcher and isolated Invoke-Command', async failure => {
    fixture.failure = failure;
    const raw = await runWinRm({ computerName: 'synthetic.invalid', command: 'never execute', timeoutMs: 15000 });
    expect(fromProcess(raw, 'winrm', 'synthetic.invalid')).toMatchObject({ terminationStatus: 'transport_error', terminationCertainty: 'unknown', exitCode: null });
    expect(raw.stdout + raw.stderr).toContain(failure);
  });
});

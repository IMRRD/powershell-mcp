import { afterEach, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server, utils } from 'ssh2';
import { runSsh } from '../src/ssh.js';
import { runSftp } from '../src/sftp.js';

const directories: string[] = [];
afterEach(() => { for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const key = (algorithm: 'rsa' | 'ecdsa' = 'rsa') => algorithm === 'rsa'
  ? generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey
  : generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { format: 'pem', type: 'sec1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
const fingerprint = (pem: string) => { const parsed = utils.parseKey(pem); if (parsed instanceof Error) throw parsed; return 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, ''); };
async function fixture(pem: string) {
  let authenticated = 0, commands = 0, subsystems = 0;
  let remote = Buffer.alloc(0);
  const clients = new Set<import('ssh2').Connection>();
  const server = new Server({ hostKeys: [pem] }, client => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', ctx => { authenticated++; ctx.accept(); });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', acceptExec => { commands++; const stream = acceptExec(); stream.write('fixture-ok'); stream.exit(0); stream.end(); });
      session.on('sftp', acceptSftp => {
        subsystems++;
        const sftp = acceptSftp();
        const handles = new Map<string, 'read' | 'write'>();
        let next = 0;
        const valid = (path: string) => path === '/fixture.bin';
        sftp.on('OPEN', (id, path, flags) => {
          if (!valid(path)) return sftp.status(id, 3);
          const mode = flags & 2 ? 'write' : 'read';
          if (mode === 'write') remote = Buffer.alloc(0);
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++next);
          handles.set(handle.toString('hex'), mode);
          sftp.handle(id, handle);
        });
        sftp.on('FSTAT', (id, handle) => handles.has(handle.toString('hex')) ? sftp.attrs(id, { size: remote.length }) : sftp.status(id, 4));
        sftp.on('STAT', (id, path) => valid(path) ? sftp.attrs(id, { size: remote.length }) : sftp.status(id, 2));
        sftp.on('WRITE', (id, handle, offset, data) => {
          if (handles.get(handle.toString('hex')) !== 'write' || offset > 1_048_576 || offset + data.length > 1_048_576) return sftp.status(id, 4);
          if (remote.length < offset + data.length) { const grown = Buffer.alloc(offset + data.length); remote.copy(grown); remote = grown; }
          data.copy(remote, offset); sftp.status(id, 0);
        });
        sftp.on('READ', (id, handle, offset, length) => {
          if (handles.get(handle.toString('hex')) !== 'read') return sftp.status(id, 4);
          if (offset >= remote.length) return sftp.status(id, 1);
          sftp.data(id, remote.subarray(offset, offset + length));
        });
        sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString('hex')); sftp.status(id, 0); });
      });
    }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
  return { port: address.port, remote: () => Buffer.from(remote), counts: () => ({ authenticated, commands, subsystems }), close: () => new Promise<void>(resolve => { for (const client of clients) client.end(); server.close(() => resolve()); }) };
}
const base = (port: number) => ({ host: '127.0.0.1', port, username: 'fixture', password: 'fixture-password', timeoutMs: 2000 });

it('refuses unknown SSH host before authentication or exec', async () => {
  const server = await fixture(key());
  try { const result = await runSsh({ ...base(server.port), command: 'true' }); expect(result.error).toMatch(/host trust missing/i); expect(server.counts()).toEqual({ authenticated: 0, commands: 0, subsystems: 0 }); }
  finally { await server.close(); }
});

it('accepts a pinned SSH host and rejects changed key before authentication', async () => {
  const pem = key(); const server = await fixture(pem);
  try {
    const good = await runSsh({ ...base(server.port), command: 'true', hostKeyPins: [fingerprint(pem)] });
    expect(good.stdout).toBe('fixture-ok'); expect(good.exitCode).toBe(0);
    const bad = await runSsh({ ...base(server.port), command: 'true', hostKeyPins: [fingerprint(key())] });
    expect(bad.error).toMatch(/host key mismatch/i); expect(server.counts()).toEqual({ authenticated: 1, commands: 1, subsystems: 0 });
  } finally { await server.close(); }
});

it('accepts a separately approved rotation pin', async () => {
  const pem = key(); const server = await fixture(pem);
  try {
    const result = await runSsh({ ...base(server.port), command: 'true', hostKeyPins: [fingerprint(key()), fingerprint(pem)] });
    expect(result.exitCode).toBe(0);
    expect(server.counts().authenticated).toBe(1);
  } finally { await server.close(); }
});

it('validates malformed pins without connecting', async () => {
  const result = await runSftp({ ...base(1), direction: 'upload', localPath: 'none', remotePath: 'none', hostKeyPins: ['SHA256:invalid'] });
  expect(result.error).toMatch(/invalid host key pin/i);
});

it('rejects unsupported known-host markers before network', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'host-trust-')); directories.push(dir);
  const known = join(dir, 'known_hosts'); writeFileSync(known, '@cert-authority *.invalid ssh-rsa AAAA\n');
  const result = await runSsh({ ...base(1), command: 'true', knownHostsPath: known });
  expect(result.error).toBe('invalid known hosts');
});

it.each(['====', '=', '==', '===', '!'])('rejects malformed known-host key suffix %j before authentication', async suffix => {
  const pem = key(); const server = await fixture(pem);
  const dir = mkdtempSync(join(tmpdir(), 'host-trust-')); directories.push(dir);
  const parsed = utils.parseKey(pem); if (parsed instanceof Error) throw parsed;
  const known = join(dir, 'known_hosts');
  writeFileSync(known, `[127.0.0.1]:${server.port} ${parsed.type} ${parsed.getPublicSSH().toString('base64')}${suffix}\n`);
  try {
    const result = await runSsh({ ...base(server.port), command: 'true', knownHostsPath: known });
    expect(result.error).toBe('invalid known hosts');
    expect(server.counts()).toEqual({ authenticated: 0, commands: 0, subsystems: 0 });
  } finally { await server.close(); }
});

it('uses exact bracketed nondefault host port in known hosts for both transports', async () => {
  const pem = key(); const server = await fixture(pem);
  const dir = mkdtempSync(join(tmpdir(), 'host-trust-')); directories.push(dir);
  const parsed = utils.parseKey(pem); if (parsed instanceof Error) throw parsed;
  const publicKey = parsed.getPublicSSH();
  const known = join(dir, 'known_hosts');
  writeFileSync(known, `[127.0.0.1]:${server.port} ${parsed.type} ${publicKey.toString('base64')}\n`);
  try {
    const good = await runSsh({ ...base(server.port), command: 'true', knownHostsPath: known });
    expect(good.exitCode).toBe(0);
    const original = Buffer.from('real SFTP bytes\u0000\u00ff\n'.repeat(1024));
    const source = join(dir, 'source.bin'), destination = join(dir, 'destination.bin');
    writeFileSync(source, original);
    const transfer = await runSftp({ ...base(server.port), direction: 'upload', localPath: source, remotePath: '/fixture.bin', knownHostsPath: known });
    expect(transfer).toMatchObject({ ok: true, bytes: original.length });
    expect(createHash('sha256').update(server.remote()).digest('hex')).toBe(createHash('sha256').update(original).digest('hex'));
    const download = await runSftp({ ...base(server.port), direction: 'download', localPath: destination, remotePath: '/fixture.bin', knownHostsPath: known });
    expect(download).toMatchObject({ ok: true, bytes: original.length });
    expect(readFileSync(destination)).toEqual(original);
    expect(server.counts().authenticated).toBe(3);
    const wrong = join(dir, 'wrong'); writeFileSync(wrong, `127.0.0.1 ${parsed.type} ${publicKey.toString('base64')}\n`);
    const missing = await runSftp({ ...base(server.port), direction: 'upload', localPath: 'none', remotePath: 'none', knownHostsPath: wrong });
    expect(missing.error).toMatch(/host trust missing/i);
    expect(server.counts().authenticated).toBe(3);
  } finally { await server.close(); }
});

it.each(['rsa', 'ecdsa'] as const)('transfers pinned %s host bytes and refuses a changed key before auth', async algorithm => {
  const pem = key(algorithm), server = await fixture(pem);
  const dir = mkdtempSync(join(tmpdir(), 'host-trust-')); directories.push(dir);
  const source = join(dir, 'input'), target = join(dir, 'output');
  const bytes = Buffer.from(Array.from({ length: 8192 }, (_, i) => i % 251));
  writeFileSync(source, bytes);
  try {
    const trusted = { ...base(server.port), hostKeyPins: [fingerprint(pem)] };
    expect(await runSftp({ ...trusted, direction: 'upload', localPath: source, remotePath: '/fixture.bin' })).toMatchObject({ ok: true, bytes: bytes.length });
    expect(server.remote()).toEqual(bytes);
    expect(await runSftp({ ...trusted, direction: 'download', localPath: target, remotePath: '/fixture.bin' })).toMatchObject({ ok: true, bytes: bytes.length });
    expect(readFileSync(target)).toEqual(bytes);
    const before = server.counts();
    const wrong = await runSftp({ ...base(server.port), hostKeyPins: [fingerprint(key())], direction: 'upload', localPath: source, remotePath: '/fixture.bin' });
    expect(wrong.error).toMatch(/host key mismatch/i);
    expect(server.counts()).toEqual(before);
    expect(server.remote()).toEqual(bytes);
  } finally { await server.close(); }
});

it('runs built MCP SSH and SFTP with explicit pins and known-host policy', async () => {
  const pem = key('ecdsa'), server = await fixture(pem);
  const dir = mkdtempSync(join(tmpdir(), 'host-trust-')); directories.push(dir);
  const parsed = utils.parseKey(pem); if (parsed instanceof Error) throw parsed;
  const known = join(dir, 'known_hosts');
  writeFileSync(known, `[127.0.0.1]:${server.port} ${parsed.type} ${parsed.getPublicSSH().toString('base64')}\n`);
  const input = join(dir, 'input'), output = join(dir, 'output');
  const bytes = Buffer.from('MCP transport pinned file\u0000'.repeat(200)); writeFileSync(input, bytes);
  const client = new Client({ name: 'host-trust-regression', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/index.js')], env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1', POWERSHELL_MCP_KNOWN_HOSTS: known }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const common = { ...base(server.port) };
    const ssh = await client.callTool({ name: 'ssh_exec', arguments: { ...common, command: 'true', hostKeyPins: [fingerprint(pem)] } });
    const batch = await client.callTool({ name: 'start_remote_batch', arguments: { targets: [
      { transport: 'ssh', host: '127.0.0.1', port: server.port, username: 'test', command: 'true', password: 'test', hostKeyPins: [fingerprint(pem)] },
      { transport: 'ssh', host: '127.0.0.1', port: server.port, username: 'test', command: 'true', password: 'test', hostKeyPins: ['SHA256:invalid'] },
    ], concurrency: 2, timeoutMs: 3000 } });
    const batchId = JSON.parse((batch.content[0] as { text: string }).text).id;
    let batchState: any;
    for (let i = 0; i < 40; i++) {
      batchState = JSON.parse(((await client.callTool({ name: 'remote_batch_status', arguments: { id: batchId } })).content[0] as { text: string }).text);
      if (batchState.results.every((r: any) => r.status !== 'running' && r.status !== 'queued')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(batchState.results.map((r: any) => r.status), JSON.stringify(batchState.results)).toEqual(['completed', 'unknown']);
    expect(batchState.results[0].result.stdout).toBe('fixture-ok');
    expect(ssh.isError ?? false).toBe(false);
    expect((ssh.structuredContent as Record<string, unknown>).stdout).toBe('fixture-ok');
    const upload = await client.callTool({ name: 'sftp_upload', arguments: { ...common, localPath: input, remotePath: '/fixture.bin' } });
    expect(upload.isError ?? false).toBe(false);
    expect(server.remote()).toEqual(bytes);
    const download = await client.callTool({ name: 'sftp_download', arguments: { ...common, localPath: output, remotePath: '/fixture.bin', hostKeyPins: [fingerprint(pem)] } });
    expect(download.isError ?? false).toBe(false);
    expect(readFileSync(output)).toEqual(bytes);
    const before = server.counts();
    const rejected = await client.callTool({ name: 'ssh_exec', arguments: { ...common, command: 'true', hostKeyPins: ['SHA256:invalid'] } });
    expect(rejected.isError).toBe(true);
    expect(server.counts()).toEqual(before);
  } finally { await client.close(); await server.close(); }
});

import { it, expect, vi } from 'vitest';
import { Client as SshClient, Server, utils } from 'ssh2';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { runSsh } from '../src/ssh.js';
import { executeBatchTarget } from '../src/remote-batch.js';

const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
const pin = (key: string) => { const parsed = utils.parseKey(key); if (parsed instanceof Error) throw parsed; return 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, ''); };
async function fixture(forward: boolean) {
  const key = pem(); let auth = 0, commands = 0, connections = 0;
  const sockets = new Set<import('ssh2').Connection>();
  const server = new Server({ hostKeys: [key] }, client => {
    connections++; sockets.add(client); client.on('error', () => {}); client.on('close', () => sockets.delete(client));
    client.on('authentication', ctx => { auth++; ctx.accept(); });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (!forward || info.destIP !== '127.0.0.1') return reject();
        const net = import('node:net');
        void net.then(({ connect }) => { const outbound = connect(info.destPort, '127.0.0.1'); outbound.once('connect', () => { const stream = accept(); outbound.pipe(stream).pipe(outbound); }); outbound.once('error', () => reject()); });
      });
      client.on('session', accept => accept().on('exec', (acceptExec) => { commands++; const stream = acceptExec(); stream.write('routed-ok'); stream.exit(0); stream.end(); }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
  return { port: address.port, pin: pin(key), counts: () => ({ auth, commands, connections, live: sockets.size }), close: async () => { for (const c of sockets) c.end(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const endpoint = (s: Awaited<ReturnType<typeof fixture>>) => ({ host: '127.0.0.1', port: s.port, username: 'fixture', password: 'synthetic', hostKeyPins: [s.pin] });

it('does not dispatch a hop after synchronous credential preparation exhausts the absolute deadline', async () => {
  const hopPin = pin(pem());
  const connect = vi.spyOn(SshClient.prototype, 'connect');
  try {
    const result = await runSsh({ host: '127.0.0.1', username: 'fixture', command: 'echo', password: 'synthetic',
      deadlineAt: Date.now() + 20, jumps: [{ host: '127.0.0.1', username: 'fixture', credentialRef: 'synthetic', hostKeyPins: [hopPin] }],
      credentialProvider: { resolve() {
        const until = Date.now() + 40;
        while (Date.now() < until) { /* deliberately block the event loop before its timer can fire */ }
        return { transport: 'ssh', host: '127.0.0.1', port: 22, principal: 'fixture', password: 'synthetic' };
      } },
    });
    expect(result.timedOut).toBe(true);
    expect(connect).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); }
});

it('never execs after a blocking final connect emits ready', async () => {
  const connect = vi.spyOn(SshClient.prototype, 'connect').mockImplementation(function (this: SshClient) {
    const until = Date.now() + 35;
    while (Date.now() < until) { /* expire the deadline before the timer runs */ }
    this.emit('ready');
    return this;
  });
  const exec = vi.spyOn(SshClient.prototype, 'exec');
  try {
    const result = await runSsh({ host: '127.0.0.1', username: 'fixture', password: 'synthetic', command: 'never',
      deadlineAt: Date.now() + 10,
    });
    expect(result.timedOut).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  } finally { exec.mockRestore(); connect.mockRestore(); }
});

it('never forwards after a blocking hop ready event expires the deadline', async () => {
  const connect = vi.spyOn(SshClient.prototype, 'connect').mockImplementation(function (this: SshClient) {
    const until = Date.now() + 35;
    while (Date.now() < until) { /* timer cannot run until this returns */ }
    this.emit('ready');
    return this;
  });
  const forward = vi.spyOn(SshClient.prototype, 'forwardOut');
  const exec = vi.spyOn(SshClient.prototype, 'exec');
  try {
    const result = await runSsh({ host: '127.0.0.1', username: 'fixture', password: 'synthetic', command: 'never',
      deadlineAt: Date.now() + 10, jumps: [{ host: '127.0.0.1', username: 'fixture', password: 'synthetic', hostKeyPins: [pin(pem())] }],
    });
    expect(result.timedOut).toBe(true);
    expect(forward).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  } finally { exec.mockRestore(); forward.mockRestore(); connect.mockRestore(); }
});

it('executes through two real forwarded SSH hops, and batch uses the same route', async () => {
  const dest = await fixture(false), middle = await fixture(true), first = await fixture(true);
  try {
    const target = { ...endpoint(dest), command: 'echo routed', jumps: [endpoint(first), endpoint(middle)], timeoutMs: 5000 };
    const result = await runSsh(target);
    expect(result).toMatchObject({ stdout: 'routed-ok', exitCode: 0, timedOut: false });
    const batch = await executeBatchTarget({ ...target, transport: 'ssh' }, 5000);
    expect(batch.status).toBe('completed');
    expect(dest.counts().commands).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect([first, middle, dest].map(s => s.counts().live)).toEqual([0, 0, 0]);
  } finally { await first.close(); await middle.close(); await dest.close(); }
});

it('rejects an intermediate changed host key before its authentication or downstream connection', async () => {
  const dest = await fixture(false), middle = await fixture(true), first = await fixture(true), wrong = await fixture(false);
  try {
    const r = await runSsh({ ...endpoint(dest), command: 'echo', jumps: [endpoint(first), { ...endpoint(middle), hostKeyPins: [wrong.pin] }], timeoutMs: 3000 });
    expect(r.error).toMatch(/host key mismatch/);
    expect(middle.counts().auth).toBe(0); expect(dest.counts().connections).toBe(0);
  } finally { await first.close(); await middle.close(); await dest.close(); await wrong.close(); }
});

it('fails unreachable hop and short deadline without destination dispatch', async () => {
  const dest = await fixture(false), first = await fixture(true);
  try {
    const failed = await runSsh({ ...endpoint(dest), command: 'echo', jumps: [endpoint(first), { ...endpoint(first), port: 1 }], timeoutMs: 1000 });
    expect(failed.error).toBeTruthy(); expect(dest.counts().commands).toBe(0);
    const timed = await runSsh({ ...endpoint(dest), command: 'echo', jumps: [endpoint(first)], timeoutMs: 1 });
    expect(timed.timedOut).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dest.counts().commands).toBe(0);
    expect(first.counts().live).toBe(0);
  } finally { await first.close(); await dest.close(); }
});

it('runs a routed command through the built MCP endpoint', async () => {
  const dest = await fixture(false), jump = await fixture(true);
  const client = new Client({ name: 'jump-contract', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist/index.js')], env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: '1' }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const reply = await client.callTool({ name: 'ssh_exec', arguments: { ...endpoint(dest), jumps: [endpoint(jump)], command: 'echo routed', timeoutMs: 5000 } });
    expect(reply.isError ?? false).toBe(false);
    expect(reply.structuredContent).toMatchObject({ stdout: 'routed-ok', exitCode: 0 });
    expect(dest.counts().commands).toBe(1);
  } finally { await client.close(); await jump.close(); await dest.close(); }
});

it('denies each mis-scoped credential on a populated two-hop route, and accepts matching scopes', async () => {
  const dest = await fixture(false), middle = await fixture(true), first = await fixture(true);
  try {
    const hops = [endpoint(first), endpoint(middle)];
    for (const failedIndex of [0, 1]) {
      const target = { ...endpoint(dest), command: 'echo routed', jumps: hops.map((hop, i) => ({ ...hop, password: undefined, credentialRef: `hop-${i}` })), password: 'synthetic', timeoutMs: 5000,
        credentialProvider: { async resolve(ref: string) {
          const i = ref === 'destination' ? 2 : Number(ref.slice(-1));
          const selected = [first, middle, dest][i];
          return { transport: 'ssh' as const, host: i === failedIndex ? 'wrong.invalid' : '127.0.0.1', port: selected.port, principal: 'fixture', password: 'synthetic' };
        } } };
      const before = dest.counts().commands;
      const failure = await runSsh(target);
      expect(failure.error).toMatch(/Credential scope mismatch/);
      expect(dest.counts().commands).toBe(before);
    }
    const good = await runSsh({ ...endpoint(dest), command: 'echo routed', jumps: hops.map((hop, i) => ({ ...hop, password: undefined, credentialRef: `hop-${i}` })), password: 'synthetic', timeoutMs: 5000,
      credentialProvider: { async resolve(ref: string) {
        const i = ref === 'destination' ? 2 : Number(ref.slice(-1));
        return { transport: 'ssh' as const, host: '127.0.0.1', port: [first, middle, dest][i].port, principal: 'fixture', password: 'synthetic' };
      } } });
    expect(good).toMatchObject({ stdout: 'routed-ok', exitCode: 0 });
  } finally { await first.close(); await middle.close(); await dest.close(); }
});

it('denies a mis-scoped hop credential before that hop authenticates', async () => {
  const dest = await fixture(false), hop = await fixture(true);
  try {
    const result = await runSsh({ ...endpoint(dest), command: 'echo', jumps: [{ host: '127.0.0.1', port: hop.port, username: 'fixture', credentialRef: 'synthetic', hostKeyPins: [hop.pin] }],
      credentialProvider: { async resolve() { return { transport: 'ssh', host: 'wrong.invalid', port: hop.port, principal: 'fixture', password: 'synthetic' }; } }, timeoutMs: 2000 });
    expect(result.error).toMatch(/Credential scope mismatch/);
    expect(hop.counts().auth).toBe(0); expect(dest.counts().connections).toBe(0);
  } finally { await hop.close(); await dest.close(); }
});

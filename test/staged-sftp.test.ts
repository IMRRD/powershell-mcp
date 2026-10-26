import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep as fsPathSeparator } from 'node:path';
import { runSftp } from '../src/sftp.js';

describe('staged SFTP fail closed', () => {
  it('rejects unsupported remote atomic finalization before connecting or touching destination', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'staged-sftp-'));
    try {
      const source = join(dir, 'source'); const destination = join(dir, 'destination');
      writeFileSync(source, 'new'); writeFileSync(destination, 'old');
      const result = await runSftp({ direction: 'upload', staged: true, localPath: source, remotePath: destination, host: '127.0.0.1', port: 1, username: 'test', password: 'test', hostKeyPins: [] });
      expect(result.ok).toBe(false);
      expect(readFileSync(destination, 'utf8')).toBe('old');
      expect(result.verification).toBe('not_started');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

import { createHash, generateKeyPairSync } from 'node:crypto';
import { Server, utils } from 'ssh2';

// A deadline reports missing completion; it never substitutes for the local-work drain.
async function bounded(work: Promise<void>, label: string, timeoutMs = 2000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not complete within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function stagedScenario(gateClose: boolean, fault: { localOpenError?: Error; setupError?: Error } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'staged-loop-'));
  // Server shutdown drains sockets, not ssh2 fastGet's asynchronous local fds.
  const localWork: Promise<void>[] = [];
  const descriptors = new Map<number, { path: string; complete: () => void }>();
  const closeErrors: NodeJS.ErrnoException[] = [];
  const open = fs.open, close = fs.close, write = fs.write;
  const restoreSpies: Array<() => void> = [];
  try {
  const openSpy = vi.spyOn(fs, 'open').mockImplementation(new Proxy(open, {
    apply(open, receiver, args) {
      const path = String(args[0]);
      if (!path.startsWith(dir + fsPathSeparator)) return Reflect.apply(open, receiver, args);
      let complete!: () => void;
      localWork.push(new Promise<void>(resolve => { complete = resolve; }));
      const callback = args.at(-1);
      args[args.length - 1] = (error: NodeJS.ErrnoException | null, fd: number) => {
        if (!error) descriptors.set(fd, { path, complete });
        try { callback(error, fd); } finally { if (error) complete(); }
      };
      if (fault.localOpenError && path.includes('.held-download.mcp-')) {
        queueMicrotask(() => args.at(-1)(fault.localOpenError));
        return;
      }
      return Reflect.apply(open, receiver, args);
    },
  }));
  restoreSpies.push(() => openSpy.mockRestore());
  const writeSpy = vi.spyOn(fs, 'write').mockImplementation(new Proxy(write, {
    apply(write, receiver, args) {
      if (!descriptors.has(args[0])) return Reflect.apply(write, receiver, args);
      let complete!: () => void;
      localWork.push(new Promise<void>(resolve => { complete = resolve; }));
      const callback = args.at(-1);
      args[args.length - 1] = (...result: unknown[]) => { try { callback(...result); } finally { complete(); } };
      return Reflect.apply(write, receiver, args);
    },
  }));
  restoreSpies.push(() => writeSpy.mockRestore());
  let releaseClose: (() => void) | undefined;
  let heldFd: number | undefined;
  let requestClose!: () => void;
  const closeRequested = new Promise<void>(resolve => { requestClose = resolve; });
  let holdLocalClose = false;
  let localClosed = false;
  const closeSpy = vi.spyOn(fs, 'close').mockImplementation((fd, callback) => {
    const file = descriptors.get(fd);
    if (!file) return close(fd, callback);
    const finish = () => close(fd, error => {
      try { callback?.(error); } finally {
        if (error) closeErrors.push(error);
        descriptors.delete(fd); file.complete();
        if (fd === heldFd) localClosed = true;
      }
    });
    if (holdLocalClose && file?.path.includes('.held-download.mcp-')) {
      heldFd = fd; releaseClose = finish; requestClose();
    } else finish();
  });
  restoreSpies.push(() => closeSpy.mockRestore());
  const connections = new Set<import('ssh2').Connection>();
  let server: Server | undefined;
  let scenarioSucceeded = false;
  try {
  if (fault.setupError) throw fault.setupError;
  const pem = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { format: 'pem', type: 'pkcs1' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey;
  const parsed = utils.parseKey(pem); if (parsed instanceof Error) throw parsed;
  const pin = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const files = new Map<string, Buffer>();
  let holdRead = false, holdDownloadRead = false, createThenOpenError = false;
  let corruptRead = false, refuseWrite = false, refuseHardlink = false, refuseRemove = false, holdHardlink = false, loseAfterHardlink = false, holdOpen = false;
  const delayedOpens: Array<() => void> = [];
  let mutateSource: (() => void) | undefined;
  const delayedReads: Array<() => void> = [];
  const delayedLinks: Array<() => void> = [];
  server = new Server({ hostKeys: [pem] }, client => {
    connections.add(client); client.on('close', () => connections.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => ctx.accept()).on('ready', () => client.on('session', accept => {
      accept().on('sftp', acceptSftp => {
        const sftp = acceptSftp();
        // ssh2's server emits a fixed bare VERSION; advertise through its actual channelData API.
        const channel = (sftp as any)._protocol;
        const original = channel.channelData.bind(channel);
        channel.channelData = (id: number, packet: Buffer) => {
          if (packet.length === 9 && packet[4] === 2 && !refuseHardlink) {
            const name = Buffer.from('hardlink@openssh.com'), version = Buffer.from('1');
            const ext = Buffer.alloc(8 + name.length + version.length);
            ext.writeUInt32BE(name.length); name.copy(ext, 4);
            ext.writeUInt32BE(version.length, 4 + name.length); version.copy(ext, 8 + name.length);
            const advertised = Buffer.concat([packet, ext]); advertised.writeUInt32BE(advertised.length - 4);
            return original(id, advertised);
          }
          return original(id, packet);
        };
        const handles = new Map<string, { path: string; write: boolean }>(); let serial = 0;
        sftp.on('OPEN', (id, path, flags) => {
          if (!path.startsWith('/fixture/') || path.includes('..')) return sftp.status(id, 3);
          const write = !!(flags & 2);
          if (write && flags & 32 && files.has(path)) return sftp.status(id, 11);
          if (write && flags & 8) files.set(path, Buffer.alloc(0));
          if (!files.has(path)) return sftp.status(id, 2);
          const handle = Buffer.alloc(4); handle.writeUInt32BE(++serial); handles.set(handle.toString('hex'), { path, write });
          if (createThenOpenError && path.includes('.open-error.mcp-')) sftp.status(id, 4);
          else if (holdOpen && path.includes('.pending-open.mcp-')) delayedOpens.push(() => sftp.handle(id, handle));
          else sftp.handle(id, handle);
        });
        sftp.on('STAT', (id, path) => files.has(path) ? sftp.attrs(id, { size: files.get(path)!.length }) : sftp.status(id, 2));
        sftp.on('FSTAT', (id, h) => { const f = handles.get(h.toString('hex')); f ? sftp.attrs(id, { size: files.get(f.path)!.length }) : sftp.status(id, 4); });
        sftp.on('WRITE', (id, h, offset, data) => {
          const f = handles.get(h.toString('hex')); if (!f?.write) return sftp.status(id, 4);
          if (refuseWrite) return sftp.status(id, 3);
          const old = files.get(f.path)!; const next = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(next); data.copy(next, offset); files.set(f.path, next); sftp.status(id, 0);
          mutateSource?.(); mutateSource = undefined;
        });
        sftp.on('READ', (id, h, offset, length) => {
          const f = handles.get(h.toString('hex')); if (!f) return sftp.status(id, 4);
          const respond = () => { const data = files.get(f.path)!; offset >= data.length ? sftp.status(id, 1) : sftp.data(id, corruptRead && f.path.includes('.part') ? Buffer.from(data.subarray(offset, offset + length).map(b => b ^ 1)) : data.subarray(offset, offset + length)); };
          if ((holdRead && f.path.includes('.late.')) || (holdDownloadRead && f.path === '/fixture/final')) delayedReads.push(respond); else respond();
        });
        sftp.on('CLOSE', (id, h) => { handles.delete(h.toString('hex')); sftp.status(id, 0); });
        sftp.on('REMOVE', (id, path) => { if (refuseRemove) return sftp.status(id, 3); files.delete(path); sftp.status(id, 0); });
        sftp.on('EXTENDED', (id, name, payload) => {
          if (name !== 'hardlink@openssh.com') return sftp.status(id, 8);
          const size = payload.readUInt32BE(0), source = payload.subarray(4, 4 + size).toString();
          const start = 4 + size, target = payload.subarray(start + 4, start + 4 + payload.readUInt32BE(start)).toString();
          if (!files.has(source) || files.has(target)) { sftp.status(id, 4); return; }
          const respond = () => { files.set(target, files.get(source)!); sftp.status(id, 0); };
          if (loseAfterHardlink) { files.set(target, files.get(source)!); client.destroy(); }
          else if (holdHardlink) delayedLinks.push(respond); else respond();
        });
      });
    }));
  });
  await bounded(new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => { server!.removeListener('error', reject); resolve(); });
  }), 'server listen');
    const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
    const options = { host: '127.0.0.1', port: address.port, username: 'fixture', password: 'synthetic', hostKeyPins: [pin], staged: true, timeoutMs: 5000 };
    const source = join(dir, 'source'), target = join(dir, 'target'); const body = Buffer.from('verified staged payload\0'.repeat(100)); writeFileSync(source, body);
    const sha256 = createHash('sha256').update(body).digest('hex');
    const upload = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/final' });
    expect(upload).toMatchObject({ ok: true, bytes: body.length, verification: 'sha256_matched', finalized: true, sha256 });
    expect(files.get('/fixture/final')).toEqual(body);
    expect([...files.keys()]).toEqual(['/fixture/final']);
    const download = await runSftp({ ...options, direction: 'download', localPath: target, remotePath: '/fixture/final' });
    expect(download).toMatchObject({ ok: true, bytes: body.length, verification: 'sha256_matched', finalized: true, sha256 });
    expect(readFileSync(target)).toEqual(body);
    files.set('/fixture/existing', Buffer.from('old remote'));
    files.set('/fixture/.unrelated.mcp-other.part', Buffer.from('other owner'));
    const existingUpload = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/existing' });
    expect(existingUpload).toMatchObject({ ok: false, cleanup: 'removed' });
    expect(existingUpload.finalized).toBeUndefined(); // rejected extended request: no remote finalization proof
    expect(files.get('/fixture/existing')?.toString()).toBe('old remote');
    writeFileSync(target, 'old local');
    const existingDownload = await runSftp({ ...options, direction: 'download', localPath: target, remotePath: '/fixture/final' });
    expect(existingDownload).toMatchObject({ ok: false, finalized: false, cleanup: 'not_needed', verification: 'not_started' });
    expect(readFileSync(target, 'utf8')).toBe('old local');
    refuseWrite = true;
    const denied = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/denied' });
    refuseWrite = false;
    expect(denied).toMatchObject({ ok: false, finalized: false, cleanup: 'removed' });
    expect(files.has('/fixture/denied')).toBe(false);
    corruptRead = true;
    const mismatch = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/mismatch' });
    corruptRead = false;
    expect(mismatch).toMatchObject({ ok: false, verification: 'failed', finalized: false, cleanup: 'removed' });
    expect(files.has('/fixture/mismatch')).toBe(false);
    expect(files.get('/fixture/.unrelated.mcp-other.part')?.toString()).toBe('other owner');
    mutateSource = () => writeFileSync(source, Buffer.from('changed'.repeat(100)));
    const mutation = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/mutation' });
    expect(mutation).toMatchObject({ ok: false, verification: 'failed', finalized: false, cleanup: 'removed' });
    expect(files.has('/fixture/mutation')).toBe(false);
    writeFileSync(source, body);
    refuseHardlink = true;
    const unsupported = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/unsupported' });
    refuseHardlink = false;
    expect(unsupported).toMatchObject({ ok: false, cleanup: 'removed' });
    expect(unsupported.error).toMatch(/does not support|unsupported|hardlink/i);
    expect(files.has('/fixture/unsupported')).toBe(false);
    refuseRemove = true;
    const cleanupFailed = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/cleanup-failed' });
    refuseRemove = false;
    expect(cleanupFailed).toMatchObject({ ok: false, finalized: true, cleanup: 'failed' });
    expect(files.has('/fixture/cleanup-failed')).toBe(true);
    for (const key of [...files.keys()]) if (key.includes('.cleanup-failed.mcp-') && key.endsWith('.part')) files.delete(key);
    holdHardlink = true;
    const ambiguous = await runSftp({ ...options, timeoutMs: 200, direction: 'upload', localPath: source, remotePath: '/fixture/ambiguous' });
    holdHardlink = false;
    expect(ambiguous).toMatchObject({ ok: false, timedOut: true });
    expect(ambiguous.finalized).toBeUndefined();
    delayedLinks.length = 0;
    holdOpen = true;
    const pendingOpen = await runSftp({ ...options, timeoutMs: 200, direction: 'upload', localPath: source, remotePath: '/fixture/pending-open' });
    holdOpen = false;
    expect(pendingOpen).toMatchObject({ ok: false, timedOut: true, verification: 'not_started', finalized: false, cleanup: 'unknown' });
    expect([...files.keys()].some(key => key.includes('.pending-open.mcp-') && key.endsWith('.part'))).toBe(true);
    for (const respond of delayedOpens.splice(0)) { try { respond(); } catch { /* transport may already be closed */ } }
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(files.has('/fixture/pending-open')).toBe(false);
    createThenOpenError = true;
    const openError = await runSftp({ ...options, direction: 'upload', localPath: source, remotePath: '/fixture/open-error' });
    createThenOpenError = false;
    expect(openError).toMatchObject({ ok: false, verification: 'not_started', finalized: false, cleanup: 'unknown' });
    expect([...files.keys()].some(key => key.includes('.open-error.mcp-') && key.endsWith('.part'))).toBe(true);
    expect(files.has('/fixture/open-error')).toBe(false);
    loseAfterHardlink = true;
    const lost = await runSftp({ ...options, timeoutMs: 1000, direction: 'upload', localPath: source, remotePath: '/fixture/connection-lost' });
    loseAfterHardlink = false;
    expect(lost).toMatchObject({ ok: false, verification: 'sha256_matched', cleanup: 'unknown' });
    expect(lost.finalized).toBeUndefined();
    expect(files.get('/fixture/connection-lost')).toEqual(body);
    expect([...files.keys()].some(key => key.includes('.connection-lost.mcp-') && key.endsWith('.part'))).toBe(true);
    holdRead = true;
    const late = await runSftp({ ...options, timeoutMs: 200, direction: 'upload', localPath: source, remotePath: '/fixture/late' });
    expect(late).toMatchObject({ ok: false, timedOut: true, finalized: false });
    holdRead = false; for (const respond of delayedReads.splice(0)) respond();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(files.has('/fixture/late')).toBe(false);
    // Keep the timed-out download last so teardown must drain its local work.
    holdLocalClose = gateClose;
    holdDownloadRead = true;
    const downloadTimeout = await runSftp({ ...options, timeoutMs: 200, direction: 'download', localPath: join(dir, 'held-download'), remotePath: '/fixture/final' });
    expect(downloadTimeout, downloadTimeout.error).toMatchObject({ ok: false, timedOut: true, verification: 'not_started', finalized: false, cleanup: 'unknown' });
    expect(readdirSync(dir).some(name => name.startsWith('.held-download.mcp-') && name.endsWith('.part'))).toBe(true);
    holdDownloadRead = false;
    for (const respond of delayedReads.splice(0)) { try { respond(); } catch { /* closed channel */ } }
    scenarioSucceeded = true;
  } finally {
    try {
      for (const client of connections) client.end();
      if (server?.listening) await bounded(new Promise<void>((resolve, reject) => {
        server!.close(error => error ? reject(error) : resolve());
      }), 'server close');
      if (scenarioSucceeded && gateClose) {
        await bounded(closeRequested, 'held local close request');
        expect(localClosed).toBe(false);
        expect(fs.fstatSync(heldFd!).isFile()).toBe(true);
      }
    } finally {
      // An armed interceptor is not proof that the scenario reached the gate.
      holdLocalClose = false;
      releaseClose?.();
      // The iterator also drains writes queued by callbacks during shutdown.
      await bounded((async () => { for (const work of localWork) await work; })(), 'local filesystem drain');
    }
    expect(closeErrors).toEqual([]);
    expect(descriptors.size).toBe(0);
    if (heldFd !== undefined) {
      expect(localClosed).toBe(true);
      expect(() => fs.fstatSync(heldFd!)).toThrow(/EBADF/);
    }
    expect(existsSync(join(dir, 'held-download'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }
  } finally {
    for (const restore of restoreSpies.reverse()) restore();
  }
}

it.each([
  { name: 'uploads with advertised hardlink, verifies readback, then downloads without replacement', gateClose: false },
  { name: 'drains a timed-out download after server close before removing local files', gateClose: true },
])('$name', async ({ gateClose }) => {
  await stagedScenario(gateClose);
}, 20000);


it.each(['local open', 'setup'] as const)('restores filesystem spies and preserves a %s failure promptly', async failure => {
  const original = { open: fs.open, write: fs.write, close: fs.close };
  const error = Object.assign(new Error(`injected ${failure} failure`), { code: 'ENOSPC' });
  const scenario = stagedScenario(true, failure === 'local open' ? { localOpenError: error } : { setupError: error });
  try {
    // This deadline is shorter than Vitest's timeout, and makes a hung teardown fail explicitly.
    await expect(bounded(scenario, 'failure-path scenario', 8000)).rejects.toThrow(error.message);
  } finally {
    expect(fs.open).toBe(original.open);
    expect(fs.write).toBe(original.write);
    expect(fs.close).toBe(original.close);
  }
}, 10000);

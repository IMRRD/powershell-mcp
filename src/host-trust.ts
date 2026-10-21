import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { utils } = createRequire(import.meta.url)('ssh2') as typeof import('ssh2');

export interface HostTrustOptions { host: string; port?: number; hostKeyPins?: string[]; knownHostsPath?: string }
export type HostTrustFailure = 'host trust missing' | 'host key mismatch' | 'invalid host key pin' | 'invalid known hosts';
const pinPattern = /^SHA256:([A-Za-z0-9+/]{43})$/;

/** Prepare the policy before opening a socket. Never derive trust from the peer. */
export function hostTrust(options: HostTrustOptions): { hostVerifier: (key: Buffer) => boolean; failure: () => HostTrustFailure } {
  let failure: HostTrustFailure = 'host trust missing';
  const pins = options.hostKeyPins ?? [];
  if (!Array.isArray(pins) || pins.some(pin => typeof pin !== 'string' || !pinPattern.test(pin) ||
    Buffer.from(pin.slice(7), 'base64').length !== 32 || Buffer.from(pin.slice(7), 'base64').toString('base64').replace(/=+$/, '') !== pin.slice(7))) {
    throw Error('invalid host key pin');
  }
  const host = options.host;
  const port = options.port ?? 22;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('invalid host identity');
  const identity = port === 22 ? host : `[${host}]:${port}`;
  const keys: Buffer[] = [];
  if (options.knownHostsPath) {
    let contents: string;
    try { contents = readFileSync(options.knownHostsPath, 'utf8'); } catch { throw Error('invalid known hosts'); }
    if (contents.length > 1_048_576) throw Error('invalid known hosts');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const fields = trimmed.split(/\s+/);
      // Reject markers and hashed/wildcard identities instead of interpreting them approximately.
      if (fields.length !== 3 || fields[0].startsWith('@') || fields[0].startsWith('|') ||
        fields[0].includes('*') || fields[0].includes('?') || fields[0].includes('!') ||
        fields[0].includes(',') || !/^[A-Za-z0-9._:\[\]-]+$/.test(fields[0])) throw Error('invalid known hosts');
      const data = Buffer.from(fields[2], 'base64');
      if (!data.length || data.toString('base64') !== fields[2]) throw Error('invalid known hosts');
      const parsed = utils.parseKey(data);
      if (parsed instanceof Error || parsed.type !== fields[1] || !parsed.getPublicSSH().equals(data)) throw Error('invalid known hosts');
      if (fields[0] === identity) keys.push(data);
    }
  }
  return {
    failure: () => failure,
    hostVerifier: (key: Buffer) => {
      if (!keys.length && !pins.length) { failure = 'host trust missing'; return false; }
      const presented = utils.parseKey(key);
      if (presented instanceof Error || presented.type.includes('-cert-')) { failure = 'host key mismatch'; return false; }
      const digest = createHash('sha256').update(key).digest();
      const match = keys.some(expected => expected.length === key.length && timingSafeEqual(expected, key)) ||
        pins.some(pin => timingSafeEqual(Buffer.from(pin.slice(7), 'base64'), digest));
      if (!match) failure = 'host key mismatch';
      return match;
    },
  };
}

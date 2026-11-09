import { WINRM_REASONS, type WinRmReason } from './winrm-reason.js';
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type Transport = "ssh" | "sftp" | "winrm";
export interface CredentialScope { transport: Transport; host: string; port: number; principal: string }
/** Nonsecret operator configuration. The PSCredential exists only in the invoking PowerShell child. */
export interface ProtectedWinRmCredential extends CredentialScope { loaderPath: string; sha256: string }
export interface StoredCredential extends CredentialScope { password?: string; passphrase?: string; privateKey?: string; protectedCredential?: ProtectedWinRmCredential }
export interface CredentialProvider { resolve(ref: string, scope?: CredentialScope): Promise<StoredCredential | undefined> }
export interface CredentialRequest extends CredentialScope {
  credentialRef?: string; password?: string; passphrase?: string; privateKeyPath?: string; username?: string;
}
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The provider is never queried for mixed authentication, and scope is checked before returning secrets. */
export async function resolveCredential(request: CredentialRequest, provider?: CredentialProvider): Promise<Pick<StoredCredential, "password" | "passphrase" | "privateKey" | "protectedCredential">> {
  if (request.credentialRef === undefined) return {};
  if (request.password !== undefined || request.passphrase !== undefined || request.privateKeyPath !== undefined || (request.transport === "winrm" && request.username !== undefined && request.username !== request.principal)) throw Error("Mixed credential authentication is not allowed");
  if (request.transport === "winrm" && !request.principal) throw Error("Credential principal required");
  if (!referencePattern.test(request.credentialRef)) throw Error("Invalid credential reference");
  try {
    const value = await provider?.resolve(request.credentialRef, request);
    if (!value) throw Error("missing");
    if (value.transport !== request.transport || value.host !== request.host || value.port !== request.port || value.principal !== request.principal) throw Error("scope");
    if ([value.password, value.privateKey, value.protectedCredential].filter(v => v !== undefined).length !== 1) throw Error("invalid auth");
    if (value.protectedCredential !== undefined && (value.transport !== 'winrm' || value.passphrase !== undefined || !validProtectedCredential(value.protectedCredential) || !sameScope(value, value.protectedCredential))) throw Error('invalid auth');
    if (value.transport === "winrm" && (value.privateKey !== undefined || value.passphrase !== undefined)) throw Error("invalid auth");
    return { ...(value.protectedCredential !== undefined ? { protectedCredential: value.protectedCredential } : {}), ...(value.password !== undefined ? { password: value.password } : {}), ...(value.privateKey !== undefined ? { privateKey: value.privateKey } : {}), ...(value.passphrase !== undefined ? { passphrase: value.passphrase } : {}) };
  } catch (e) {
    if (e instanceof Error && e.message === "scope") throw Error("Credential scope mismatch");
    throw Error("Credential reference unavailable");
  }
}

function sameScope(a: CredentialScope, b: CredentialScope): boolean {
  return a.transport === b.transport && a.host === b.host && a.port === b.port && a.principal === b.principal;
}
export function validProtectedCredential(value: ProtectedWinRmCredential): boolean {
  return !!value && typeof value === 'object' && Object.keys(value).length === 6 &&
    value.transport === 'winrm' && typeof value.host === 'string' && !!value.host && [5985, 5986].includes(value.port) &&
    typeof value.principal === 'string' && !!value.principal && typeof value.loaderPath === 'string' &&
    /^[A-Za-z]:[\\/]/.test(value.loaderPath) && !/[\x00-\x1f:]/.test(value.loaderPath.slice(2)) &&
    typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256);
}

/** A WinRM map is authoritative when configured: missing/invalid entries never fall back to DPAPI or ambient auth. */
function mappedWinRmCredential(path: string, pin: string | undefined, ref: string): StoredCredential | undefined {
  if (!referencePattern.test(ref) || !isAbsolute(path) || !pin || !/^[0-9a-f]{64}$/.test(pin)) return undefined;
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) return undefined;
    const bytes = Buffer.alloc(stat.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== stat.size || createHash('sha256').update(bytes.subarray(0, count)).digest('hex') !== pin) return undefined;
    const map = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.hasOwn(map, ref) || !validProtectedCredential(map[ref])) return undefined;
    const entry: ProtectedWinRmCredential = map[ref];
    return { transport: entry.transport, host: entry.host, port: entry.port, principal: entry.principal, protectedCredential: entry };
  } finally { closeSync(fd); }
}

/** Operator-configured directory only; never treat a reference as a path. Files are DPAPI CurrentUser blobs. */
export class WindowsProtectedFileProvider implements CredentialProvider {
  constructor(private readonly directory: string) {}
  async resolve(ref: string): Promise<StoredCredential | undefined> {
    if (process.platform !== "win32" || !referencePattern.test(ref) || !this.directory) return undefined;
    const name = createHash("sha256").update(ref).digest("hex") + ".dpapi";
    try {
      const script = join(import.meta.dirname, "..", "scripts", "read-credential.ps1");
      const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Directory", this.directory, "-Name", name], { encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true });
      if (child.status !== 0 || child.error) return undefined;
      const value: unknown = JSON.parse(child.stdout);
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some(k => !["transport", "host", "port", "principal", "password", "passphrase", "privateKey"].includes(k)) ||
          !["ssh", "sftp", "winrm"].includes(String(record.transport)) || typeof record.host !== "string" || typeof record.port !== "number" || typeof record.principal !== "string" ||
          ["password", "passphrase", "privateKey"].some(k => record[k] !== undefined && (typeof record[k] !== "string" || (record[k] as string).length > 16384))) return undefined;
      return record as unknown as StoredCredential;
    } catch { return undefined; }
  }
}
/** Best-effort exact known-value redaction; arbitrary remote transformations cannot be detected. */
export function sanitizeCredentialResult<T>(result: T, auth: Pick<StoredCredential, "password" | "passphrase" | "privateKey">): T {
  const tokens = [auth.password, auth.passphrase, auth.privateKey].filter((s): s is string => !!s);
  const variants = [...new Set(tokens.flatMap(s => [s, Buffer.from(s).toString("base64"), Buffer.from(s, "utf16le").toString("base64")]))].sort((a, b) => b.length - a.length);
  const pattern = variants.length ? new RegExp(variants.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g") : undefined;
  const statuses = new Set(["completed", "remote_error", "transport_error", "cancelled", "timeout", "unknown", "nonzero_exit", "script_error"]);
  function scrub(value: unknown, root = false): unknown {
    if (typeof value === "string") return pattern ? value.replace(pattern, "[REDACTED]") : value;
    if (Array.isArray(value)) return value.map(v => scrub(v));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "log").map(([k, v]) => {
      // Only root adapter metadata is structural. Nested remote fields remain untrusted text.
      if (root && k === "invocationStatus") return [k, typeof v === "string" && ["completed", "remote_error", "transport_error"].includes(v) ? v : "transport_error"];
      if (root && k === 'winrmReason') return [k, WINRM_REASONS.includes(v as WinRmReason) ? v : 'unknown'];
      if (root && k === "status" && typeof v === "string" && statuses.has(v)) return [k, v];
      return [k, scrub(v)];
    }));
    return value;
  }
  return scrub(result, true) as T;
}

export function configuredProvider(): CredentialProvider | undefined {
  const directory = process.env.POWERSHELL_MCP_CREDENTIAL_DIR;
  const map = process.env.POWERSHELL_MCP_WINRM_CREDENTIAL_MAP;
  const mapPin = process.env.POWERSHELL_MCP_WINRM_CREDENTIAL_MAP_SHA256;
  if (process.platform !== 'win32') return undefined;
  const disk = directory ? new WindowsProtectedFileProvider(directory) : undefined;
  return map ? { resolve: async (ref, scope) => scope?.transport === 'winrm' ? mappedWinRmCredential(map, mapPin, ref) : disk?.resolve(ref) } : disk;
}

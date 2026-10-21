import { createHash } from "node:crypto";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type Transport = "ssh" | "sftp" | "winrm";
export interface CredentialScope { transport: Transport; host: string; port: number; principal: string }
export interface StoredCredential extends CredentialScope { password?: string; passphrase?: string; privateKey?: string }
export interface CredentialProvider { resolve(ref: string): Promise<StoredCredential | undefined> }
export interface CredentialRequest extends CredentialScope {
  credentialRef?: string; password?: string; passphrase?: string; privateKeyPath?: string; username?: string;
}
const referencePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The provider is never queried for mixed authentication, and scope is checked before returning secrets. */
export async function resolveCredential(request: CredentialRequest, provider?: CredentialProvider): Promise<Pick<StoredCredential, "password" | "passphrase" | "privateKey">> {
  if (request.credentialRef === undefined) return {};
  if (request.password !== undefined || request.passphrase !== undefined || request.privateKeyPath !== undefined || (request.transport === "winrm" && request.username !== undefined && request.username !== request.principal)) throw Error("Mixed credential authentication is not allowed");
  if (request.transport === "winrm" && !request.principal) throw Error("Credential principal required");
  if (!referencePattern.test(request.credentialRef)) throw Error("Invalid credential reference");
  try {
    const value = await provider?.resolve(request.credentialRef);
    if (!value) throw Error("missing");
    if (value.transport !== request.transport || value.host !== request.host || value.port !== request.port || value.principal !== request.principal) throw Error("scope");
    if ((value.password === undefined) === (value.privateKey === undefined)) throw Error("invalid auth");
    if (value.transport === "winrm" && (value.privateKey !== undefined || value.passphrase !== undefined)) throw Error("invalid auth");
    return { ...(value.password !== undefined ? { password: value.password } : {}), ...(value.privateKey !== undefined ? { privateKey: value.privateKey } : {}), ...(value.passphrase !== undefined ? { passphrase: value.passphrase } : {}) };
  } catch (e) {
    if (e instanceof Error && e.message === "scope") throw Error("Credential scope mismatch");
    throw Error("Credential reference unavailable");
  }
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
      if (root && k === "status" && typeof v === "string" && statuses.has(v)) return [k, v];
      return [k, scrub(v)];
    }));
    return value;
  }
  return scrub(result, true) as T;
}

export function configuredProvider(): CredentialProvider | undefined {
  const directory = process.env.POWERSHELL_MCP_CREDENTIAL_DIR;
  return directory && process.platform === "win32" ? new WindowsProtectedFileProvider(directory) : undefined;
}

import { describe, it, expect, vi } from "vitest";
import { resolveCredential, sanitizeCredentialResult, WindowsProtectedFileProvider, type CredentialProvider } from "../src/credentials.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromProcess } from "../src/result.js";
import type { PsResult } from "../src/powershell.js";

const secret = "SYNTHETIC-CREDENTIAL-DO-NOT-LEAK";
const provider: CredentialProvider = { resolve: vi.fn(async () => ({ transport: "ssh", host: "example.invalid", port: 22, principal: "robot", password: secret })) };
const scope = { transport: "ssh" as const, host: "example.invalid", port: 22, principal: "robot" };

describe("scoped credential references", () => {
  it("resolves a matching reference into transport authentication", async () => {
    expect(await resolveCredential({ credentialRef: "robot-prod", ...scope }, provider)).toEqual({ password: secret });
  });
  it("rejects mixed raw authentication before calling provider", async () => {
    const spy = vi.fn();
    await expect(resolveCredential({ credentialRef: "robot-prod", password: "raw", ...scope }, { resolve: spy })).rejects.toThrow(/mixed/i);
    expect(spy).not.toHaveBeenCalled();
  });
  it("rejects target and principal mismatches without disclosing provider values", async () => {
    for (const change of [{ host: "other.invalid" }, { transport: "sftp" as const }, { principal: "other" }, { port: 2222 }]) {
      await expect(resolveCredential({ credentialRef: "robot-prod", ...scope, ...change }, provider)).rejects.toThrow(/scope/i);
    }
  });
  it("uses generic diagnostics for missing, denied and failing providers", async () => {
    for (const failure of [undefined, new Error(secret)]) {
      const bad: CredentialProvider = { resolve: async () => { if (failure) throw failure; return undefined; } };
      await expect(resolveCredential({ credentialRef: "robot-prod", ...scope }, bad)).rejects.toThrow("Credential reference unavailable");
    }
  });
  it("rejects invalid opaque identifiers before provider access", async () => {
    await expect(resolveCredential({ credentialRef: "../secret", ...scope }, provider)).rejects.toThrow(/invalid/i);
  });
  it("scrubs synthetic secrets from success, failure and cancellation diagnostics", () => {
    for (const status of ["completed", "transport_error", "cancelled"]) {
      const result = { status, stdout: secret, stderr: `failed ${secret}`, error: secret,
        stdoutCapture: { text: secret }, errorRecords: [{ message: secret }], log: { handle: secret } };
      expect(JSON.stringify(sanitizeCredentialResult(result, { password: secret }))).not.toContain(secret);
    }
  });
  it("redacts short and overlapping secrets only inside string values", () => {
    const result = { status: "completed", exitCode: 123, nested: [{ text: "abc ab a YWJj YWI= YQ==" }] };
    const scrubbed = sanitizeCredentialResult(result, { password: "abc", passphrase: "ab", privateKey: "a" });
    expect(scrubbed.status).toBe("completed");
    expect(scrubbed.exitCode).toBe(123);
    expect(scrubbed.nested[0].text).toBe("[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]");
  });
  it("retains WinRM transport classification while redacting captured text", () => {
    const raw: PsResult = { stdout: "a YQ==", stderr: "failure a", exitCode: 1, durationMs: 3, timedOut: false,
      truncated: false, invocationStatus: "transport_error", stdoutCapture: { text: "a", observedBytes: 1, capturedBytes: 1, omittedBytes: 0, truncated: false } };
    const safe = sanitizeCredentialResult(raw, { password: "a" });
    expect(fromProcess(safe, "winrm", "fixture").terminationStatus).toBe("transport_error");
    expect(safe.stdout).toBe("[REDACTED] [REDACTED]");
    expect(safe.stdoutCapture).toMatchObject({ text: "[REDACTED]", capturedBytes: 1 });
  });
  it("preserves validated cancellation metadata but never trusts an invalid status", () => {
    expect(sanitizeCredentialResult({ status: "cancelled", nested: { message: "a" } }, { password: "a" })).toEqual({ status: "cancelled", nested: { message: "[REDACTED]" } });
    expect(sanitizeCredentialResult({ status: "cancelled-a" }, { password: "a" }).status).not.toContain("a");
    expect(sanitizeCredentialResult({ invocationStatus: "transport_error-a", stdout: "a" }, { password: "a" }).invocationStatus).toBe("transport_error");
  });
  it.skipIf(process.platform !== "win32")("roundtrips a synthetic CurrentUser DPAPI entry through operator provisioning", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mcp-dpapi-"));
    const directory = join(parent, "private-store");
    try {
      const script = join(process.cwd(), "scripts", "provision-credential.ps1");
      const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Directory", directory, "-Reference", "synthetic-test"],
        { input: JSON.stringify({ ...scope, password: secret }), encoding: "utf8", timeout: 15000, windowsHide: true });
      expect(child.status, child.stderr).toBe(0);
      const diskProvider = new WindowsProtectedFileProvider(directory);
      expect(await resolveCredential({ ...scope, credentialRef: "synthetic-test" }, diskProvider)).toEqual({ password: secret });
      const duplicate = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Directory", directory, "-Reference", "synthetic-test"],
        { input: JSON.stringify({ ...scope, password: "replacement" }), encoding: "utf8", timeout: 15000, windowsHide: true });
      expect(duplicate.status).not.toBe(0);
      expect(await resolveCredential({ ...scope, credentialRef: "synthetic-test" }, diskProvider)).toEqual({ password: secret });
      await expect(resolveCredential({ ...scope, host: "different.invalid", credentialRef: "synthetic-test" }, diskProvider)).rejects.toThrow(/scope/i);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30000);
  it.skipIf(process.platform !== "win32")("refuses an inherited or broadly writable existing store without altering its ACL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mcp-unsafe-"));
    try {
      const script = join(process.cwd(), "scripts", "provision-credential.ps1");
      const snapshotAcl = () => {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop; (Get-Acl -LiteralPath ([Console]::In.ReadToEnd())).Sddl"],
          { input: directory, encoding: "utf8", timeout: 10000, windowsHide: true });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout.trim()).toMatch(/^O:[^\s]+G:[^\s]+D:/);
        return result.stdout.trim();
      };
      const before = snapshotAcl();
      const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script, "-Directory", directory, "-Reference", "synthetic-test"], { input: JSON.stringify({ ...scope, password: secret }), encoding: "utf8", timeout: 15000 });
      expect(child.status).not.toBe(0);
      const after = snapshotAcl();
      expect(after).toBe(before);
      await expect(resolveCredential({ ...scope, credentialRef: "synthetic-test" }, new WindowsProtectedFileProvider(directory))).rejects.toThrow(/unavailable/i);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 30000);
  it.skipIf(process.platform !== "win32")("rejects a scratch junction root and pins its ancestry against replacement", async () => {
    const parent = mkdtempSync(join(tmpdir(), "mcp-junction-"));
    const destination = join(parent, "destination");
    const alias = join(parent, "alias");
    try {
      mkdirSync(destination);
      const mklink = spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", alias, destination], { encoding: "utf8" });
      expect(mklink.status, mklink.stderr).toBe(0);
      const provision = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(process.cwd(), "scripts", "provision-credential.ps1"), "-Directory", alias, "-Reference", "synthetic-test"], { input: JSON.stringify({ ...scope, password: secret }), encoding: "utf8", timeout: 15000 });
      expect(provision.status).not.toBe(0);
      await expect(resolveCredential({ ...scope, credentialRef: "synthetic-test" }, new WindowsProtectedFileProvider(alias))).rejects.toThrow(/unavailable/i);
      const safeStore = join(destination, "private-store");
      const setup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", join(process.cwd(), "scripts", "provision-credential.ps1"), "-Directory", safeStore, "-Reference", "pin-test"], { input: JSON.stringify({ ...scope, password: secret }), encoding: "utf8", timeout: 15000 });
      expect(setup.status, setup.stderr).toBe(0);
      const replacement = `${parent}-renamed`;
      const script = `Add-Type -Path '${join(process.cwd(), "scripts", "ProtectedCredentialStore.cs").replaceAll("'", "''")}'; $ErrorActionPreference='Stop'; $s=New-Object ProtectedCredentialStore('${safeStore.replaceAll("'", "''")}', $false); try { Rename-Item -LiteralPath '${parent.replaceAll("'", "''")}' -NewName '${replacement.split(/[\\/]/).at(-1)}' -ErrorAction Stop; exit 2 } catch { if ($_.Exception.Message -notmatch 'denied|being used' -or -not (Test-Path -LiteralPath '${parent.replaceAll("'", "''")}') -or (Test-Path -LiteralPath '${replacement.replaceAll("'", "''")}')) { exit 3 } } finally { $s.Dispose() }; exit 0`;
      const pinned = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 15000 });
      expect(pinned.status, pinned.stderr).toBe(0);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  }, 30000);
  it("preserves legacy modes without provider", async () => {
    expect(await resolveCredential({ ...scope, privateKeyPath: "key", passphrase: "raw" }, provider)).toEqual({});
    expect(await resolveCredential({ transport: "winrm", host: "example.invalid", port: 5985, principal: "", }, provider)).toEqual({});
  });
});

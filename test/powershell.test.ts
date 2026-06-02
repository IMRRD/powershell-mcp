import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import os from "node:os";
import { resolvePowerShellExe, buildArgs, runPowerShell } from "../src/powershell.js";
import { formatResult } from "../src/format.js";

// Detect whether a PowerShell is available so integration tests can run
// locally / in CI on Windows, and be skipped on machines without it.
function detectPwsh(): string | null {
  for (const exe of ["pwsh", os.platform() === "win32" ? "powershell.exe" : ""]) {
    if (!exe) continue;
    try {
      execSync(`${exe} -NoProfile -Command "$PSVersionTable.PSVersion.Major"`, {
        stdio: "ignore",
        timeout: 15_000,
      });
      return exe;
    } catch { /* not available */ }
  }
  return null;
}
const PWSH = detectPwsh();

describe("resolvePowerShellExe", () => {
  const orig = process.env.PWSH_MCP_EXE;
  afterEach(() => {
    if (orig === undefined) delete process.env.PWSH_MCP_EXE;
    else process.env.PWSH_MCP_EXE = orig;
  });

  it("uses an explicit override first", () => {
    expect(resolvePowerShellExe("/custom/pwsh")).toBe("/custom/pwsh");
  });
  it("falls back to the PWSH_MCP_EXE env var", () => {
    delete process.env.PWSH_MCP_EXE;
    process.env.PWSH_MCP_EXE = "myshell";
    expect(resolvePowerShellExe()).toBe("myshell");
  });
  it("defaults to a platform-appropriate shell", () => {
    delete process.env.PWSH_MCP_EXE;
    const def = resolvePowerShellExe();
    expect(["pwsh", "powershell.exe"]).toContain(def);
  });
});

describe("buildArgs", () => {
  it("runs non-interactively, no profile, bypass policy, via -Command", () => {
    const args = buildArgs("Get-Date");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-Date",
    ]);
  });
});

describe("formatResult", () => {
  it("includes exit code, shell, duration and stdout", () => {
    const text = formatResult({
      stdout: "hello", stderr: "", exitCode: 0, timedOut: false,
      durationMs: 12, shell: "pwsh", truncated: false,
    });
    expect(text).toContain("exit_code: 0");
    expect(text).toContain("shell: pwsh");
    expect(text).toContain("hello");
  });
  it("marks timeouts and truncation, and notes no output", () => {
    const text = formatResult({
      stdout: "", stderr: "", exitCode: null, timedOut: true,
      durationMs: 60000, shell: "pwsh", truncated: true,
    });
    expect(text).toContain("TIMED OUT");
    expect(text).toContain("[output truncated]");
    expect(text).toContain("(no output)");
  });
});

describe.skipIf(!PWSH)("runPowerShell (integration)", () => {
  it("captures stdout and a zero exit code", async () => {
    const r = await runPowerShell("Write-Output 'hello-mcp'", { exe: PWSH! });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hello-mcp");
    expect(r.timedOut).toBe(false);
  });
  it("reports a non-zero exit code without throwing", async () => {
    const r = await runPowerShell("exit 3", { exe: PWSH! });
    expect(r.exitCode).toBe(3);
  });
  it("enforces the timeout and flags timedOut", async () => {
    const r = await runPowerShell("Start-Sleep -Seconds 30", { exe: PWSH!, timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
  }, 20_000);
});

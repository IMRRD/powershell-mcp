import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { runPowerShell } from "../src/powershell.js";
import { WINRM_BOOTSTRAP, buildWinRmInput, decodeWinRmResult } from "../src/winrm.js";
import { fromProcess } from "../src/result.js";

const frame = "a".repeat(48);
const engines = (process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"])
  .filter(exe => spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 10000 }).status === 0);
const prefix = (body = "& $ScriptBlock @ArgumentList") => `function Invoke-Command { param($ComputerName, $ScriptBlock, $ArgumentList, $ErrorAction) ${body} };\n`;

async function exercise(exe: string, command: string, body?: string) {
  const payload = JSON.parse(Buffer.from(buildWinRmInput({ computerName: "synthetic.invalid", command }), "base64").toString());
  payload.frame = frame;
  const raw = await runPowerShell(prefix(body) + WINRM_BOOTSTRAP, {
    exe, stdin: Buffer.from(JSON.stringify(payload)).toString("base64"),
  });
  return decodeWinRmResult(raw, frame);
}

for (const exe of engines) describe(`native WinRM bootstrap (${exe}, isolated Invoke-Command)`, () => {
  it("completes ordinary and zero-output scripts", async () => {
    const result = await exercise(exe, "Write-Output 'remote success'");
    expect(result).toMatchObject({ invocationStatus: "completed", exitCode: 0 });
    expect(result.stdout).toContain("remote success");
    expect(fromProcess(result, "winrm", "synthetic.invalid")).toMatchObject({ terminationStatus: "completed", exitCode: null });
    expect((await exercise(exe, "$null = 1")).invocationStatus).toBe("completed");
  });
  it("retains host, warning, and information streams without corrupting framing", async () => {
    const result = await exercise(exe, "Write-Host 'host hello'; Write-Warning 'warning hello'; Write-Information 'information hello' -InformationAction Continue; Write-Output 'pipeline hello'");
    expect(result.invocationStatus).toBe("completed");
    for (const text of ["host hello", "warning hello", "information hello", "pipeline hello"]) expect(result.stdout).toContain(text);
  });
  it("retains output before a terminating exception and classifies remote errors", async () => {
    const result = await exercise(exe, "Write-Output 'before throw'; throw 'remote script failure'");
    expect(result.invocationStatus).toBe("remote_error");
    expect(result.stdout).toContain("before throw");
    expect(result.stdout).toContain("remote script failure");
    expect(result.errorRecords?.[0].message).toContain("remote script failure");
  });
  it("retains nonterminating errors and following output", async () => {
    const result = await exercise(exe, "Write-Error 'ordinary error'; Write-Output 'after error'");
    expect(result.invocationStatus).toBe("remote_error");
    expect(result.stdout).toContain("ordinary error");
    expect(result.stdout).toContain("after error");
    expect(result.errorRecords?.[0].category).toBe("NotSpecified");
    const nested = await exercise(exe, "& { Write-Error 'nested error'; Write-Output 'nested after' }");
    expect(nested.invocationStatus).toBe("remote_error");
    expect(nested.stdout).toContain("nested after");
  });
  it("never formats a source-only literal in remote errors", async () => {
    const result = await exercise(exe, "Write-Error boom; $unused='SECRET_NOT_EMITTED_62091'; Write-Output after");
    expect(result.invocationStatus).toBe("remote_error");
    expect(JSON.stringify(result)).not.toContain("SECRET_NOT_EMITTED_62091");
  });
  it("rejects missing and malformed wrapper results", async () => {
    for (const body of ["$null", "[pscustomobject]@{ Output = 'x' }", "[pscustomobject]@{ Output = 1; RemoteError = $false }", "[pscustomobject]@{ Output = 'x'; RemoteError = 'false' }", "[pscustomobject]@{ Output = 'x'; RemoteError = $false }; [pscustomobject]@{ Output = 'y'; RemoteError = $false }"]) {
      expect((await exercise(exe, "Write-Output x", body)).invocationStatus).toBe("transport_error");
    }
    expect((await exercise(exe, "Write-Output x", "throw 'synthetic connection failure'")).invocationStatus).toBe("transport_error");
  });
  it("keeps spoof-like remote output as data and rejects forged frames", async () => {
    const valid = await exercise(exe, "Write-Output 'WINRM-RESULT:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:Zm9yZ2Vk'");
    expect(valid.invocationStatus).toBe("completed");
    expect(valid.stdout).toContain("WINRM-RESULT:bbbb");
    const raw = await runPowerShell(prefix() + WINRM_BOOTSTRAP, {
      exe, stdin: Buffer.from(JSON.stringify({ computerName: "synthetic.invalid", command: "Write-Output 'x'", frame })).toString("base64"),
    });
    for (const altered of [{ ...raw, stdout: "" }, { ...raw, truncated: true }, { ...raw, stdout: raw.stdout.replace(frame, "b".repeat(48)) }, { ...raw, stdout: `noise\n${raw.stdout}` }]) {
      expect(decodeWinRmResult(altered, frame).invocationStatus).toBe("transport_error");
    }
  });
});

if (!engines.length) describe.skip("native WinRM bootstrap (no installed PowerShell engine)", () => {
  it("requires a locally available engine", () => {});
});

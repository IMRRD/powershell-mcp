import { selectIntegrationEngines } from "./integration-engine.js";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { runPowerShell } from "../src/powershell.js";
import { WINRM_BOOTSTRAP, buildWinRmInput, decodeWinRmResult } from "../src/winrm.js";
import { fromProcess } from "../src/result.js";

const frame = "a".repeat(48);
const engines = selectIntegrationEngines().map(engine => engine.exe);
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
  it("completes ordinary scripts", async () => {
    const result = await exercise(exe, "Write-Output 'remote success'");
    expect(result).toMatchObject({ invocationStatus: "completed", exitCode: 0 });
    expect(result.stdout).toContain("remote success");
    expect(fromProcess(result, "winrm", "synthetic.invalid")).toMatchObject({ terminationStatus: "completed", exitCode: null });
  });
  it("completes zero-output scripts", async () => {
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
  });
  it("retains output following nested nonterminating errors", async () => {
    const nested = await exercise(exe, "& { Write-Error 'nested error'; Write-Output 'nested after' }");
    expect(nested.invocationStatus).toBe("remote_error");
    expect(nested.stdout).toContain("nested after");
  });
  it("never formats a source-only literal in remote errors", async () => {
    const result = await exercise(exe, "Write-Error boom; $unused='SECRET_NOT_EMITTED_62091'; Write-Output after");
    expect(result.invocationStatus).toBe("remote_error");
    expect(JSON.stringify(result)).not.toContain("SECRET_NOT_EMITTED_62091");
  });
  it.each([
    "$null",
    "[pscustomobject]@{ Output = 'x' }",
    "[pscustomobject]@{ Output = 1; RemoteError = $false }",
    "[pscustomobject]@{ Output = 'x'; RemoteError = 'false' }",
    "[pscustomobject]@{ Output = 'x'; RemoteError = $false }; [pscustomobject]@{ Output = 'y'; RemoteError = $false }",
  ])("rejects invalid wrapper result: %s", async (body) => {
    expect((await exercise(exe, "Write-Output x", body)).invocationStatus).toBe("transport_error");
  });
  it("reports connection failure", async () => {
    expect((await exercise(exe, "Write-Output x", "throw 'synthetic connection failure'")).invocationStatus).toBe("transport_error");
  });
  it.each([
    ["throw [System.Security.Authentication.AuthenticationException]::new('PRIVATE')", 'authentication_exception'],
    ["throw [System.UnauthorizedAccessException]::new('PRIVATE')", 'access_exception'],
    ["throw [System.Management.Automation.Remoting.PSRemotingTransportException]::new('PRIVATE endpoint auth access')", 'remoting_transport_exception'],
    ["throw 'PRIVATE authentication access endpoint'", 'invoke_exception'],
    ["$null", 'wrapper_result_invalid'],
  ])('classifies typed local invocation boundary: %s', async (body, reason) => {
    const result = await exercise(exe, 'Write-Output x', body);
    expect(result).toMatchObject({ invocationStatus: 'transport_error', winrmReason: reason });
  });
  it('records a remote script error boundary', async () => {
    const script = await exercise(exe, "throw 'PRIVATE'");
    expect(script.winrmReason).toBe('remote_script_error');
  });
  it('does not invent a remote native exit code for unchecked nonzero exit', async () => {
    const native = await exercise(exe, process.platform === 'win32' ? "& $env:ComSpec /d /c 'exit /b 7'; Write-Output after" : "& /bin/sh -c 'exit 7'; Write-Output after");
    expect(native).toMatchObject({ invocationStatus: 'completed', winrmReason: 'completed' });
    expect(fromProcess(native, 'winrm', 'synthetic.invalid').exitCode).toBeNull();
  });
  it('preserves the legacy remote ErrorRecord policy for redirected native stderr', async () => {
    const native = await exercise(exe, process.platform === 'win32' ? "& $env:ComSpec /d /c 'echo native-stderr 1>&2 & exit /b 7'; Write-Output after" : "& /bin/sh -c 'echo native-stderr >&2; exit 7'; Write-Output after");
    expect(native).toMatchObject({ invocationStatus: 'remote_error', winrmReason: 'remote_script_error' });
    expect(native.stdout).toContain('after');
    expect(native.errorRecords?.[0].fullyQualifiedErrorId).toBe('NativeCommandError');
  });
  it("keeps spoof-like remote output as data", async () => {
    const valid = await exercise(exe, "Write-Output 'WINRM-RESULT:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:Zm9yZ2Vk'");
    expect(valid.invocationStatus).toBe("completed");
    expect(valid.stdout).toContain("WINRM-RESULT:bbbb");
  });
  it("rejects forged frames", async () => {
    const raw = await runPowerShell(prefix() + WINRM_BOOTSTRAP, {
      exe, stdin: Buffer.from(JSON.stringify({ computerName: "synthetic.invalid", command: "Write-Output 'x'", frame })).toString("base64"),
    });
    // Establish a valid control before mutating it: a failed invocation must not
    // make every rejection assertion pass trivially.
    expect(decodeWinRmResult(raw, frame)).toMatchObject({ invocationStatus: "completed", exitCode: 0 });
    for (const altered of [{ ...raw, stdout: "" }, { ...raw, truncated: true }, { ...raw, stdout: raw.stdout.replace(frame, "b".repeat(48)) }, { ...raw, stdout: `noise\n${raw.stdout}` }]) {
      expect(decodeWinRmResult(altered, frame).invocationStatus).toBe("transport_error");
    }
  });
});

if (!engines.length) describe.skip("native WinRM bootstrap (no installed PowerShell engine)", () => {
  it("requires a locally available engine", () => {});
});

import { selectIntegrationEngines } from "./integration-engine.js";
import { describe, expect, it } from "vitest";
import { runProgram } from "../src/program.js";
import { runPowerShell } from "../src/powershell.js";
import { WINRM_BOOTSTRAP, decodeWinRmResult } from "../src/winrm.js";
import { logStore } from "../src/full-logs.js";

const shell = selectIntegrationEngines()[0]?.exe ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");

describe("bounded production pipes", () => {
  it("drains simultaneous large stdout/stderr and counts exact raw bytes", async () => {
    const r = await runProgram(process.execPath, ["-e", "process.stdout.write('x'.repeat(100000));process.stderr.write('y'.repeat(100000))"], { maxOutputBytes: 3, tail: true });
    expect(r).toMatchObject({ stdout: "xxx", stderr: "yyy", truncated: true,
      stdoutCapture: { observedBytes: 100000, capturedBytes: 3, omittedBytes: 99997 },
      stderrCapture: { observedBytes: 100000, capturedBytes: 3, omittedBytes: 99997 } });
  });
  it("PowerShell legacy retains raw newlines and exact byte counts", async () => {
    const r = await runPowerShell("[Console]::Out.Write('abcdef')", { exe: shell, maxOutputBytes: 2, tail: true });
    expect(r).toMatchObject({ stdout: "ef", truncated: true, stdoutCapture: { observedBytes: 6, capturedBytes: 2, omittedBytes: 4 } });
  });
  it("strict framed output stays valid with a tiny public cap", async () => {
    const r = await runPowerShell("'x' * 20000", { exe: shell, maxOutputBytes: 9, errorPolicy: "strict" });
    expect(r).toMatchObject({ scriptError: false, stdout: "xxxxxxxxx", truncated: true });
    expect(r.protocolError).toBeUndefined();
    expect(r.stdoutCapture?.observedBytes).toBeGreaterThan(20000);
  });
  it("strict framed logging captures beyond display and reports quota loss", async () => {
    const r = await runPowerShell("'abcdef'", { exe: shell, errorPolicy: "strict", maxOutputBytes: 1, logOutput: true, logQuotaBytes: 4 });
    expect(r.protocolError).toBeUndefined();
    expect(r.stdout).toBe('a');
    expect(r.stdoutCapture?.observedBytes).toBeGreaterThan(4);
    expect(r.log).toMatchObject({ complete: false, stdoutBytes: 4, stderrBytes: 0 });
    expect(Buffer.from(logStore.read(r.log!.handle, 'stdout', 0, 10).data, 'base64').toString()).toBe('abcd');
    expect(logStore.read(r.log!.handle, 'stdout', 0, 10).complete).toBe(false);
    logStore.delete(r.log!.handle);
  });
  it("framed producer truncation persists incomplete in readback", async () => {
    const r = await runPowerShell("'abcdefghijklmnop'", { exe: shell, errorPolicy: "strict", maxOutputBytes: 1, logOutput: true, logQuotaBytes: 8 });
    expect(r.log?.stdoutBytes).toBe(8);
    expect(r.log?.complete).toBe(false);
    expect(logStore.read(r.log!.handle, 'stdout', 0, 10).complete).toBe(false);
    logStore.delete(r.log!.handle);
  });
  it.each(['native', 'legacy'])("%s timeout retains an incomplete emitted prefix", async kind => {
    const opts = { timeoutMs: 5000, logOutput: true, maxOutputBytes: 100 };
    const r = kind === 'native'
      ? await runProgram(process.execPath, ['-e', "process.stdout.write('prefix');setInterval(()=>{},1000)"], opts)
      : await runPowerShell("[Console]::Out.Write('prefix'); Start-Sleep -Seconds 20", { ...opts, exe: shell });
    try {
      expect(r.timedOut).toBe(true);
      expect(r.stdout).toContain('prefix');
      expect(r.log?.complete).toBe(false);
      expect(logStore.read(r.log!.handle, 'stdout', 0, 100).complete).toBe(false);
    } finally { if (r.log) logStore.delete(r.log.handle); }
  }, 30000);
  it.each([0, 7])('native normal EOF exit %i retains complete log', async exit => {
    const r = await runProgram(process.execPath, ['-e', `process.stdout.write('ok');process.exitCode=${exit}`], { logOutput: true });
    try {
      expect(r.exitCode).toBe(exit);
      expect(r.log?.complete).toBe(true);
      expect(logStore.read(r.log!.handle, 'stdout', 0, 10).complete).toBe(true);
    } finally { if (r.log) logStore.delete(r.log.handle); }
  });
  it("WinRM isolated invocation logs payload, never the framed envelope or input", async () => {
    const frame = 'a'.repeat(48);
    const payload = Buffer.from(JSON.stringify({ computerName: 'isolated', command: "'abcdef'", frame, outputLimit: 6, outputTail: false })).toString('base64');
    const prefix = "function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$ErrorAction) & $ScriptBlock @ArgumentList };\n";
    const raw = await runPowerShell(prefix + WINRM_BOOTSTRAP, { exe: shell, stdin: payload, maxOutputBytes: 100000 });
    const r = decodeWinRmResult(raw, frame, 1, false, true, 8);
    expect(r.invocationStatus).toBe('completed');
    expect(r.stdout).toBe('a');
    expect(r.log).toMatchObject({ complete: false, stdoutBytes: 6, stderrBytes: 0 });
    expect(Buffer.from(logStore.read(r.log!.handle, 'stdout', 0, 10).data, 'base64').toString()).toBe('abcdef');
    logStore.delete(r.log!.handle);
  });
  it("strict stderr truncation does not invalidate an intact frame", async () => {
    const r = await runPowerShell("[Console]::Error.Write('z' * 20000); 'ok'", { exe: shell, maxOutputBytes: 4, errorPolicy: "strict" });
    expect(r.protocolError).toBeUndefined();
    expect(r.scriptError).toBe(false);
    expect(r.stderr).toBe("zzzz");
    expect(r.stderrCapture).toMatchObject({ observedBytes: 20000, capturedBytes: 4, omittedBytes: 19996 });
  });
  it("WinRM local Invoke-Command double preserves large frames", async () => {
    const frame = "a".repeat(48);
    const payload = Buffer.from(JSON.stringify({ computerName: "local-double", command: "'x' * 20000", frame, outputLimit: 9, outputTail: false })).toString("base64");
    const prefix = "function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$ErrorAction) & $ScriptBlock @ArgumentList };\n";
    const raw = await runPowerShell(prefix + WINRM_BOOTSTRAP, { exe: shell, stdin: payload, maxOutputBytes: 12_000_000 });
    const r = decodeWinRmResult(raw, frame, 9);
    expect(r).toMatchObject({ invocationStatus: "completed", stdout: "xxxxxxxxx", truncated: true });
  });
});

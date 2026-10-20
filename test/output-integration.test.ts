import { describe, expect, it } from "vitest";
import { runProgram } from "../src/program.js";
import { runPowerShell } from "../src/powershell.js";
import { WINRM_BOOTSTRAP, decodeWinRmResult } from "../src/winrm.js";

const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";

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

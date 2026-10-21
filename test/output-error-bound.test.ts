import { describe, expect, it } from "vitest";
import { OutputCollector } from "../src/output-collector.js";
import { decodeWinRmResult } from "../src/winrm.js";
import { runPowerShell } from "../src/powershell.js";
import { runProgram } from "../src/program.js";
import { fromProcess } from "../src/result.js";

const frame = "a".repeat(48);
function base(stdout: string, stderr = "") {
  const capture = new OutputCollector(1); capture.append(Buffer.from(stderr));
  return { stdout, stderr: capture.snapshot().text, stderrCapture: capture.snapshot(), exitCode: 0, timedOut: false, durationMs: 0, shell: "fixture", truncated: capture.snapshot().truncated };
}
function assertBounded(r: ReturnType<typeof base>, cap: number) {
  expect(Buffer.byteLength(r.stderr, "utf8")).toBeLessThanOrEqual(cap);
  expect(r.stderrCapture?.capturedBytes).toBeLessThanOrEqual(cap);
  expect(r.stderrCapture?.observedBytes).toBeGreaterThanOrEqual(r.stderrCapture!.capturedBytes);
  expect(r.stderrCapture?.omittedBytes).toBe(r.stderrCapture!.observedBytes - r.stderrCapture!.capturedBytes);
  expect(r.truncated).toBe(r.stderrCapture?.truncated);
}
describe("bounded error output", () => {
  it.each([false, true])("bounds WinRM transport error frames (tail=%s)", tail => {
    const body = { status: "transport_error", output: "REMOTE FAILURE LONG" };
    const r = decodeWinRmResult(base(`WINRM-RESULT:${frame}:${Buffer.from(JSON.stringify(body)).toString("base64")}\n`), frame, 1, tail);
    assertBounded(r, 1);
    expect(r.stderrCapture?.observedBytes).toBe(Buffer.byteLength(body.output));
    expect(r.stderr).toBe(tail ? "G" : "R");
    expect(fromProcess(r, "winrm", "fixture").terminationStatus).toBe("transport_error");
  });
  it("bounds invalid WinRM frames with existing stderr and diagnostics", () => {
    const r = decodeWinRmResult(base("bad", "LONG"), frame, 1);
    assertBounded(r, 1);
    expect(r.stderrCapture?.observedBytes).toBeGreaterThan(4);
    expect(r.stdoutCapture).toBeUndefined();
  });
  it.each([false, true])("bounds async missing-program spawn diagnostics (tail=%s)", async tail => {
    const r = await runProgram("missing-mcp-executable-999", [], { maxOutputBytes: 1, tail });
    assertBounded(r, 1);
    expect(r.stderrCapture?.observedBytes).toBeGreaterThan(1);
    expect(r.stderr).toBe(tail ? r.spawnError!.slice(-1) : "\n");
    expect(r.spawnError).toBeTruthy();
  });
  it("bounds strict invalid frames from a real child", async () => {
    const r = await runPowerShell("x", { exe: process.execPath, errorPolicy: "strict", maxOutputBytes: 1 });
    assertBounded(r, 1);
    expect(r.protocolError).toBe(true);
    expect(r.stdoutCapture).toBeUndefined();
  });
  it("bounds strict invalid frames and spawn diagnostics", async () => {
    const r = await runPowerShell("x", { exe: "missing-mcp-shell-999", errorPolicy: "strict", maxOutputBytes: 1 });
    assertBounded(r, 1);
    expect(r.spawnError).toBeTruthy();
    expect(r.stdoutCapture).toBeUndefined();
  });
});

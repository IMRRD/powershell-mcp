import { describe, expect, it } from "vitest";
import { runPowerShell } from "../src/powershell.js";

describe("strict protocol diagnostic capture", () => {
  it("retains the requested tail when an invalid frame follows existing stderr", async () => {
    const result = await runPowerShell("ignored", { exe: process.execPath, errorPolicy: "strict", maxOutputBytes: 1, tail: true });
    expect(result.protocolError).toBe(true);
    expect(result.stderr).toBe("e");
    expect(result.stderrCapture?.capturedBytes).toBe(1);
    expect(result.stderrCapture?.observedBytes).toBeGreaterThan(1);
    expect(result.stderrCapture?.omittedBytes).toBe(result.stderrCapture!.observedBytes - 1);
  });

  it("retains head-mode diagnostics when tail is not requested", async () => {
    const result = await runPowerShell("ignored", { exe: process.execPath, errorPolicy: "strict", maxOutputBytes: 1 });
    expect(result.protocolError).toBe(true);
    expect(result.stderr).toBe(process.execPath[0]);
    expect(result.stderrCapture?.capturedBytes).toBe(1);
  });

  it("keeps a zero-byte tail capture empty while accounting for diagnostics", async () => {
    const result = await runPowerShell("ignored", { exe: process.execPath, errorPolicy: "strict", maxOutputBytes: 0, tail: true });
    expect(result.protocolError).toBe(true);
    expect(result.stderr).toBe("");
    expect(result.stderrCapture?.capturedBytes).toBe(0);
    expect(result.stderrCapture?.observedBytes).toBeGreaterThan(0);
    expect(result.stderrCapture?.omittedBytes).toBe(result.stderrCapture?.observedBytes);
  });
});
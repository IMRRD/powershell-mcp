import { describe, expect, it } from "vitest";
import { runPowerShell } from "../src/powershell.js";
import { fromProcess } from "../src/result.js";
import { selectIntegrationEngines } from "./integration-engine.js";

for (const { exe } of selectIntegrationEngines()) describe(`PowerShell failure boundaries (${exe})`, () => {
  it.each([
    ["strict script error", "throw 'SYNTHETIC_SCRIPT_ERROR'", "strict", "script_error", 0, true, false],
    ["strict parser error", "function broken( {", "strict", "script_error", 0, true, false],
    ["legacy nonzero exit", "exit 7", "legacy", "nonzero_exit", 7, false, false],
    // A host exit without the terminal frame never proves strict completion.
    ["strict nonzero host exit", "exit 7", "strict", "transport_error", 7, false, true],
    ["strict missing frame", "[Environment]::Exit(0)", "strict", "transport_error", 0, false, true],
  ] as const)("distinguishes %s", async (_name, script, errorPolicy, status, exitCode, scriptError, protocolError) => {
    const result = await runPowerShell(script, { exe, errorPolicy, maxOutputBytes: 1024 });
    expect(fromProcess(result, "powershell", "local").terminationStatus).toBe(status);
    expect(result.exitCode).toBe(exitCode);
    expect(result.treeTerminated).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(!!result.scriptError).toBe(scriptError);
    expect(!!result.protocolError).toBe(protocolError);
    if (scriptError) expect(result.errorRecords?.length).toBeGreaterThan(0);
    else expect(result.errorRecords).toBeUndefined();
    if (protocolError) {
      expect(result.stdout).toBe("");
      expect(result.stdoutCapture).toBeUndefined();
    }
  });

  it("preserves timeout precedence without accepting an unfinished strict payload", async () => {
    const result = await runPowerShell("Start-Sleep -Seconds 30", { exe, errorPolicy: "strict", timeoutMs: 100 });
    expect(fromProcess(result, "powershell", "local").terminationStatus).toBe("timeout");
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("");
    expect(result.stdoutCapture).toBeUndefined();
    expect(result.scriptError).toBeUndefined();
  });

  it("preserves pre-dispatch cancellation without inventing an exit", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPowerShell("Write-Output NOT_DISPATCHED", { exe, errorPolicy: "strict", signal: controller.signal });
    expect(fromProcess(result, "powershell", "local").terminationStatus).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.durationMs).toBe(0);
    expect(result.scriptError).toBeUndefined();
  });
});

it("distinguishes an unavailable explicit engine from script and protocol failures", async () => {
  const result = await runPowerShell("Write-Output NOT_DISPATCHED", { exe: "missing-issue72-engine", errorPolicy: "strict" });
  expect(fromProcess(result, "powershell", "local").terminationStatus).toBe("transport_error");
  expect(result.spawnError).toBeTruthy();
  expect(result.exitCode).toBeNull();
  expect(result.scriptError).toBeUndefined();
  expect(result.protocolError).toBeUndefined();
});

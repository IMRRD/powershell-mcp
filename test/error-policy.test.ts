import { selectIntegrationEngines } from "./integration-engine.js";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { runPowerShell } from "../src/powershell.js";
import { fromProcess } from "../src/result.js";

const nativeExe = `'${process.execPath.replace(/'/g, "''")}'`;
const engines = selectIntegrationEngines().map(engine => engine.exe);
for (const exe of engines) describe(`error policy (${exe})`, () => {
  const run = (script: string, strict = true) => runPowerShell(script, { exe, errorPolicy: strict ? "strict" : "legacy" });
  it("preserves default raw semantics and detects opt-in Write-Error with following output", async () => {
    const script = "Write-Error 'ordinary failure'; Write-Output 'after failure'";
    const legacy = await run(script, false);
    expect(legacy.exitCode).toBe(0);
    const strict = await run(script);
    expect(strict.stdout).not.toContain("after failure");
    expect(fromProcess(strict, "powershell", "local").terminationStatus).toBe("script_error");
    expect(strict.errorRecords?.[0]).toMatchObject({ category: "NotSpecified" });
  }, 20000);
  it("detects throw and parser failures, without printing the source in metadata", async () => {
    for (const script of ["Write-Output 'before'; throw 'secret-ish failure'", "function broken( {"]) {
      const result = await run(script);
      expect(fromProcess(result, "powershell", "local").terminationStatus).toBe("script_error");
      expect(result.errorRecords?.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.errorRecords)).not.toContain("function broken(");
    }
  }, 20000);
  it("does not confuse handled errors, stderr, or an earlier native exit with strict failure", async () => {
    expect((await run("try { throw 'handled' } catch { Write-Output 'recovered' }")).errorRecords).toEqual([]);
    expect((await run("[Console]::Error.WriteLine('diagnostic'); Write-Output 'ok'")).errorRecords).toEqual([]);
    const native = await run(`& ${nativeExe} -e 'process.exit(7)'; Write-Output 'later cmdlet'`);
    expect(native.stdout).toContain("later cmdlet");
    expect(native.errorRecords).toEqual([]);
  }, 20000);
  it.each(["Write-Error boom", "throw 'boom'"])("keeps prior output but never formats source-only literals (%s)", async failure => {
    const result = await run(`Write-Output 'BEFORE_ERROR'; ${failure}; $unused='SECRET_NOT_EMITTED_62091'; Write-Output AFTER_ERROR`);
    expect(result.protocolError).not.toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.treeTerminated).toBe(true);
    expect(result.scriptError).toBe(true);
    expect(result.stdout).toContain("BEFORE_ERROR");
    expect(result.stdout).not.toContain("AFTER_ERROR");
    expect(JSON.stringify(result)).not.toContain("SECRET_NOT_EMITTED_62091");
  });
  it("honors deliberate per-command ErrorAction overrides", async () => {
    const continued = await run("Write-Error deliberate -ErrorAction Continue; Write-Output AFTER_CONTINUE");
    expect(continued.stdout).toContain("AFTER_CONTINUE");
    expect(continued.scriptError).toBe(true);
    const silent = await run("Write-Error deliberate -ErrorAction SilentlyContinue; Write-Output AFTER_SILENT");
    expect(silent.stdout).toContain("AFTER_SILENT");
    expect(silent.scriptError).toBe(false);
  }, 15000); // Two real hosts compile the producer writer before executing.
  it("does not fail on successful native stderr", async () => {
    const result = await run(`& ${nativeExe} -e 'process.stderr.write(String(123))'; Write-Output AFTER_NATIVE`);
    expect(result.stdout + result.stderr).toContain("123");
    expect(result.stdout).toContain("AFTER_NATIVE");
    expect(result.scriptError).toBe(false);
  });
  it("bounds metadata and flags truncation", async () => {
    const result = await run("1..30 | ForEach-Object { Write-Error ('x' * 3000) }");
    expect(result.errorRecords?.length).toBeLessThanOrEqual(8);
    expect(result.errorRecordsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.errorRecords), "utf8")).toBeLessThan(12000);
  });
});

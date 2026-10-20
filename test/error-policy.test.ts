import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { runPowerShell } from "../src/powershell.js";
import { fromProcess } from "../src/result.js";

const engines = (process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"])
  .filter(exe => spawnSync(exe, ["-NoProfile", "-Command", "exit 0"], { timeout: 10000 }).status === 0);
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
  });
  it("detects throw and parser failures, without printing the source in metadata", async () => {
    for (const script of ["Write-Output 'before'; throw 'secret-ish failure'", "function broken( {"]) {
      const result = await run(script);
      expect(fromProcess(result, "powershell", "local").terminationStatus).toBe("script_error");
      expect(result.errorRecords?.length).toBeGreaterThan(0);
      expect(JSON.stringify(result.errorRecords)).not.toContain("function broken(");
    }
  });
  it("does not confuse handled errors, stderr, or an earlier native exit with strict failure", async () => {
    expect((await run("try { throw 'handled' } catch { Write-Output 'recovered' }")).errorRecords).toEqual([]);
    expect((await run("[Console]::Error.WriteLine('diagnostic'); Write-Output 'ok'")).errorRecords).toEqual([]);
    const native = await run("cmd.exe /d /c exit /b 7; Write-Output 'later cmdlet'");
    expect(native.stdout).toContain("later cmdlet");
    expect(native.errorRecords).toEqual([]);
  });
  it("keeps prior output but never formats source-only literals", async () => {
    const result = await run("Write-Output 'BEFORE_ERROR'; Write-Error boom; $unused='SECRET_NOT_EMITTED_62091'; Write-Output AFTER_ERROR");
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
  });
  it("does not fail on successful native stderr", async () => {
    const result = await run("cmd.exe /d /c \"echo native-diagnostic 1>&2 & exit /b 0\"; Write-Output AFTER_NATIVE");
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

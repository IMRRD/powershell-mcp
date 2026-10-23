import { selectIntegrationEngines } from "./integration-engine.js";
import { describe, it, expect } from "vitest";
import { runProgram } from "../src/program.js";
import { runPowerShell } from "../src/powershell.js";
import { WINRM_BOOTSTRAP, buildWinRmInput, decodeWinRmResult } from "../src/winrm.js";
import { spawnSync } from "node:child_process";

describe("bounded typed inputs", () => {
  it("delivers UTF-8, empty stdin and EOF to a native child", async () => {
    for (const stdin of ["", `héllo " \\ 💫`]) {
      const r = await runProgram(process.execPath, ["-e", "process.stdin.on('data',b=>process.stdout.write(b));process.stdin.on('end',()=>process.stdout.write('|EOF'))"], { stdin });
      expect(r.stdout).toBe(stdin + "|EOF");
      expect(r.exitCode).toBe(0);
    }
  });
  it("refuses oversized input before launching the executable", async () => {
    const r = await runProgram(process.execPath, ["-e", "process.stdout.write('LAUNCHED')"], { stdin: "x".repeat(1_048_577) });
    expect(r.stdout).toBe("");
    expect(r.spawnError).toMatch(/input limit/i);
  });
  it("rejects invalid parameter keys, depth and byte size before child launch", () => {
    for (const parameters of [{ "bad-name": "x" }, { value: "x".repeat(1_048_577) }, { value: [[[[[[[[[1]]]]]]]]] }])
      expect(() => runPowerShell("'LAUNCHED'", { parameters })).toThrow(/limit|invalid/);
  });
  const engines = selectIntegrationEngines().map(engine => engine.exe);
  for (const exe of engines) it(`binds typed parameters without executing values (${exe})`, async () => {
    const parameters = { text: "'; throw 'INJECTED'; # 💫\\", items: ["a", "b"], nothing: null, enabled: true, count: 3, nested: { key: "value" } };
    const r = await runPowerShell("param($text,$items,$nothing,$enabled,$count,$nested) [pscustomobject]@{text=$text; items=@($items); nothing=($null -eq $nothing); enabled=$enabled; count=$count; nested=$nested.key} | ConvertTo-Json -Compress -Depth 8", { exe, parameters });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ text: parameters.text, items: parameters.items, nothing: true, enabled: true, count: 3, nested: "value" });
  });
  for (const exe of engines) it(`preserves strict framing for typed parameters (${exe})`, async () => {
    const r = await runPowerShell("param($text) Write-Output $text", { exe, errorPolicy: "strict", parameters: { text: "literal';throw 'INJECTED'" } });
    expect(r.scriptError).toBe(false);
    expect(r.protocolError).not.toBe(true);
    expect(r.stdout).toContain("literal';throw 'INJECTED'");
  });
  for (const exe of engines) it(`binds WinRM parameters in isolated local double (${exe})`, async () => {
    const frame = "a".repeat(48);
    const payload = JSON.parse(Buffer.from(buildWinRmInput({ computerName: "synthetic.invalid", command: "param($text,$items) [pscustomobject]@{ text=$text; count=$items.Count } | ConvertTo-Json -Compress", parameters: { text: "'; throw 'INJECTED'; #", items: [1, 2] } }), "base64").toString());
    const raw = await runPowerShell("function Invoke-Command { param($ComputerName,$ScriptBlock,$ArgumentList,$ErrorAction) & $ScriptBlock @ArgumentList };\n" + WINRM_BOOTSTRAP, { exe, stdin: Buffer.from(JSON.stringify({ ...payload, frame })).toString("base64") });
    const r = decodeWinRmResult(raw, frame);
    expect(r.invocationStatus).toBe("completed");
    expect(r.stdout).toContain("INJECTED");
  });
});
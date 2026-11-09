import { selectIntegrationEngines } from "./integration-engine.js";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { EOL } from "node:os";

const exe = selectIntegrationEngines()[0]?.exe;
describe.skipIf(!exe)("built MCP strict and legacy execution", () => {
  it("reports a genuine job throw matching the native continuation ErrorId as a script failure", async () => {
    const client = new Client({ name: "job-error-smoke", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/index.js")], env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: "1", PWSH_MCP_EXE: exe! }, stderr: "pipe" });
    await client.connect(transport);
    try {
      const response = await client.callTool({ name: "run_powershell", arguments: {
        script: "Start-Job { throw 'NativeCommandErrorMessage' } | Receive-Job -Wait -AutoRemoveJob -ErrorAction Continue; 'AFTER'",
        engine: exe === "powershell.exe" ? "powershell" : "pwsh",
        errorPolicy: "strict", timeoutMs: 15_000,
      } });
      const data = response.structuredContent as Record<string, any>;
      expect(data.exitCode).toBe(0);
      expect(data.stdout).toBe(`NativeCommandErrorMessage${EOL}AFTER${EOL}`);
      expect(data.terminationStatus).toBe("script_error");
      expect(response.isError).toBe(true);
      expect(data.errorRecords).toEqual([{
        category: "OperationStopped",
        fullyQualifiedErrorId: "NativeCommandErrorMessage",
        exceptionType: "System.Management.Automation.RemoteException",
        message: "NativeCommandErrorMessage",
      }]);
    } finally { await client.close(); }
  }, 20_000);
  it("reports successful multiline native diagnostics through typed strict execution", async () => {
    const client = new Client({ name: "native-stderr-smoke", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/index.js")], env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: "1", PWSH_MCP_EXE: exe! }, stderr: "pipe" });
    await client.connect(transport);
    try {
      const native = `'${process.execPath.replace(/'/g, "''")}'`;
      const response = await client.callTool({ name: "run_powershell", arguments: {
        script: `param($marker) & ${native} -e 'process.stderr.write([111,222,333].join(String.fromCharCode(10)))'; Write-Output $marker`,
        parameters: { marker: "AFTER_NATIVE" }, errorPolicy: "strict", maxOutputBytes: 32,
      } });
      const data = response.structuredContent as Record<string, any>;
      expect(response.isError).toBe(false);
      expect(data).toMatchObject({ terminationStatus: "completed", exitCode: 0, errorRecords: [] });
      expect(data.stdout).toContain("222");
      expect(data.stdout).toContain("AFTER_NATIVE");
      expect(data.stdout).not.toContain("PS-RESULT:");
      expect(Buffer.byteLength(data.stdout, "utf8")).toBeLessThanOrEqual(32);
      expect(data.truncation.stdout.capturedBytes).toBe(Buffer.byteLength(data.stdout, "utf8"));
    } finally { await client.close(); }
  }, 20_000);
  it("captures strict payload through built stdio without persisting a frame", async () => {
    const client = new Client({ name: "strict-log-smoke", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/index.js")], env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: "1", PWSH_MCP_EXE: exe! }, stderr: "pipe" });
    await client.connect(transport);
    try {
      const response = await client.callTool({ name: "run_powershell", arguments: { script: "'abcdef'", errorPolicy: "strict", maxOutputBytes: 1, logOutput: true, logQuotaBytes: 16 } });
      const data = response.structuredContent as Record<string, any>;
      expect(data).toMatchObject({ stdout: 'a', terminationStatus: 'completed', log: { complete: true, stderrBytes: 0 } });
      const page = await client.callTool({ name: 'read_output_log', arguments: { handle: data.log.handle, stream: 'stdout', offset: 0, length: 16 } });
      expect(Buffer.from(JSON.parse((page.content[0] as { text: string }).text).data, 'base64').toString()).toBe(`abcdef${EOL}`);
      await client.callTool({ name: 'delete_output_log', arguments: { handle: data.log.handle } });
    } finally { await client.close(); }
  }, 20_000);
  it("reports strict script errors and preserves the default legacy outcome", async () => {
    const client = new Client({ name: "error-policy-smoke", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), "dist/index.js")], env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: "1", PWSH_MCP_EXE: exe! }, stderr: "pipe" });
    await client.connect(transport);
    try {
      for (const [policy, status] of [[undefined, "completed"], ["strict", "script_error"]] as const) {
        const r = await client.callTool({ name: "run_powershell", arguments: { script: "Write-Error 'protocol failure'; Write-Output 'after'", ...(policy ? { errorPolicy: policy } : {}) } });
        const data = r.structuredContent as Record<string, any>;
        expect(data.terminationStatus).toBe(status);
        if (policy) expect(data.stdout).not.toContain("after");
        else expect(data.stdout).toContain("after");
        expect(r.isError ?? false).toBe(policy === "strict");
        if (policy) expect(data.errorRecords[0].message).toContain("protocol failure");
      }
    } finally { await client.close(); }
  }, 20_000);
});

import { selectIntegrationEngines } from "./integration-engine.js";
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { EOL } from "node:os";

const exe = selectIntegrationEngines()[0]?.exe;
describe.skipIf(!exe)("built MCP strict and legacy execution", () => {
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

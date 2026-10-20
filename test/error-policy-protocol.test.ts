import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const exe = (process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"])
  .find(x => spawnSync(x, ["-NoProfile", "-Command", "exit 0"], { timeout: 10000 }).status === 0);
describe.skipIf(!exe)("built MCP strict and legacy execution", () => {
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

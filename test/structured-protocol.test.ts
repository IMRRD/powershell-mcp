import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const client = new Client({ name: "contract-test", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(process.cwd(), "dist/index.js")],
  env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: "1", PWSH_MCP_EXE: "nonexistent-mcp-shell-15" },
  stderr: "pipe",
});

beforeAll(async () => { await client.connect(transport); });
afterAll(async () => { await client.close(); });

async function check(name: string, args: Record<string, unknown>, status: string, error: boolean) {
  const result = await client.callTool({ name, arguments: args });
  const data = result.structuredContent as Record<string, any>;
  expect(data).toBeTruthy();
  expect(data.schemaVersion).toBe(1);
  expect(data.executionId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(data.terminationStatus).toBe(status);
  expect(result.isError ?? false).toBe(error);
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect((result.content[0] as { text: string }).text).toContain(data.exitCode === null ? "null" : String(data.exitCode));
  expect(data).toHaveProperty("truncation");
  expect(data).not.toHaveProperty("password");
  return data;
}

describe("built-artifact stdio structured tool contract", () => {
  it("advertises a shared output schema on every tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(10);
    for (const tool of tools) {
      expect(tool.outputSchema?.properties).toHaveProperty("terminationStatus");
      expect(tool.outputSchema?.properties).toHaveProperty("executionId");
    }
  });
  it("fails closed on a missing executable and invalid cwd", async () => {
    const missing = await check("run_program", { program: "nonexistent-mcp-executable-15" }, "transport_error", true);
    expect(missing.exitCode).toBeNull();
    const cwd = await check("run_program", { program: process.execPath, cwd: join(process.cwd(), "no-such-dir-15") }, "transport_error", true);
    expect(cwd.exitCode).toBeNull();
  });
  it("distinguishes empty output, nonzero completion and timeout", async () => {
    const literal = await check("run_program", { program: process.execPath, args: ["-e", "console.error('[spawn error] ordinary\\nFailed to spawn ordinary')"] }, "completed", false);
    expect(literal.exitCode).toBe(0);
    const empty = await check("run_program", { program: process.execPath, args: ["-e", ""] }, "completed", false);
    expect(empty).toMatchObject({ stdout: "", stderr: "", exitCode: 0, timedOut: false, transport: "program" });
    const failed = await check("run_program", { program: process.execPath, args: ["-e", "process.exit(7)"] }, "nonzero_exit", true);
    expect(failed.exitCode).toBe(7);
    const timeout = await check("run_program", { program: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], timeoutMs: 250 }, "timeout", true);
    expect(timeout.timedOut).toBe(true);
  });
  it("covers local shell, wrappers, WinRM and remote auth failures", async () => {
    // Explicit override prevents fallback and never contacts a remote host.
    // Server child has an impossible shell override and cannot contact WinRM.
      for (const [name, args] of [
        ["run_powershell", { script: "echo x" }], ["list_services", {}],
        ["get_service", { name: "bogus" }], ["control_service", { name: "bogus", action: "status" }],
        ["system_info", {}], ["winrm_exec", { computerName: "invalid", command: "echo x" }],
      ] as const) {
        const data = await check(name, args, "transport_error", true);
        expect(data.exitCode).toBeNull();
      }
    const ssh = await check("ssh_exec", { host: "127.0.0.1", username: "nobody", command: "true" }, "transport_error", true);
    expect(ssh.exitCode).toBeNull();
    for (const name of ["sftp_upload", "sftp_download"]) {
      const sftp = await check(name, { host: "127.0.0.1", username: "nobody", localPath: "a", remotePath: "b" }, "transport_error", true);
      expect(sftp.exitCode).toBeNull();
    }
  });
});

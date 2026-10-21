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
  it("advertises bounded output options for each execution transport", async () => {
    const { tools } = await client.listTools();
    for (const name of ["run_powershell", "run_program", "winrm_exec", "ssh_exec"]) {
      const tool = tools.find(t => t.name === name)!;
      expect(tool.inputSchema.properties).toHaveProperty("maxOutputBytes");
      expect(tool.inputSchema.properties).toHaveProperty("tail");
    }
  });
  it("returns raw bounded program output and per-stream metrics over stdio", async () => {
    const data = await check("run_program", { program: process.execPath,
      args: ["-e", "process.stdout.write('abcdef');process.stderr.write('uvwxyz')"],
      maxOutputBytes: 2, tail: true }, "completed", false);
    expect(data).toMatchObject({ stdout: "ef", stderr: "yz", truncation: {
      truncated: true, limitBytesPerStream: 2,
      stdout: { observedBytes: 6, capturedBytes: 2, omittedBytes: 4, truncated: true },
      stderr: { observedBytes: 6, capturedBytes: 2, omittedBytes: 4, truncated: true },
    } });
  });
  it("rejects invalid limits at the MCP boundary", async () => {
    const response = await client.callTool({ name: "run_program", arguments: { program: process.execPath, maxOutputBytes: 0 } });
    expect(response.isError).toBe(true);
  });
  it("advertises a shared output schema on every tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(12);
    expect(tools.map(t => t.name)).toContain("read_output_log");
    expect(tools.map(t => t.name)).toContain("delete_output_log");
    for (const tool of tools.filter(t => !["read_output_log", "delete_output_log"].includes(t.name))) {
      expect(tool.outputSchema?.properties).toHaveProperty("terminationStatus");
      expect(tool.outputSchema?.properties).toHaveProperty("executionId");
    }
  });
  it("captures and pages actual program output over built stdio", async () => {
    const data = await check("run_program", { program: process.execPath,
      args: ["-e", "process.stdout.write('abcdef');process.stderr.write('uvwxyz')"], maxOutputBytes: 2, logOutput: true }, "completed", false);
    expect(data.log).toMatchObject({ complete: true, stdoutBytes: 6, stderrBytes: 6 });
    const page = await client.callTool({ name: "read_output_log", arguments: { handle: data.log.handle, stream: "stdout", offset: 2, length: 3 } });
    expect(JSON.parse((page.content[0] as { text: string }).text)).toMatchObject({ data: "Y2Rl", nextOffset: 5, totalBytes: 6 });
    const deleted = await client.callTool({ name: "delete_output_log", arguments: { handle: data.log.handle } });
    expect(JSON.parse((deleted.content[0] as { text: string }).text)).toEqual({ deleted: true });
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

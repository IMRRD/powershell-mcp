import { selectIntegrationEngines } from "./integration-engine.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const client = new Client({ name: "bounded-shell-test", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(process.cwd(), "dist/index.js")],
  env: { ...process.env, POWERSHELL_MCP_NO_TELEMETRY: "1", PWSH_MCP_EXE: selectIntegrationEngines()[0]?.exe ?? (process.platform === "win32" ? "powershell.exe" : "pwsh") }, stderr: "pipe" });

beforeAll(async () => client.connect(transport));
afterAll(async () => client.close());

describe("built stdio PowerShell capture", () => {
  it("returns strict framed output counts and preserved raw data", async () => {
    const response = await client.callTool({ name: "run_powershell", arguments: {
      script: "'😀' * 10000", errorPolicy: "strict", maxOutputBytes: 5, tail: true,
    } }, undefined, { timeout: 15000 });
    const data = response.structuredContent as Record<string, any>;
    expect(response.isError, JSON.stringify(response)).toBe(false);
    expect(data.terminationStatus).toBe("completed");
    expect(data.truncation).toMatchObject({ limitBytesPerStream: 5, truncated: true,
      stdout: { truncated: true } });
    expect(data.stdout).not.toContain("�");
    expect(Buffer.byteLength(data.stdout, "utf8")).toBe(data.truncation.stdout.capturedBytes);
    expect(data.truncation.stdout.capturedBytes).toBeLessThanOrEqual(5);
    expect(data.truncation.stdout.observedBytes).toBeGreaterThan(40000);
    expect(data.truncation.stdout.capturedBytes + data.truncation.stdout.omittedBytes).toBe(data.truncation.stdout.observedBytes);
  });
});

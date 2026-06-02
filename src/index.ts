#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runPowerShell } from "./powershell.js";
import { formatResult } from "./format.js";

const VERSION = "0.1.0";

const server = new McpServer({ name: "powershell-mcp", version: VERSION });

server.tool(
  "run_powershell",
  "Run a PowerShell script/command on this Windows host in a hidden process (no console window appears). Returns stdout, stderr and exit code. Use for any Windows command, file, or system task.",
  {
    script: z.string().describe("PowerShell script or command to execute."),
    cwd: z.string().optional().describe("Working directory."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 60000)."),
  },
  async ({ script, cwd, timeoutMs }) => {
    const r = await runPowerShell(script, { cwd, timeoutMs });
    return { content: [{ type: "text", text: formatResult(r) }], isError: r.timedOut || (r.exitCode ?? 0) !== 0 };
  },
);

server.tool(
  "list_services",
  "List Windows services, optionally filtered by a name pattern. Returns Name, DisplayName, Status.",
  { filter: z.string().optional().describe("Wildcard name filter, e.g. 'Sql*' or '*backup*'.") },
  async ({ filter }) => {
    const f = filter ? `-Name '${filter.replace(/'/g, "''")}'` : "";
    const script = `Get-Service ${f} | Select-Object Name,DisplayName,Status | Sort-Object Name | Format-Table -AutoSize | Out-String -Width 200`;
    const r = await runPowerShell(script, { timeoutMs: 30_000 });
    return { content: [{ type: "text", text: formatResult(r) }], isError: (r.exitCode ?? 0) !== 0 };
  },
);

server.tool(
  "get_service",
  "Get detailed status of one Windows service by name.",
  { name: z.string().describe("Exact service name (not display name).") },
  async ({ name }) => {
    const n = name.replace(/'/g, "''");
    const script = `Get-Service -Name '${n}' | Select-Object Name,DisplayName,Status,StartType,CanStop,CanPauseAndContinue | Format-List | Out-String -Width 200`;
    const r = await runPowerShell(script, { timeoutMs: 30_000 });
    return { content: [{ type: "text", text: formatResult(r) }], isError: (r.exitCode ?? 0) !== 0 };
  },
);

server.tool(
  "control_service",
  "Start, stop, or restart a Windows service (requires the MCP host process to have sufficient privileges).",
  {
    name: z.string().describe("Exact service name."),
    action: z.enum(["start", "stop", "restart", "status"]).describe("Action to perform."),
  },
  async ({ name, action }) => {
    const n = name.replace(/'/g, "''");
    const verb = { start: "Start-Service", stop: "Stop-Service", restart: "Restart-Service", status: "Get-Service" }[action];
    const script = `${verb} -Name '${n}' -ErrorAction Stop; Get-Service -Name '${n}' | Select-Object Name,Status | Format-List | Out-String -Width 200`;
    const r = await runPowerShell(script, { timeoutMs: 120_000 });
    return { content: [{ type: "text", text: formatResult(r) }], isError: r.timedOut || (r.exitCode ?? 0) !== 0 };
  },
);

server.tool(
  "system_info",
  "Return OS, CPU, memory and disk summary for this Windows host.",
  {},
  async () => {
    const script = [
      "$os = Get-CimInstance Win32_OperatingSystem;",
      "$cs = Get-CimInstance Win32_ComputerSystem;",
      "[pscustomobject]@{",
      "  Host=$env:COMPUTERNAME; OS=$os.Caption; Version=$os.Version;",
      "  CPUs=$cs.NumberOfLogicalProcessors;",
      "  MemGB=[math]::Round($cs.TotalPhysicalMemory/1GB,1);",
      "  FreeMemGB=[math]::Round($os.FreePhysicalMemory/1MB,1);",
      "} | Format-List | Out-String -Width 200;",
      "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | Format-Table -AutoSize | Out-String -Width 200",
    ].join("\n");
    const r = await runPowerShell(script, { timeoutMs: 30_000 });
    return { content: [{ type: "text", text: formatResult(r) }], isError: (r.exitCode ?? 0) !== 0 };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  process.stderr.write(`powershell-mcp v${VERSION} ready (stdio)\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack || err}\n`);
  process.exit(1);
});

#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runPowerShell } from "./powershell.js";
import { formatResult } from "./format.js";
import { runSsh, formatSsh } from "./ssh.js";
import { runWinRm } from "./winrm.js";
import { runSftp, formatSftp } from "./sftp.js";

const VERSION = "0.3.0";

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

server.tool(
  "ssh_exec",
  "Run a command on a remote host over SSH, fully in-process (no ssh.exe, no WSL — works headless). Use for Linux hosts or any OpenSSH target. Auth via privateKeyPath or password. Returns stdout, stderr, exit code.",
  {
    host: z.string().describe("Remote host or IP."),
    username: z.string().describe("SSH username."),
    command: z.string().describe("Command to run on the remote host."),
    port: z.number().int().positive().max(65535).optional().describe("SSH port (default 22)."),
    privateKeyPath: z.string().optional().describe("Path to a private key file on this Windows host, e.g. C:\\\\Users\\\\isak\\\\.ssh\\\\id_ed25519."),
    passphrase: z.string().optional().describe("Passphrase for the private key, if any."),
    password: z.string().optional().describe("Password auth (used if no key)."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 60000). Also bounds the connection handshake."),
    maxOutputBytes: z.number().int().positive().max(8_388_608).optional().describe("Cap captured stdout/stderr per stream (bytes, default 1 MiB)."),
    tail: z.boolean().optional().describe("Keep the LAST maxOutputBytes instead of the first (tail) — useful for long logs."),
  },
  async ({ host, username, command, port, privateKeyPath, passphrase, password, timeoutMs, maxOutputBytes, tail }) => {
    const r = await runSsh({ host, username, command, port, privateKeyPath, passphrase, password, timeoutMs, maxOutputBytes, tail });
    return {
      content: [{ type: "text", text: formatSsh(`${username}@${host}`, r) }],
      isError: r.timedOut || !!r.error || (r.exitCode ?? 0) !== 0,
    };
  },
);

server.tool(
  "winrm_exec",
  "Run a command on a remote Windows host via PowerShell Remoting (WinRM / Invoke-Command). Native to Windows Server — no SSH server or agent needed on the target, only WinRM enabled. Output captured in-process (no console window).",
  {
    computerName: z.string().describe("Remote Windows host name or IP."),
    command: z.string().describe("PowerShell command/scriptblock body to run remotely."),
    username: z.string().optional().describe("Credential username (DOMAIN\\\\user or host\\\\user). Omit to use the host process identity."),
    password: z.string().optional().describe("Credential password."),
    useSsl: z.boolean().optional().describe("Use HTTPS/5986 WinRM."),
    authentication: z.enum(["Default", "Negotiate", "Kerberos", "Basic", "CredSSP"]).optional().describe("WinRM auth mechanism."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 120000)."),
  },
  async ({ computerName, command, username, password, useSsl, authentication, timeoutMs }) => {
    const r = await runWinRm({ computerName, command, username, password, useSsl, authentication, timeoutMs });
    return { content: [{ type: "text", text: formatResult(r) }], isError: r.timedOut || (r.exitCode ?? 0) !== 0 };
  },
);

const sftpAuth = {
  host: z.string().describe("Remote host or IP."),
  username: z.string().describe("SSH username."),
  port: z.number().int().positive().max(65535).optional().describe("SSH port (default 22)."),
  privateKeyPath: z.string().optional().describe("Path to a private key file on this Windows host."),
  passphrase: z.string().optional().describe("Passphrase for the private key, if any."),
  password: z.string().optional().describe("Password auth (used if no key)."),
  timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 120000)."),
};

server.tool(
  "sftp_upload",
  "Upload a local file to a remote host over SFTP, in-process (ssh2 — no scp.exe, no WSL, headless). Use to deploy scripts/configs to Linux hosts.",
  { localPath: z.string().describe("Local file path on this Windows host."),
    remotePath: z.string().describe("Destination path on the remote host."), ...sftpAuth },
  async ({ localPath, remotePath, host, username, port, privateKeyPath, passphrase, password, timeoutMs }) => {
    const o = { direction: "upload" as const, localPath, remotePath, host, username, port, privateKeyPath, passphrase, password, timeoutMs };
    const r = await runSftp(o);
    return { content: [{ type: "text", text: formatSftp(o, r) }], isError: !r.ok };
  },
);

server.tool(
  "sftp_download",
  "Download a file from a remote host to this Windows host over SFTP, in-process (ssh2 — no scp.exe, no WSL, headless).",
  { remotePath: z.string().describe("Source path on the remote host."),
    localPath: z.string().describe("Destination path on this Windows host."), ...sftpAuth },
  async ({ remotePath, localPath, host, username, port, privateKeyPath, passphrase, password, timeoutMs }) => {
    const o = { direction: "download" as const, localPath, remotePath, host, username, port, privateKeyPath, passphrase, password, timeoutMs };
    const r = await runSftp(o);
    return { content: [{ type: "text", text: formatSftp(o, r) }], isError: !r.ok };
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

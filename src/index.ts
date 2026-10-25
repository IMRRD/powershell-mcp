#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runPowerShell } from "./powershell.js";
import { formatResult } from "./format.js";
import { runProgram } from "./program.js";
import { runSsh, formatSsh } from "./ssh.js";
import { runWinRm } from "./winrm.js";
import { runSftp, formatSftp } from "./sftp.js";
import { resultShape, fromProcess, fromSsh, fromSftp, toolResult } from "./result.js";
import { startupPing, recordTool, startFlushTimer } from "./telemetry.js";
import { instrumentTool, type ToolName } from "./tool-instrumentation.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { logStore } from "./full-logs.js";
import { executionStore } from "./execution-lifecycle.js";
import { remoteBatchStore } from "./remote-batch.js";
import { configuredProvider, resolveCredential, sanitizeCredentialResult } from "./credentials.js";
import { typedParameters, INPUT_LIMIT } from "./typed-input.js";
import { capabilities, engineExecutable, detectEngine } from "./capabilities.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
) as { version: string };
const VERSION = pkg.version;

const server = new McpServer({ name: "powershell-mcp", version: VERSION });
// One registration boundary captures each RPC exactly once, including failures.
const originalRegisterTool = server.registerTool.bind(server);
server.registerTool = ((name: ToolName, config: unknown, handler: (...args: any[]) => any) =>
  originalRegisterTool(name, config as any, instrumentTool(name, handler, recordTool))) as typeof server.registerTool;
const outputOptions = {
  maxOutputBytes: z.number().int().positive().max(8_388_608).optional().describe("Raw UTF-8 bytes per stream (default 1 MiB)."),
  tail: z.boolean().optional().describe("Keep last bytes rather than first; incomplete UTF-8 boundary scalars are omitted."),
  logOutput: z.boolean().optional().describe("Opt in to private file-backed raw output logs; may include secrets emitted by command."),
  logQuotaBytes: z.number().int().positive().max(8_388_608).optional().describe("Combined stdout/stderr quota (default 8 MiB); incomplete beyond quota."),
};

server.registerTool(
  "run_powershell",
  { description: "Run a PowerShell script/command on this Windows host in a hidden process (no console window appears). Returns stdout, stderr and exit code. Use for any Windows command, file, or system task.", outputSchema: resultShape, inputSchema: {
    script: z.string().describe("PowerShell script or command to execute."),
    engine: z.enum(process.platform === "win32" ? ["pwsh", "powershell"] : ["pwsh"]).optional().describe("Explicit engine; no fallback when specified. Omit to use only configured PWSH_MCP_EXE if set; otherwise try pwsh then powershell.exe on Windows (pwsh only elsewhere)."),
    parameters: typedParameters.describe("JSON-safe named script parameters, delivered via stdin; never interpolated into source."),
    cwd: z.string().optional().describe("Working directory."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 60000)."),
    errorPolicy: z.enum(["legacy", "strict"]).optional().describe("Default legacy raw script; strict detects unhandled PowerShell ErrorRecords. Check native exits immediately in the script."),
    ...outputOptions,
  } },
  async ({ script, engine, parameters, cwd, timeoutMs, errorPolicy, maxOutputBytes, tail, logOutput, logQuotaBytes }, extra) => {

    const r = await runPowerShell(script, { exe: engine ? engineExecutable(engine) : undefined, parameters, cwd, timeoutMs, errorPolicy, maxOutputBytes, tail, logOutput, logQuotaBytes, signal: extra.signal });
    const result = fromProcess(r, "powershell", "local");
    if (r.exitCode !== null) result.detail.version = detectEngine(r.shell)?.version;
    return toolResult(result, formatResult(r));
  },
);

server.registerTool(
  "list_services",
  {
    description: "List Windows services, optionally filtered by a name pattern. Returns Name, DisplayName, Status.",
    outputSchema: resultShape,
    inputSchema: { filter: z.string().optional().describe("Wildcard name filter, e.g. 'Sql*' or '*backup*'.") },
  },
  async ({ filter }) => {

    const f = filter ? `-Name '${filter.replace(/'/g, "''")}'` : "";
    const script = `Get-Service ${f} | Select-Object Name,DisplayName,Status | Sort-Object Name | Format-Table -AutoSize | Out-String -Width 200`;
    const r = await runPowerShell(script, { timeoutMs: 30_000 });
    return toolResult(fromProcess(r, "powershell", "local"), formatResult(r));
  },
);

server.registerTool(
  "get_service",
  {
    description: "Get detailed status of one Windows service by name.",
    outputSchema: resultShape,
    inputSchema: { name: z.string().describe("Exact service name (not display name).") },
  },
  async ({ name }) => {

    const n = name.replace(/'/g, "''");
    const script = `Get-Service -Name '${n}' | Select-Object Name,DisplayName,Status,StartType,CanStop,CanPauseAndContinue | Format-List | Out-String -Width 200`;
    const r = await runPowerShell(script, { timeoutMs: 30_000 });
    return toolResult(fromProcess(r, "powershell", "local"), formatResult(r));
  },
);

server.registerTool(
  "control_service",
  { description: "Start, stop, or restart a Windows service (requires the MCP host process to have sufficient privileges).", outputSchema: resultShape, inputSchema: {
    name: z.string().describe("Exact service name."),
    action: z.enum(["start", "stop", "restart", "status"]).describe("Action to perform."),
  } },
  async ({ name, action }) => {

    const n = name.replace(/'/g, "''");
    const verb = { start: "Start-Service", stop: "Stop-Service", restart: "Restart-Service", status: "Get-Service" }[action];
    const script = `${verb} -Name '${n}' -ErrorAction Stop; Get-Service -Name '${n}' | Select-Object Name,Status | Format-List | Out-String -Width 200`;
    const r = await runPowerShell(script, { timeoutMs: 120_000 });
    return toolResult(fromProcess(r, "powershell", "local"), formatResult(r));
  },
);

server.registerTool(
  "system_info",
  { description: "Return OS, CPU, memory and disk summary for this Windows host.", outputSchema: resultShape, inputSchema: {} },
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
    return toolResult(fromProcess(r, "powershell", "local"), formatResult(r));
  },
);

server.registerTool(
  "ssh_exec",
  { description: "Run a command on a remote host over SSH, fully in-process (no ssh.exe, no WSL â€” works headless). Use for Linux hosts or any OpenSSH target. Auth via privateKeyPath or password. Returns stdout, stderr, exit code.", outputSchema: resultShape, inputSchema: {
    host: z.string().describe("Remote host or IP."),
    username: z.string().describe("SSH username."),
    command: z.string().describe("Command to run on the remote host."),
    hostKeyPins: z.array(z.string()).optional().describe("Explicit SHA256:base64 trusted host key fingerprints; multiple keys permit rotation."),
    jumps: z.array(z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535).optional(), username: z.string().min(1), hostKeyPins: z.array(z.string()).optional(), credentialRef: z.string().optional(), privateKeyPath: z.string().optional(), passphrase: z.string().optional(), password: z.string().optional() }).strict()).max(4).optional(),
    port: z.number().int().positive().max(65535).optional().describe("SSH port (default 22)."),
    privateKeyPath: z.string().optional().describe("Path to a private key file on this Windows host, e.g. C:\\\\Users\\\\isak\\\\.ssh\\\\id_ed25519."),
    passphrase: z.string().optional().describe("Passphrase for the private key, if any."),
    password: z.string().optional().describe("Password auth (used if no key)."),
    credentialRef: z.string().optional().describe("Operator-provisioned scoped credential reference, exclusive with raw auth."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 60000). Also bounds the connection handshake."),
    maxOutputBytes: z.number().int().positive().max(8_388_608).optional().describe("Cap captured stdout/stderr per stream (bytes, default 1 MiB)."),
    tail: z.boolean().optional().describe("Keep the LAST maxOutputBytes instead of the first (tail) â€” useful for long logs."),
    logOutput: outputOptions.logOutput,
    logQuotaBytes: outputOptions.logQuotaBytes,
  } },
  async ({ host, username, command, port, privateKeyPath, passphrase, password, credentialRef, hostKeyPins, jumps, timeoutMs, maxOutputBytes, tail, logOutput, logQuotaBytes }) => {
    const started = Date.now();
    const auth = await resolveCredential({ credentialRef, transport: "ssh", host, port: port ?? 22, principal: username, privateKeyPath, passphrase, password }, configuredProvider());
    const r = await runSsh({ host, username, command, port, privateKeyPath, passphrase, password, ...auth, hostKeyPins, jumps, knownHostsPath: process.env.POWERSHELL_MCP_KNOWN_HOSTS, deadlineAt: started + (timeoutMs ?? 60000), maxOutputBytes, tail, logOutput: credentialRef || jumps?.some(h => h.credentialRef) ? false : logOutput, logQuotaBytes });
    const safe = credentialRef ? sanitizeCredentialResult(r, auth) : r;
    return toolResult(fromSsh(safe, `${username}@${host}:${port ?? 22}`, maxOutputBytes ?? 1_048_576), formatSsh(`${username}@${host}`, safe));
  },
);

server.registerTool(
  "winrm_exec",
  { description: "Run a command on a remote Windows host via PowerShell Remoting (WinRM / Invoke-Command). Native to Windows Server â€” no SSH server or agent needed on the target, only WinRM enabled. Output captured in-process (no console window).", outputSchema: resultShape, inputSchema: {
    computerName: z.string().describe("Remote Windows host name or IP."),
    command: z.string().describe("PowerShell command/scriptblock body to run remotely."),
    parameters: typedParameters.describe("JSON-safe named remote script parameters; delivered through protected WinRM stdin payload."),
    username: z.string().optional().describe("Credential username (DOMAIN\\\\user or host\\\\user). Omit to use the host process identity."),
    password: z.string().optional().describe("Credential password."),
    credentialRef: z.string().optional().describe("Operator-provisioned scoped credential reference, exclusive with raw auth."),
    useSsl: z.boolean().optional().describe("Use HTTPS/5986 WinRM."),
    authentication: z.enum(["Default", "Negotiate", "Kerberos", "Basic", "CredSSP"]).optional().describe("WinRM auth mechanism."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 120000)."),
    ...outputOptions,
  } },
  async ({ computerName, command, parameters, username, password, credentialRef, useSsl, authentication, timeoutMs, maxOutputBytes, tail, logOutput, logQuotaBytes }, extra) => {

    const auth = await resolveCredential({ credentialRef, transport: "winrm", host: computerName, port: useSsl ? 5986 : 5985, principal: username ?? "", username, password }, configuredProvider());
    const r = await runWinRm({ computerName, command, parameters, username, password, ...auth, useSsl, authentication, timeoutMs, maxOutputBytes, tail, logOutput: credentialRef ? false : logOutput, logQuotaBytes, signal: extra.signal });
    const safe = credentialRef ? sanitizeCredentialResult(r, auth) : r;
    return toolResult(fromProcess(safe, "winrm", computerName), formatResult(safe));
  },
);

const sftpAuth = {
  host: z.string().describe("Remote host or IP."),
  hostKeyPins: z.array(z.string()).optional().describe("Explicit SHA256:base64 trusted host key fingerprints; multiple keys permit rotation."),
  username: z.string().describe("SSH username."),
  port: z.number().int().positive().max(65535).optional().describe("SSH port (default 22)."),
  privateKeyPath: z.string().optional().describe("Path to a private key file on this Windows host."),
  passphrase: z.string().optional().describe("Passphrase for the private key, if any."),
  password: z.string().optional().describe("Password auth (used if no key)."),
    credentialRef: z.string().optional().describe("Operator-provisioned scoped credential reference, exclusive with raw auth."),
  timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 120000)."),
  staged: z.boolean().optional().describe("Opt-in verified staging. Upload fails closed where atomic no-clobber is unsupported; download uses SHA-256 readback and atomic no-clobber hard link."),
};

server.registerTool(
  "sftp_upload",
  { description: "Upload a local file to a remote host over SFTP, in-process (ssh2 â€” no scp.exe, no WSL, headless). Use to deploy scripts/configs to Linux hosts.", outputSchema: resultShape, inputSchema: { localPath: z.string().describe("Local file path on this Windows host."),
    remotePath: z.string().describe("Destination path on the remote host."), ...sftpAuth } },
  async ({ localPath, remotePath, host, username, port, privateKeyPath, passphrase, password, credentialRef, hostKeyPins, timeoutMs, staged }) => {

    const auth = await resolveCredential({ credentialRef, transport: "sftp", host, port: port ?? 22, principal: username, privateKeyPath, passphrase, password }, configuredProvider());
    const o = { direction: "upload" as const, localPath, remotePath, host, username, port, privateKeyPath, passphrase, password, ...auth, hostKeyPins, knownHostsPath: process.env.POWERSHELL_MCP_KNOWN_HOSTS, timeoutMs, staged };
    const r = await runSftp(o);
    const safe = credentialRef ? sanitizeCredentialResult(r, auth) : r;
    return toolResult(fromSftp(safe, `${username}@${host}:${port ?? 22}:${remotePath}`, "upload"), formatSftp(o, safe));
  },
);

server.registerTool(
  "sftp_download",
  { description: "Download a file from a remote host to this Windows host over SFTP, in-process (ssh2 â€” no scp.exe, no WSL, headless).", outputSchema: resultShape, inputSchema: { remotePath: z.string().describe("Source path on the remote host."),
    localPath: z.string().describe("Destination path on this Windows host."), ...sftpAuth } },
  async ({ remotePath, localPath, host, username, port, privateKeyPath, passphrase, password, credentialRef, hostKeyPins, timeoutMs, staged }) => {

    const auth = await resolveCredential({ credentialRef, transport: "sftp", host, port: port ?? 22, principal: username, privateKeyPath, passphrase, password }, configuredProvider());
    const o = { direction: "download" as const, localPath, remotePath, host, username, port, privateKeyPath, passphrase, password, ...auth, hostKeyPins, knownHostsPath: process.env.POWERSHELL_MCP_KNOWN_HOSTS, timeoutMs, staged };
    const r = await runSftp(o);
    const safe = credentialRef ? sanitizeCredentialResult(r, auth) : r;
    return toolResult(fromSftp(safe, `${username}@${host}:${port ?? 22}:${remotePath}`, "download"), formatSftp(o, safe));
  },
);

server.registerTool(
  "run_program",
  { description: "Run a native executable DIRECTLY (no shell) in a hidden process and capture clean stdout/stderr + exit code. Use this for console programs like gh, git, docker, node, python, etc. -- direct execution captures their stdout/stderr without PowerShell pipeline semantics. Historical hidden-shell native stdout loss is executable/environment-specific; it is not universal. Provide the program and an args array (no shell quoting needed).", outputSchema: resultShape, inputSchema: {
    program: z.string().describe("Executable name on PATH or a full path, e.g. 'git' or 'C:\\Program Files\\GitHub CLI\\gh.exe'."),
    args: z.array(z.string()).optional().describe("Arguments as an array; each element is passed verbatim (no shell quoting)."),
    stdin: z.string().max(INPUT_LIMIT).optional().describe("UTF-8 stdin, max 1 MiB bytes. Empty string still opens stdin and sends EOF; no stdin in argv, environment or logs."),
    cwd: z.string().optional().describe("Working directory."),
    timeoutMs: z.number().int().positive().max(900_000).optional().describe("Hard timeout in ms (default 60000)."),
    ...outputOptions,
  } },
  async ({ program, args, stdin, cwd, timeoutMs, maxOutputBytes, tail, logOutput, logQuotaBytes }) => {

    const r = await runProgram(program, args ?? [], { stdin, cwd, timeoutMs, maxOutputBytes, tail, logOutput, logQuotaBytes });
    return toolResult(fromProcess(r, "program", program), formatResult(r));
  },
);
const batchTarget = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('ssh'), host: z.string().min(1), username: z.string().min(1), command: z.string().min(1), port: z.number().int().min(1).max(65535).optional(), privateKeyPath: z.string().optional(), passphrase: z.string().optional(), password: z.string().optional(), credentialRef: z.string().optional(), hostKeyPins: z.array(z.string()).optional(), jumps: z.array(z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535).optional(), username: z.string().min(1), hostKeyPins: z.array(z.string()).optional(), credentialRef: z.string().optional(), privateKeyPath: z.string().optional(), passphrase: z.string().optional(), password: z.string().optional() }).strict()).max(4).optional() }).strict(),
  z.object({ transport: z.literal('winrm'), host: z.string().min(1), command: z.string().min(1), username: z.string().optional(), password: z.string().optional(), credentialRef: z.string().optional(), useSsl: z.boolean().optional(), authentication: z.enum(['Default','Negotiate','Kerberos','Basic','CredSSP']).optional(), parameters: typedParameters }).strict(),
]);
const batchReply = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
server.registerTool('start_remote_batch', { description: 'Opt-in process-local SSH/WinRM batch; 1–32 explicit targets, up to 8 concurrent, per-target deadline. No discovery or retry. SSH supports at most four explicit jumps. Unknown after server restart.', inputSchema: { targets: z.array(batchTarget).min(1).max(32), concurrency: z.number().int().min(1).max(8), timeoutMs: z.number().int().min(1).max(900000) } }, async ({ targets, concurrency, timeoutMs }) => batchReply(remoteBatchStore.status(remoteBatchStore.start({ targets, concurrency, timeoutMs }))));
server.registerTool('remote_batch_status', { description: 'Read ordered per-target batch records; unavailable after process restart.', inputSchema: { id: z.string().regex(/^[0-9a-f]{48}$/) } }, async ({ id }) => batchReply(remoteBatchStore.status(id) ?? { status: 'unknown', reason: 'Job not in this process; no replay or remote ownership proof' }));
server.registerTool('cancel_remote_batch', { description: 'Stop dispatch of queued targets; active targets become unknown, not confirmed terminated.', inputSchema: { id: z.string().regex(/^[0-9a-f]{48}$/) } }, async ({ id }) => batchReply(remoteBatchStore.cancel(id) ?? { status: 'unknown', reason: 'Job not in this process' }));

server.registerTool("runtime_capabilities", { description: "Read-only runtime package, protocol, supported and available engines, transports and limits; no identity, environment or secrets.", inputSchema: {} }, async () => {
  const data = capabilities(VERSION);
  return { structuredContent: data, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
});
const executionId = z.string().regex(/^[0-9a-f]{48}$/);
const executionOwner = z.string().min(1).max(256).describe("Private caller namespace token; keep secret and stable across restarts. This is a bearer secret, not authenticated MCP identity.");
const executionReply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
server.registerTool("start_execution", { description: "Start a local executable directly with durable idempotency and bounded output. No shell; remote targets unsupported.", inputSchema: {
  owner: executionOwner, idempotencyKey: z.string().min(1).max(256), program: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().optional(),
} }, async ({ owner, idempotencyKey, program, args, cwd }) => executionReply(executionStore.start(owner, idempotencyKey, program, args ?? [], cwd)));
server.registerTool("execution_status", { description: "Read a local execution state. Unknown after restart means no automatic replay or verified ownership.", inputSchema: {
  owner: executionOwner, id: executionId,
} }, async ({ owner, id }) => executionReply(executionStore.status(owner, id)));
server.registerTool("read_execution_output", { description: "Read a bounded base64 output page, including while running.", inputSchema: {
  owner: executionOwner, id: executionId, stream: z.enum(["stdout", "stderr"]), offset: z.number().int().nonnegative(), length: z.number().int().positive().max(65536),
} }, async ({ owner, id, stream, offset, length }) => executionReply(executionStore.read(owner, id, stream, offset, length)));
server.registerTool("cancel_execution", { description: "Request bounded local cancellation. Windows Job Objects and Linux subreaper/pidfds confirm owned-tree termination asynchronously; failures remain unknown. Recovered runs are never signalled.", inputSchema: {
  owner: executionOwner, id: executionId,
} }, async ({ owner, id }) => executionReply(executionStore.cancel(owner, id)));
server.registerTool("read_output_log", { description: "Read a bounded raw byte page from an opt-in session log; base64 encoded. Handles are process-local and expire after one hour.", inputSchema: {
  handle: z.string().regex(/^[0-9a-f]{48}$/), stream: z.enum(["stdout", "stderr"]),
  offset: z.number().int().nonnegative(), length: z.number().int().positive().max(65536),
} }, async ({ handle, stream, offset, length }) => ({ content: [{ type: "text" as const, text: JSON.stringify(logStore.read(handle, stream, offset, length)) }] }));
server.registerTool("delete_output_log", { description: "Delete a session log by opaque handle.", inputSchema: { handle: z.string().regex(/^[0-9a-f]{48}$/) } }, async ({ handle }) => ({ content: [{ type: "text" as const, text: JSON.stringify({ deleted: logStore.delete(handle) }) }] }));
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr is safe for logs (stdout is the MCP channel).
  process.stderr.write(`powershell-mcp v${VERSION} ready (stdio)\n`);
  // Telemetry: fire startup ping then arm the 30-min counter flush.
  startupPing(VERSION);
  startFlushTimer(VERSION);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err?.stack || err}\n`);
  process.exit(1);
});


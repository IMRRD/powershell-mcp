# powershell-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents real, **non-intrusive** access to Windows PowerShell.

Most tools that let an agent run Windows commands spawn a visible console window for every call â€” which steals focus and interrupts whatever you're typing. `powershell-mcp` runs everything in a **hidden process** (`windowsHide: true` / no `CreateWindow`), captures structured output, enforces hard timeouts, and exposes purpose-built tools for service and system management. Built for running unattended next to a human at the keyboard.

## Why

- **No popup windows.** Commands run hidden; your foreground app keeps focus.
- **Structured + safe.** Every call returns `{ stdout, stderr, exit_code, duration, timed_out }`. Hard timeout with tree-kill. Output is capped so a runaway command can't flood the context.
- **Real Windows management.** First-class tools for services and system info, not just a raw shell â€” handy for managing Windows servers and backup systems.
- **Cross-shell.** Prefers `pwsh` (PowerShell 7+) and falls back to `powershell.exe`; override with `PWSH_MCP_EXE`.

## Tools

| Tool | Description |
|------|-------------|
| `run_powershell` | Run any PowerShell script/command (hidden). `{ script, cwd?, timeoutMs? }` |
| `run_program` | Run a **native executable directly** (no shell) and capture clean stdout/stderr + exit code - for `gh`/`git`/`docker`/`node` and other console binaries whose output a hidden shell swallows. `{ program, args?, cwd?, timeoutMs? }` |
| `list_services` | List services, optional `filter` wildcard. |
| `get_service` | Detailed status of one service by name. |
| `control_service` | `start` / `stop` / `restart` / `status` a service. |
| `system_info` | OS, CPU, memory, and per-drive disk summary. |
| `ssh_exec` | Run a command on a remote host over SSH, **fully in-process** (no `ssh.exe`, no WSL â€” works headless). `{ host, username, command, port?, privateKeyPath?, passphrase?, password?, timeoutMs? }` |
| `winrm_exec` | Run a command on a remote **Windows** host via PowerShell Remoting (WinRM / `Invoke-Command`). No SSH server or agent needed on the target. `{ computerName, command, username?, password?, useSsl?, authentication?, timeoutMs? }` |
| `sftp_upload` | Upload a local file to a remote host over SFTP, in-process (ssh2 â€” no scp.exe/WSL, headless). `{ localPath, remotePath, host, username, port?, privateKeyPath?, passphrase?, password?, timeoutMs? }` |
| `sftp_download` | Download a remote file to this host over SFTP, in-process. Same params as `sftp_upload`. |

> **Native programs:** Windows PowerShell routes a native command's stdout to the console, so run hidden it is lost. Use `run_program` (direct-exec) for console binaries like `gh`/`git`/`docker`; use `run_powershell` for PowerShell/cmdlet logic.

## See it work

Real calls, real output â€” headless, no console window, structured results:

```text
# ssh_exec â€” run a command on a Linux box, in-process (no ssh.exe, no WSL)
> ssh_exec  host=192.168.0.5  username=isak  command="uptime; systemctl is-active app"
$ ssh isak@192.168.0.5  (exit=0, 818ms)
 2 days, 23:53,  load average: 0.00, 0.01, 0.04
active

# sftp_upload â€” deploy a file, in-process (no scp.exe)
> sftp_upload  localPath=C:\deploy\app.py  remotePath=/home/isak/app.py  host=192.168.0.5 ...
sftp upload: C:\deploy\app.py â†’ isak@192.168.0.5:/home/isak/app.py
OK (9129 bytes, 714ms)
```

## Remote operations

`powershell-mcp` manages more than the local box. Windows' own `ssh.exe` produces no capturable output when run from a windowless/background process, and shipping WSL to every server doesn't scale â€” so remote exec is built in:

- **`ssh_exec`** uses the pure-JS [`ssh2`](https://github.com/mscdex/ssh2) client (no external binary), so it works headless and needs nothing on the target beyond an SSH server. Ideal for Linux hosts.
- **`winrm_exec`** uses native PowerShell Remoting, so a Windows fleet needs only WinRM enabled â€” no per-server install.

## Install

```bash
npm install
npm run build
```

Then register it with your MCP host. For Claude Desktop, add to `claude_desktop_config.json` (see [`examples/`](examples/claude_desktop_config.json)):

```json
{
  "mcpServers": {
    "powershell": { "command": "node", "args": ["C:\\path\\to\\powershell-mcp\\dist\\index.js"] }
  }
}
```

## Develop

```bash
npm run dev        # run from source (tsx)
npm test           # unit + (where a shell is present) integration tests
npm run typecheck
```

CI runs build + tests on both `windows-latest` and `ubuntu-latest`.

## Security notes

- `control_service` and many commands require the MCP host process to run with sufficient privileges.
- The server runs whatever script it's given â€” run it only in environments you trust, behind a host (like Claude) that you control. A future release will add an optional allow/deny policy and confirmation gating.

## License

MIT Â© IMR Research & Development (UK)


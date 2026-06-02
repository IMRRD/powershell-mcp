# powershell-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents real, **non-intrusive** access to Windows PowerShell.

Most tools that let an agent run Windows commands spawn a visible console window for every call — which steals focus and interrupts whatever you're typing. `powershell-mcp` runs everything in a **hidden process** (`windowsHide: true` / no `CreateWindow`), captures structured output, enforces hard timeouts, and exposes purpose-built tools for service and system management. Built for running unattended next to a human at the keyboard.

## Why

- **No popup windows.** Commands run hidden; your foreground app keeps focus.
- **Structured + safe.** Every call returns `{ stdout, stderr, exit_code, duration, timed_out }`. Hard timeout with tree-kill. Output is capped so a runaway command can't flood the context.
- **Real Windows management.** First-class tools for services and system info, not just a raw shell — handy for managing Windows servers and backup systems.
- **Cross-shell.** Prefers `pwsh` (PowerShell 7+) and falls back to `powershell.exe`; override with `PWSH_MCP_EXE`.

## Tools

| Tool | Description |
|------|-------------|
| `run_powershell` | Run any PowerShell script/command (hidden). `{ script, cwd?, timeoutMs? }` |
| `list_services` | List services, optional `filter` wildcard. |
| `get_service` | Detailed status of one service by name. |
| `control_service` | `start` / `stop` / `restart` / `status` a service. |
| `system_info` | OS, CPU, memory, and per-drive disk summary. |

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
- The server runs whatever script it's given — run it only in environments you trust, behind a host (like Claude) that you control. A future release will add an optional allow/deny policy and confirmation gating.

## License

MIT © iaLogics / Isak du Plessis

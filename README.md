# powershell-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents real, **non-intrusive** access to Windows PowerShell.

Most tools that let an agent run Windows commands spawn a visible console window for every call â€” which steals focus and interrupts whatever you're typing. `powershell-mcp` runs everything in a **hidden process** (`windowsHide: true` / no `CreateWindow`), captures structured output, enforces hard timeouts, and exposes purpose-built tools for service and system management. Built for running unattended next to a human at the keyboard.

## Why

- **No popup windows.** Commands run hidden; your foreground app keeps focus.
- **Structured + safe.** Every call returns `{ stdout, stderr, exit_code, duration, timed_out }`. Hard timeout with tree-kill. Output is capped so a runaway command can't flood the context.
- **Real Windows management.** First-class tools for services and system info, not just a raw shell â€” handy for managing Windows servers and backup systems.
- **Cross-shell.** Prefers `pwsh` (PowerShell 7+) and falls back to `powershell.exe`; override with `PWSH_MCP_EXE`.

## Tools

The ten execution tools advertise a versioned MCP `outputSchema` and return the same
`structuredContent` contract (`schemaVersion: 1`) alongside their original
human-readable text. Fields are `executionId` (per call), `transport`, `target`,
`stdout`, `stderr`, nullable `exitCode`, `durationMs`, `timedOut`, `truncation`
(`truncated`, nullable `limitBytesPerStream`), `terminationStatus`, and `detail`.
`terminationStatus` is one of `completed`, `nonzero_exit`, `remote_error`, `timeout`,
`script_error`, `cancelled`, `transport_error`, or `unknown`. Any status other than `completed`
sets MCP `isError`; this is execution status, **not** proof that an application
operation succeeded. A null exit code never means success. SSH includes a
signal or connection error in `detail`; an unsolicited signal is `unknown`, not
caller cancellation. SFTP includes direction and verified local file size where
available. WinRM validates a locally framed invocation result: successful
invocation is `completed`, remote script errors are `remote_error`, and connection
failures are `transport_error`. Its *local* PowerShell host exit is in
`detail.localExitCode`; remote native `exitCode` remains null. Missing or truncated
frames fail closed. `terminationCertainty` is `root_exited` only for an observed
local child exit, otherwise `unknown`; neither status proves descendants or remote
execution stopped after a timeout. These
results never include authentication options or credential values.

### Optional raw output logs

`run_program`, `run_powershell` (legacy or strict), `winrm_exec`, and `ssh_exec` accept `logOutput: true` and
optional `logQuotaBytes` (default/max 8 MiB combined stdout and stderr). Disabled
by default: no log directory is created without opting in. Raw child output is
written separately per stream, independently of the display byte cap. Strict
PowerShell and WinRM persist only validated command payload output (stdout);
framing, credentials, stdin, and wrapper diagnostics are never persisted. Their
PowerShell pipeline/remote item collection still buffers output before framing;
this feature does not bound producer-side memory. A result's
`log` contains an unpredictable process-local handle, `complete`, byte counts,
and expiry timestamp. `complete: false` means the quota or a write failed; never
interpret it as the entire output. Read through `read_output_log` with handle,
stream, byte offset and length (maximum 65,536 bytes); `data` is base64, and
`nextOffset`/`totalBytes` support pagination. `delete_output_log` removes a log.
Handles are available only in this MCP process, never filesystem paths; only
the current OS user and SYSTEM have directory ACL access on Windows (0700/0600
on POSIX). The process reserves at most 64 MiB total, expires completed handles one
hour after finish on the next log operation (active handles remain reserved), and removes its own files on normal exit. A hard
crash may leave private files requiring operator cleanup under the configured `POWERSHELL_MCP_LOG_PARENT` or `TMPDIR`, otherwise the OS temp path.
Commands can emit secrets: opt-in logs preserve emitted stdout/stderr verbatim,
so do not enable logging for sensitive commands. Passwords, stdin and MCP
envelopes are never intentionally logged. Framed payloads are bounded to the
log quota before JSON/base64 transport, and `complete: false` reports any
producer-side truncation. A bounded local envelope buffer is still required.

Execution tools accept `maxOutputBytes` (1–8,388,608, default 1 MiB **per
stream**) and `tail` (default false: retain the head; true: retain the tail).
`truncation.stdout` and `.stderr`, when the producer observed stream bytes,
report `observedBytes`, `capturedBytes`, `omittedBytes`, and `truncated` on the
original UTF-8 input bytes. `capturedBytes + omittedBytes = observedBytes`;
these are **not** lengths of pretty-printed text. An incomplete UTF-8 scalar at
a head/tail cut is omitted and counted as such. Malformed input is displayed
with replacement characters; its captured count refers to original bytes, not
the encoded replacement characters. Raw structured `stdout`/`stderr` preserve
newlines; human-readable formatting may trim whitespace. Wrapper-generated
diagnostics are not producer bytes and have no invented stream counts. Some
failed/early remote calls cannot report producer-side byte counts. No full logs
are persisted by default; opt-in runs return a protected output-log handle.
Strict PowerShell and WinRM cap their framed payload *inside* the envelope so
large successful outputs remain successful, but their existing PowerShell
pipeline/WinRM remote-side item collection still buffers full command output
before that cap. The local process drains its two OS pipes with bounded capture;
this is **not** an end-to-end bounded-memory guarantee for remoting.

| Tool | Description |
|------|-------------|
| `run_powershell` | Run any PowerShell script/command (hidden). `{ script, cwd?, timeoutMs?, errorPolicy?: "legacy" | "strict", maxOutputBytes?, tail? }` |
| `runtime_capabilities` | Read-only package/protocol version, supported and detected available engines, engine policy (without exposing configured override paths), transports and input/output/timeout limits. Does not return user identity, environment or secrets. |
| `run_program` | Run a **native executable directly** (no shell) and capture clean stdout/stderr + exit code - for `gh`/`git`/`docker`/`node` and other console binaries whose output a hidden shell swallows. `{ program, args?, cwd?, timeoutMs?, maxOutputBytes?, tail? }` |
| `list_services` | List services, optional `filter` wildcard. |
| `get_service` | Detailed status of one service by name. |
| `control_service` | `start` / `stop` / `restart` / `status` a service. |
| `system_info` | OS, CPU, memory, and per-drive disk summary. |
| `ssh_exec` | Run a command on a remote host over SSH, **fully in-process** (no `ssh.exe`, no WSL â€” works headless). `{ host, username, command, port?, privateKeyPath?, passphrase?, password?, timeoutMs?, maxOutputBytes?, tail? }` |
| `winrm_exec` | Run a command on a remote **Windows** host via PowerShell Remoting (WinRM / `Invoke-Command`). No SSH server or agent needed on the target. `{ computerName, command, username?, password?, useSsl?, authentication?, timeoutMs?, maxOutputBytes?, tail? }` |
| `sftp_upload` | Upload a local file to a remote host over SFTP, in-process (ssh2 â€” no scp.exe/WSL, headless). `{ localPath, remotePath, host, username, port?, privateKeyPath?, passphrase?, password?, timeoutMs? }` |
| `sftp_download` | Download a remote file to this host over SFTP, in-process. Same params as `sftp_upload`. |

### Opt-in verified staged SFTP

`sftp_upload` and `sftp_download` accept `staged: true` (default false).
The default retains the legacy direct `fastPut`/`fastGet` behavior; it does not
promise destination preservation or content verification. Staged transfers create
an exclusive, unpredictable `.part` file beside the destination, verify SHA-256
against a readback, and finalize without replacing an existing destination.
Upload uses the server's `hardlink@openssh.com` extension for no-clobber
finalization; servers without that capability fail closed rather than falling
back to an overwriting rename. Download uses a local hard link for no-clobber
finalization. The staging and destination paths must support hard links on the
same filesystem; filesystem permissions, server extension behavior and
concurrent external writers can still cause failure. Only an exclusively created
temporary path is eligible for cleanup; an existing destination is not deleted.

Structured `detail` adds `verification` (`not_started`, `failed`, or
`sha256_matched`), `finalized` (true/false, or absent when a remote finalization
request was sent but its outcome is unknown), `cleanup` (`not_needed`, `removed`,
or `failed`, or `unknown` when remote staging may remain), `sha256` on verified success, and `bytes` when the staged copy's
size was observed. A cleanup failure **after** successful finalization may
report a failed operation with `finalized: true`; reconcile the destination and
orphaned staging file separately. On timeout or connection loss, the reported
cleanup is not proof that remote work stopped or no orphan remains. In particular,
do not retry an ambiguous finalization as though `finalized: false` had been
proved. SHA-256 readback checks observed bytes, not an immutable source snapshot:
source files must be kept stable by the caller; concurrent mutation outside the
observed comparison window is not prevented, and there is no source lock.

Only synthetic loopback SFTP fixtures exercise this feature in the repository;
live-server extension behavior, filesystem semantics, and permissions remain
unverified and require operator validation before deployment.

> **Native programs:** Windows PowerShell routes a native command's stdout to the console, so run hidden it is lost. Use `run_program` (direct-exec) for console binaries like `gh`/`git`/`docker`; use `run_powershell` for PowerShell/cmdlet logic.

**Typed inputs:** `run_powershell` accepts `engine: "pwsh" | "powershell"` (Windows; only `pwsh` elsewhere). An explicit choice selects only that engine and overrides `PWSH_MCP_EXE`; if it is missing, execution fails without fallback. When `engine` is omitted and `PWSH_MCP_EXE` is configured, only that executable is attempted; a missing configured executable fails without fallback. Only when neither is selected does automatic discovery try `pwsh`, then `powershell.exe` on Windows (only `pwsh` on other platforms). `runtime_capabilities.availableEngines` reports detected named engines, not whether the configured override is runnable. Its result `detail.shell` reports the actual executable used and `detail.version` the version when detectable. `parameters` is an optional named JSON object of strings, finite numbers, booleans, nulls, arrays and nested objects (max 8 levels, 1 MiB serialized UTF-8). Declare matching `param($name)` in the script. Values are sent on stdin and bound as data, not interpolated into source; the default remains legacy (strict must be requested explicitly). `winrm_exec` accepts the same `parameters` and sends them inside its protected stdin payload for remote binding. Never deliberately print secrets: emitted output may enter results or opt-in output logs.

`run_program` accepts optional UTF-8 `stdin` (at most 1 MiB **bytes**, not characters). An empty string opens the pipe and sends EOF; omitted stdin inherits no pipe. The child receives no input in argv/environment or telemetry, and stdin is not captured in logs. Oversize is rejected before child launch; Node stream writes respect backpressure, and early exit, timeout and pipe errors are handled without unhandled stream errors. Do not send secrets to programs that echo them.

`run_powershell` defaults to **legacy** raw `-Command` semantics. Opt into
`errorPolicy: "strict"` to parse the script before execution and report unhandled
PowerShell `ErrorRecord`s as `script_error`. Strict sets command-level default
`-ErrorAction Stop`, so an unhandled `Write-Error` stops subsequent commands;
explicit `-ErrorAction Continue` still continues (and reports an error), while
`-ErrorAction SilentlyContinue` suppresses that error. Handled `try/catch`
exceptions are not failures. Its framed wrapper sends the source over stdin;
script output is retained before failures. Structured diagnostics render only
selected exception messages and metadata, not `ErrorRecord` source context;
legacy raw output retains the engine's native formatting.
`errorRecords` contains at most eight summaries (`category`,
`fullyQualifiedErrorId`, `exceptionType`, `message`), with each field shortened to
256 characters; `errorRecordsTruncated` flags omitted records/fields. Diagnostics
can contain sensitive **user-emitted text**; this is bounding, not redaction.
The strict wrapper changes script scope and output formatting; choose legacy for
scripts relying on raw `exit`, argument binding, or stream semantics. A missing or
truncated wrapper envelope is a transport error, never reported as success.

Neither policy proves that *every* native command succeeded: `$LASTEXITCODE` only
describes the latest native call, and a later cmdlet does not validate earlier
native calls. Explicitly check immediately after each native command, e.g.
`& mytool.exe; if ($LASTEXITCODE -ne 0) { throw "mytool failed: $LASTEXITCODE" }`.
Native stderr alone is not failure. Strict retains command-level Stop without
setting global `$ErrorActionPreference = 'Stop'`, which would turn successful
native stderr into a terminating exception on Windows PowerShell 5.1. Redirected
native `NativeCommandError` records are treated as diagnostic output rather than
script errors; other PowerShell errors still stop by default. For an explicit
native exit code use `run_program` or check `$LASTEXITCODE` immediately in the
script. These defaults are not a sandbox: user scripts can override error
preferences and deliberately emit arbitrary content (including secrets) in output
or exception messages. WinRM preserves its legacy remote error policy, while its
structured error output also avoids rendering source context.

## Experimental local execution lifecycle

`start_execution` accepts `owner` (a secret caller-chosen namespace token), `idempotencyKey`, `program`, `args` and optional `cwd`. It starts a **local executable directly**, without a shell. `execution_status`, `read_execution_output` (base64 byte pages, at most 65,536 bytes) and `cancel_execution` require the same owner token and opaque execution ID. A repeated owner/key/request returns the same ID; a different request with that key fails. Never retry with a new key after an ambiguous launch. The owner token is a bearer capability, **not** MCP transport authentication; callers sharing the token can read or cancel one another's executions.

Metadata and output live under `POWERSHELL_MCP_EXEC_PARENT/powershell-mcp-executions` or the private temporary parent. The dedicated directory is restricted to the current Windows SID and SYSTEM (or POSIX mode 0700); records contain request hashes, not raw arguments or scripts. Output can contain secrets; quota is 8 MiB combined per execution and at most 64 retained executions. No encryption or automatic retention cleanup is provided: archive/delete the dedicated store **only when no execution is active**, and never clear idempotency history if duplicate side effects would be unsafe. Do not point the parent at a shared/untrusted location.

Disconnecting an MCP client does not cancel its running process while the server lives. A new server can read completed persisted output but classifies a previously running/reserved execution as `unknown`; it will neither adopt nor automatically relaunch or cancel it. The same limitation applies after server crash and OS reboot; `unknown` does not prove the process remains alive or stopped. On Windows, cancellation requests the packaged Job Object supervisor to terminate its owned tree and subsequently reports `cancelled` only after job accounting reaches zero; until then status remains `running`, and failed/absent proof remains `unknown`. Normal supervisor closure uses kill-on-job-close. POSIX cancellation remains `unknown` because descendant termination is not proven. It never uses bare-PID `taskkill`. The stored output quota is 8 MiB; Windows raw spool files can temporarily exceed it during high-volume output and should be monitored until bounded streaming replaces spooling. Commands with side effects require independent reconciliation before a new idempotency key is used. SSH/WinRM remote supervision and remote termination proof are unsupported in this local slice.

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

## Telemetry (anonymous, opt-out)

On startup the server sends a one-time ping (host id, version, OS, timestamp) and flushes per-tool call **counts** every 30 minutes (and on exit). This helps prioritise which tools matter. **No command content, arguments, output, or paths are ever sent.**

- Disable entirely: set `POWERSHELL_MCP_NO_TELEMETRY=1`.
- Override the endpoint: set `POWERSHELL_MCP_TELEMETRY_URL`.

The collector under [`collector/`](collector/) is a standalone Node.js service (JSONL append, systemd unit, nginx snippet, `deploy.sh`) deployed separately.

## Opt-in remote batches (first #23 slice)

`start_remote_batch` accepts an explicit `targets` list (1–32), `concurrency` (1–8), and a per-target full-invocation `timeoutMs` (1–900000). Admission is capped at 32 retained jobs, 256 retained targets, 8 genuinely unsettled executions, and 1 MiB of request data per job; retained results have a 2 MiB aggregate cap. Completed jobs expire after 60 seconds (lazy cleanup on the next batch call); expired IDs return unknown. A deadline or cancellation marks an active invocation unknown but does not prove remote termination or release its live execution slot until the adapter actually settles. Queued cancelled targets never dispatch; no live work is evicted to admit new requests. Each target chooses `transport: "ssh"` or `"winrm"`, `host`, `command`, and the same transport-specific credential/trust inputs as `ssh_exec` or `winrm_exec`. It returns an opaque process-local ID and an ordered record for every supplied target. `remote_batch_status({id})` reads the current snapshot; `cancel_remote_batch({id})` prevents queued dispatch. Completed records are independent: one unreachable host does not conceal other outcomes. SSH host trust and credential-reference scope are checked by the existing adapters. Outputs are bounded to 64 KiB per stream and exact known credential values are redacted; commands may themselves print sensitive material, so treat results as sensitive.

Cancellation **does not prove remote termination**: queued targets report `cancelled`, active targets report `unknown` and may continue remotely; their late results do not overwrite the unknown record. Adapter timeouts bound the local wait, not remote side effects. Jobs exist only in this server process; after restart the ID returns `unknown`, without replay or ownership inference. No inventory discovery, automatic retries, or agent forwarding is provided. SSH command targets may specify up to four explicit `jumps` (each `{host,port?,username,hostKeyPins?,credentialRef?,privateKeyPath?,passphrase?,password?}`); each hop uses its own trust and authentication, with `credentialRef` scoped exactly to that hop. The final endpoint retains its own separately verified trust and authentication. Each forwarded TCP channel is opened only after the previous hop authenticates; the destination command runs only after all hops and final authentication. One operation deadline includes credential lookup and all forwarding. On local deadline all owned clients/channels are closed, but remote termination remains unproven. SFTP upload/download, WinRM, and local tools do not support jump routing. SSH batch targets use the same command adapter and may include the same jumps. No implicit hops or forwarding credentials to the destination.



## Install

The canonical npm package is [**`@imrrd/powershell-mcp`**](https://www.npmjs.com/package/@imrrd/powershell-mcp).

Run it directly from npm in an MCP client:

```json
{
  "mcpServers": {
    "powershell": {
      "command": "npx",
      "args": ["-y", "@imrrd/powershell-mcp@latest"]
    }
  }
}
```

Or install the CLI globally:

```bash
npm install -g @imrrd/powershell-mcp
```

> **Migrating:** `powershell-mcp` is deprecated and will not receive a patched legacy release. Remove it and install `@imrrd/powershell-mcp@0.5.3` or later.

For development from source:

```bash
npm install
npm run build
```

See [`examples/claude_desktop_config.json`](examples/claude_desktop_config.json) for the canonical package-based client configuration.

## Scoped credential references (Windows)

`ssh_exec`, `sftp_upload`, `sftp_download`, and `winrm_exec` accept `credentialRef`. The server resolves it only from the operator-configured `POWERSHELL_MCP_CREDENTIAL_DIR` on Windows; the caller cannot supply a store path. References are opaque ASCII names (1–128 characters, letters/digits/underscore/hyphen, starting alphanumeric), mapped to SHA-256-named DPAPI CurrentUser files. No credential-management MCP tool is exposed. Provision offline as the **same Windows identity** that runs the server, in a directory inaccessible to other principals, using `scripts/provision-credential.ps1 -Directory <private-dir> -Reference <name>` with a JSON record on **stdin**, never as a command-line argument. Example record shape (replace placeholders only in a private operator session): `{"transport":"ssh","host":"host.example","port":22,"principal":"operator","password":"<secret>"}`. Supported transport values are `ssh`, `sftp`, `winrm`; use `privateKey` plus optional `passphrase` instead of `password` for SSH/SFTP. The script creates a private ACL directory, DPAPI-protects the entire record, writes atomically, and refuses overwrite. Protect and delete any source JSON yourself. Configure the server process environment with the directory path; this is operator configuration, **not** an agent authorization bypass. Do not put actual credentials or local paths in checked-in configuration.

Scope must match the requested transport, exact host string, port (SSH/SFTP default 22; WinRM HTTP 5985 or HTTPS 5986), and principal (`username`) before the secret is returned. A reference cannot be mixed with `password`, `passphrase`, or `privateKeyPath`. Existing raw password/passphrase inputs remain supported for compatibility, as do SSH/SFTP private-key paths and WinRM integrated identity when `username` is omitted; migrate raw secrets to references deliberately, not silently. Referenced calls disable private full-output logging and redact exact known secret strings and their common base64 encodings from returned diagnostics. They cannot guarantee removal of arbitrary transformed or fragmented secrets deliberately emitted by a remote command; do not execute commands that print secrets. DPAPI entries are tied to the provisioning Windows user and machine; back up or reprovision through approved operator processes. On non-Windows, references fail closed unless an application explicitly supplies a provider in code.

## Develop

```bash
npm run dev        # run from source (tsx)
npm test           # unit + (where a shell is present) integration tests
npm run typecheck
```

CI runs build + tests on both `windows-latest` and `ubuntu-latest`.

## SSH/SFTP host trust (breaking secure default)

SSH and SFTP now **reject unknown host keys**. Authentication and command/file operations do not begin without verified trust. Provision trust out of band, independently of the network endpoint, before migrating existing calls. Either supply `hostKeyPins: ["SHA256:<43-character-base64>"]` in the tool call or configure `POWERSHELL_MCP_KNOWN_HOSTS` in the server process environment to an operator-controlled OpenSSH known-hosts file. There is no caller-supplied known-hosts path and no automatic trust-on-first-use or changed-key update. Missing trust and changed keys have distinct error messages. Credential references only provide authentication, never host trust.

Pins are SHA-256 digests of the SSH wire-format public host key (standard OpenSSH `SHA256:` fingerprint without trailing `=`). Pins verify the presented key, irrespective of the requested host name; treat each pin as scoped to the target you intend to call. The known-hosts policy matches the `host` input exactly, using `host` for port 22 or `[host]:port` for other ports. It supports plain single-host entries of the form `host key-type base64-public-key`, including multiple entries per identity for planned rotation. It does not interpret aliases, host patterns, comma-separated names, hashed entries, markers (`@cert-authority`, `@revoked`), or certificates: unsupported entries fail closed rather than being skipped. Keep this file private, bounded, and operator-maintained; do not point at an untrusted or model-selected file. For rotation, stage the new trusted key alongside the old key (or supply both pins) after separate verification, then remove the old one. A mismatch never learns or replaces a key. There is no insecure bypass option.

## Security notes

- `winrm_exec` sends caller-controlled connection details to the local PowerShell child over stdin; credentials are not placed in process arguments or environment variables.
- `control_service` and many commands require the MCP host process to run with sufficient privileges.
- The server runs whatever script it's given â€” run it only in environments you trust, behind a host (like Claude) that you control. A future release will add an optional allow/deny policy and confirmation gating.

## License

MIT Â© IMR Research & Development (UK)


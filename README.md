# powershell-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents real, **non-intrusive** access to Windows PowerShell.

Most tools that let an agent run Windows commands spawn a visible console window for every call â€” which steals focus and interrupts whatever you're typing. `powershell-mcp` runs everything in a **hidden process** (`windowsHide: true` / no `CreateWindow`), captures structured output, enforces hard timeouts, and exposes purpose-built tools for service and system management. Built for running unattended next to a human at the keyboard.

## Why

- **Hidden process configuration.** Local child creation uses `windowsHide: true`; foreground focus preservation needs interactive desktop acceptance and is not established by headless CI.
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
PowerShell persists validated command payload stdout; WinRM also persists its
validated remote console stderr. Framing, credentials, stdin, and wrapper
diagnostics are never persisted. A result's
`log` contains an unpredictable process-local handle, `complete`, byte counts,
and expiry timestamp. `complete: false` means producer truncation, quota loss, or a write failure; never
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
envelopes are never intentionally logged. Framed payload retention is bounded
to the larger of the display cap and log quota per stream before JSON/base64
transport. The log quota remains combined across both streams; `complete: false`
reports any producer truncation or log quota loss. Tail mode can therefore
produce an incomplete suffix log.

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
Strict PowerShell and WinRM stream formatted pipeline lines into a fixed-capacity
UTF-8 writer, counting all bytes after retention fills. WinRM runs this writer
inside the remote script block, before remoting serialization. Direct console
stdout joins payload stdout without corrupting framing; remote console stderr
has a separate bounded writer and counters. Error summaries retain at most eight
shortened records as errors arrive. Producer retention is O(cap), with fixed
encoding scratch space; terminal JSON/base64 envelopes and local pipe capture
also have finite bounds. This does not bound memory allocated by user scripts,
individual objects/lines, PowerShell formatting, or remoting internals. The
writer requires `Add-Type` in each execution runspace; constrained endpoints
that forbid compilation are unsupported and fail closed. Counts describe
rendered UTF-8 pipeline output, with platform newlines from `Out-String -Stream`,
and UTF-8 console text, rather than original native program bytes. Use
`run_program` for native byte provenance.

Strict/WinRM return payload output only after a validated terminal frame. Timeout,
cancellation, malformed frames, or direct OS stdout writes that bypass the console
writer fail closed without inventing producer counts or returning frame data as
command output; unfinished framed logs are discarded. MCP cancellation requests
termination of the local PowerShell process tree and releases its log reservation;
it does not prove that remote work or descendants stopped.

| Tool | Description |
|------|-------------|
| `run_powershell` | Run any PowerShell script/command (hidden). `{ script, cwd?, timeoutMs?, errorPolicy?: "legacy" | "strict", maxOutputBytes?, tail? }` |
| `runtime_capabilities` | Read-only package/protocol version, supported and detected available engines, engine policy (without exposing configured override paths), transports and input/output/timeout limits. Does not return user identity, environment or secrets. |
| `run_program` | Run a **native executable directly** (no shell) and capture its stdout/stderr + exit code with direct argument passing. `{ program, args?, cwd?, timeoutMs?, maxOutputBytes?, tail? }` |
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

> **Native programs:** Historical #1 observed missing native stdout from a hidden PowerShell host for particular executables. This is not universal: on a Windows PowerShell 5.1 local probe (October 20, 2026), `cmd.exe /d /c echo NATIVE_CMD_24`, `git.exe --version`, and `node.exe --version` all produced captured stdout. That probe does not reproduce or refute the original `gh.exe`/`where.exe` failure on its host. Prefer `run_program` (direct exec) when you need native arguments, exit status and stdout/stderr independent of PowerShell pipeline behavior; use `run_powershell` for cmdlets and scripts. Validate the specific executable and host before relying on either path.

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

Disconnecting an MCP client does not cancel a durable execution while the server lives. After MCP restart, crash or OS reboot, a new server preserves valid completed records/output and returns `unknown` for any previously running/reserved run. It never adopts a stored PID, infers ownership from PID liveness, signals an old process or automatically relaunches an ambiguous request. Reusing the same owner/key/request returns the same ID even when unknown; conflicting requests fail. Invalid metadata and missing or length-mismatched output recover conservatively; a surviving key reservation prevents replay even without readable metadata. Output content has no independent integrity checksum. Keep the store on persistent local storage if handles must survive a reboot: an OS-cleaned temporary directory cannot provide that contract.

This specifies reboot reconciliation without asserting a real reboot or power-loss test. File fsync and atomic metadata rename provide process-restart recovery; they do not establish crash consistency of directory entries or hardware power-loss durability (especially on Windows). If the entire store/idempotency history is lost, duplicate prevention across that loss cannot be guaranteed; reconcile side effects externally before submitting anything again.

All local production callers (`run_program`, legacy/strict `run_powershell`, the local WinRM host and the durable lifecycle) use the same private supervisor channel. Windows 10 1703+/Server 1709+ launches suspended into a non-breakaway Job Object with Desktop Bridge child breakaway disabled (including Store-installed PowerShell) and retains native handles; cancellation requires zero active job processes before proof. Job close also requests tree cleanup. Linux requires `pwsh` and a kernel supporting subreapers and pidfds (Linux 5.3+); the supervisor adopts orphan descendants, including processes which detach into another session, and signals through pidfds only after checking direct-child ownership. Unsupported supervision fails closed. Neither platform uses bare-PID `taskkill` or a negative-PID group kill. Parent/child/grandchild exits must all be established before durable `cancelled`. Cancellation is requested once, cleanup has a four-second native deadline and a six-second caller bound; failed/absent proof returns `unknown` and does not trigger relaunch or repeated cancellation. The deadline bounds the local wait, not the termination of an inaccessible process.

Persisted output uses bounded streaming (8 MiB combined), without raw spool files. SSH/WinRM remote supervision remains unsupported: timeout, local-host exit, connection refusal and authorization denial never establish that a remote process stopped. `terminationCertainty` stays `unknown` for every WinRM/SSH result. These paths do not automatically retry commands. Commands with side effects require independent reconciliation before a new idempotency key is used.

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

`powershell-mcp` supports SSH in-process, without depending on a native SSH executable or a windowed console. The historical native-output issue is described above; native stdout capture varies by executable and environment:

- **`ssh_exec`** uses the pure-JS [`ssh2`](https://github.com/mscdex/ssh2) client (no external binary), so it works headless and needs nothing on the target beyond an SSH server. Ideal for Linux hosts.
- **`winrm_exec`** uses native PowerShell Remoting, so a Windows fleet needs only WinRM enabled â€” no per-server install.

## Telemetry (anonymous, opt-out)

On startup the server sends a one-time ping (host id, version, OS, timestamp) and flushes per-tool call **counts** every 30 minutes (and on exit). This helps prioritise which tools matter. **No command content, arguments, output, or paths are ever sent.**

- Disable entirely: set `POWERSHELL_MCP_NO_TELEMETRY=1`.
- Override the endpoint: set `POWERSHELL_MCP_TELEMETRY_URL`.

The collector under [`collector/`](collector/) is a standalone Node.js service (JSONL append, systemd unit, nginx snippet, `deploy.sh`) deployed separately. Maintainers can run an [offline private aggregate report](collector/REPORTING.md) on an authorized local export; unknown-origin installations are **not** labelled external users. Historical JSONL may contain `_ip`; new records do not store peer IP. Protect historical raw records and consult the deployment operator for actual access and retention policy. The stable random installation ID is pseudonymous, not anonymous.

Telemetry is optional (`POWERSHELL_MCP_NO_TELEMETRY=1` prevents ID, queue and network activity). The candidate versioned schema includes an event UUID, and accepts acknowledgements only for the same UUID. Pending events live under `~/.powershell-mcp-telemetry` (at most 128 events); unresolved events are retained for retry with capped exponential backoff. Do not place this home directory on a shared filesystem: filesystem permissions are not a proven private ACL on Windows. A full queue silently drops new events; power loss before directory metadata persistence can lose a queued event. This is at-least-once best effort, not guaranteed delivery. Collector dedup uses a disk-backed receipt sidecar (`telemetry.jsonl.receipts/`) rebuilt from historical JSONL on startup, with bounded line memory and per-ID lookup rather than per-request archive scans or a 64 MiB cutoff. Keep the sidecar on the same durable volume as the JSONL; startup rebuild may take time on large histories and fails closed on corrupt/oversized records. On Linux the collector syncs receipt and quarantine directory metadata before acknowledging or truncating; Windows directory fsync is not available through Node and Windows collector durability is not established. Collector health returns 503 if recovery or storage fails. Deploy the compatible collector **before** any versioned client, and rollback clients before collector; legacy payloads remain accepted. No command, argument, output, path or credential is sent. Denied disclosure: raw identities, IPs and historical JSONL must not be made public.

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

> **Migrating:** `powershell-mcp` is deprecated and will not receive a patched legacy release. Remove it and install the approved scoped release (`@imrrd/powershell-mcp@0.6.0` after publication).

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

CI requires three lanes: Windows PowerShell 5.1 (`powershell.exe`), Windows PowerShell 7 (`pwsh`), and Linux PowerShell 7 (`pwsh`). Missing engines fail instead of skipping the installed-artifact engine gate. Each lane runs locked `npm ci`, typecheck, build, the existing regression suite with explicit discovered/passed/failed/skipped counts and required-suite discovery checks, then `npm pack` and installs the resulting tarball into a temporary project. The installed CLI is exercised over MCP stdio for schema/version, native arguments and byte bounds, failure, timeout, synthetic credential/trust rejection, and explicit engine selection. SSH/SFTP tests use synthetic/loopback fixtures; opt-in live SSH tests remain skipped unless intentionally configured and are not release evidence. A green local run on Windows does not prove the Linux lane passed.

### Release compatibility and operator gates

The candidate is canonical `@imrrd/powershell-mcp@0.7.0` with MCP output `schemaVersion: 1`; existing text `content` accompanies structured results. Telemetry wire schema v2 is separate from the MCP output schema; the collector must remain v2-compatible once any v2 client can send or replay queued events. The frozen unscoped `powershell-mcp` compatibility package receives no changes or release. The CI tarball is a local build artifact, not proof of a published registry version. Before any separately authorized release, compare the candidate tag/commit, package and lockfile version, `server.json` identity/version and packed manifest; preserve the CI run and tarball digest as provenance. Verify clients consuming text-only responses and schema v1, credential/trust migrations, and runtime behavior against an approved previous version. Roll back by pinning/reinstalling the previously approved **scoped** package version and restoring its client configuration; do not publish or revive the legacy name. Persisted lifecycle records and credential stores are not automatically reversible: reconcile running/unknown jobs and back up/reprovision DPAPI entries through approved operator processes before switching versions. A tag or CI pass does not authorize publishing, deployment, or production rollover. On a real interactive Windows desktop, manually verify no popup and unchanged foreground focus for `run_powershell`/`run_program` and cancellation; headless CI cannot prove foreground focus preservation.

## SSH/SFTP host trust (breaking secure default)

SSH and SFTP now **reject unknown host keys**. Authentication and command/file operations do not begin without verified trust. Provision trust out of band, independently of the network endpoint, before migrating existing calls. Either supply `hostKeyPins: ["SHA256:<43-character-base64>"]` in the tool call or configure `POWERSHELL_MCP_KNOWN_HOSTS` in the server process environment to an operator-controlled OpenSSH known-hosts file. There is no caller-supplied known-hosts path and no automatic trust-on-first-use or changed-key update. Missing trust and changed keys have distinct error messages. Credential references only provide authentication, never host trust.

Pins are SHA-256 digests of the SSH wire-format public host key (standard OpenSSH `SHA256:` fingerprint without trailing `=`). Pins verify the presented key, irrespective of the requested host name; treat each pin as scoped to the target you intend to call. The known-hosts policy matches the `host` input exactly, using `host` for port 22 or `[host]:port` for other ports. It supports plain single-host entries of the form `host key-type base64-public-key`, including multiple entries per identity for planned rotation. It does not interpret aliases, host patterns, comma-separated names, hashed entries, markers (`@cert-authority`, `@revoked`), or certificates: unsupported entries fail closed rather than being skipped. Keep this file private, bounded, and operator-maintained; do not point at an untrusted or model-selected file. For rotation, stage the new trusted key alongside the old key (or supply both pins) after separate verification, then remove the old one. A mismatch never learns or replaces a key. There is no insecure bypass option.

## Security notes

- `winrm_exec` sends caller-controlled connection details to the local PowerShell child over stdin; credentials are not placed in process arguments or environment variables.
- `control_service` and many commands require the MCP host process to run with sufficient privileges.
- The server runs whatever script it's given â€” run it only in environments you trust, behind a host (like Claude) that you control. A future release will add an optional allow/deny policy and confirmation gating.

## License

MIT Â© IMR Research & Development (UK)


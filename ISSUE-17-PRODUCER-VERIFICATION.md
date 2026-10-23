# Issue #17 producer candidate — 2026-10-23

Base: `bd3d5c9`. Scope follows [issue #17](https://github.com/IMRRD/powershell-mcp/issues/17)
and its producer-buffering reconciliation comment. This is a local candidate,
not issue closure, publication, deployment, or live remoting acceptance.

## Implementation and production path

`src/index.ts` passes public output options and MCP request cancellation to
`runPowerShell` / `runWinRm`, then maps results through `fromProcess`.
Strict PowerShell now formats pipeline output incrementally into the shared
`McpBoundedWriter` from `src/producer-output.ts`. The writer uses a cap-sized
byte ring, fixed encoding scratch buffers, an incremental UTF-8 encoder, and
64-bit observed-byte counters. Direct console stdout uses the same writer.
Error summaries are shortened and capped as errors arrive, without retaining
the complete item/error collections or formatting the entire transcript.

WinRM embeds that producer inside its remote script block and passes retention
options as arguments before remoting serialization. Remote console stderr has
an independent bounded writer. The local adapter validates terminal framing,
per-stream accounting and retention bounds before display/logging. Its envelope
budget accounts for both streams. Display retention uses the larger of display
cap and log quota, preserving display when the log quota is smaller; persisted
logs still enforce their combined quota. Timeout/cancellation discard unfinished
framed logs and release reservations. Cancellation never establishes remote or
descendant termination certainty.

`test/producer-adapter.test.ts` exercises production WinRM input construction,
random framing, launch options, decoding, log reservations, timeout and
cancellation. Only `Invoke-Command` is replaced by a local function.
`scripts/installed-smoke.mjs` packs this clone, installs the tarball into a fresh
directory, and uses the installed MCP stdio server. Added assertions cover
sustained strict output on both streams, head/tail counters, independent display
and log quotas, log byte readback, MCP cancellation and subsequent server use.

## Regression evidence

Before implementation, the initial sustained console/pipeline regression failed
all four cases: strict and WinRM on Windows PowerShell and PowerShell 7. Strict
reported invalid framing; WinRM reported transport errors. The local report is
`.scratch/producer-before.json` (4 discovered, 0 passed, 4 failed).

The completed suite additionally runs concurrent C# console stdout/stderr workers
while the PowerShell pipeline emits output; tests zero/tiny/exact caps, head/tail,
Unicode scalar boundaries, split surrogate writes, malformed raw OS stderr bytes,
error floods, quota loss, timeout and cancellation. A separate sustained 64 MiB
pipeline samples live managed memory before final framing: additional live memory
must remain below 16 MiB. It passes for both strict and synthetic WinRM on both
installed engines. Replaying the strict memory probe against base source retained
134,724,416 bytes on Windows PowerShell and 134,693,176 bytes on PowerShell 7
(about 128.5 MiB), failing that threshold. The scratch replay command was
`node --import tsx .scratch/baseline-memory.mjs`.

One initial PowerShell 7 full run had a `STACK_TRACE_ERROR` in the two-host
ErrorAction override test after 9.7 seconds. Its focused rerun passed unchanged
in 2.7 seconds. That test now allows 15 seconds for two real host launches and
writer compilations; its assertions are unchanged. Both final full runs passed.

## Commands and final results

Windows x64, Node `v26.7.0`; actual child-engine probes:
`powershell.exe` **5.1.26100.33648**, `pwsh.exe` **7.6.8**.

For execution, `TEMP`, `TMP`, `TMPDIR`, `npm_config_cache`,
`POWERSHELL_MCP_EXEC_PARENT`, and `POWERSHELL_MCP_LOG_PARENT` were directed
into this clone's `.scratch` tree; telemetry was disabled with
`POWERSHELL_MCP_NO_TELEMETRY=1`. Scratch output is locally excluded from Git.

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 154 packages installed from lockfile |
| `npm run typecheck` | Passed |
| `npm run build` | Passed; packaged supervisor copied |
| `MCP_REQUIRED_ENGINE=powershell npm test -- --maxWorkers=2 --reporter=json --outputFile=.scratch/final-powershell.json` | 225 discovered, 224 passed, 0 failed, 1 skipped; 36 files |
| `MCP_REQUIRED_ENGINE=pwsh npm test -- --maxWorkers=2 --reporter=json --outputFile=.scratch/final-pwsh.json` | 225 discovered, 224 passed, 0 failed, 1 skipped; 36 files |
| `node scripts/check-test-report.mjs <each final report>` | Both passed, including required child-version proof |
| `node scripts/check-collector-tests.mjs` | 29 discovered/passed; 0 failed, skipped or cancelled |
| `MCP_REQUIRED_ENGINE=powershell node scripts/installed-smoke.mjs` | Passed, 43 assertions |
| `MCP_REQUIRED_ENGINE=pwsh node scripts/installed-smoke.mjs` | Passed, 43 assertions |
| `git diff --check` | Passed |

The environment prefixes in the table are shorthand; actual execution used
PowerShell `$env:MCP_REQUIRED_ENGINE='powershell'` / `'pwsh'` assignments.
Final installed smoke logs are `.scratch/installed-final-powershell.txt` and
`.scratch/installed-final-pwsh.txt`; both tested tarball SHA-256
`39f64cdf76edca473d0b6109d8db4a2e2afcf8c36fa82e9ba674b865c0081b21`.

## Limits and unverified work

- The one skipped test in each run is the opt-in live SSH test. Network execution
  fixtures used loopback only; no real WinRM/SSH host was invoked.
- WinRM's producer and production adapter were verified with local invocation
  doubles. Actual WinRM serialization, endpoint policies and remote execution
  through the packaged `winrm_exec` MCP handler remain unverified.
- Ubuntu/PowerShell 7 and the CI Node 20 toolchain were not run here. These still
  require their existing CI lanes. Unrelated Python analytics/operations tests
  were not run.
- The writer requires `Add-Type`. Constrained endpoints that prohibit compilation
  are unsupported. The bound covers retained producer output and framing, not
  user allocations, individual objects/lines, PowerShell formatting or remoting
  internals. The managed-memory probe is not a total process/descendant RSS proof.
- Framed output requires a terminal frame: timeout/cancellation do not preserve
  a partial framed stdout/log. Direct OS stdout writes that bypass the console
  writer invalidate framing. Native original-byte capture remains `run_program`.
- No push, PR, publication, deployment, or remote command execution was performed.

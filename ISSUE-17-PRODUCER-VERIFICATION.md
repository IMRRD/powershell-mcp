# Issue #17 stderr correction — 2026-10-23

Correction base: `50cbf07fe5764d8c9d1359449b5412808c111e5d`.
This records verification performed in this correction clone. It supersedes the
prior candidate report; earlier artifact hashes, memory replays and test totals
are not evidence for this correction.

## Regression and implementation

The first source change added a decoder regression with local host stderr
`LOCAL` (5 bytes) and envelope stderr `REMOTE` (6 bytes). After installing locked
dependencies, the test was run before changing production code:

`npm test -- test/winrm-stderr.test.ts --reporter=json --outputFile=.scratch/stderr-before.json`

It failed: 1 discovered, 0 passed, 1 failed. The decoder returned `REMOTE`,
observed/captured 6 bytes, instead of `LOCALREMOTE`, observed/captured 11 bytes.
The initial attempt could not start Vitest because dependencies were absent;
`npm ci --ignore-scripts --no-audit --no-fund` installed 154 packages before the
actual failing run.

The decoder now combines local then remote stderr deterministically. Cross-host
chronological order cannot be recovered from an envelope. Observed counts sum
both sources, including upstream omissions; captured counts represent original
retained bytes, omitted equals observed minus captured, and truncation means
omitted is nonzero. Head/tail retention uses the byte collector, including UTF-8
boundary handling. Malformed local OS bytes survive protected log readback as
original bytes; rendered text uses replacement characters.

The production adapter captures local stderr up to the larger of display cap
and log quota. Combined stderr is bounded to that payload budget, then recapped
for display. Protected logs persist combined stderr and stdout under the existing
shared quota and private-directory protection. Upstream or quota loss marks the
log incomplete. Timeout/cancellation still discard framed logs and recap local
stderr to the display limit.

## Focused verification

`test/winrm-stderr.test.ts` covers empty remote plus local, both nonempty,
head/tail caps 0/1/3/5/11 with and without logging, malformed local bytes, Unicode
boundaries, omissions from both sources, timeout recapping, shared stdout/stderr
quota, complete/incomplete metadata and original-byte readback.
`test/producer-adapter.test.ts` emits host stderr outside the remote script block,
exercising production `runWinRm` construction, capture budget, decoding and the
protected log store. Only `Invoke-Command` is replaced by a local function.

Focused command, for each required engine:

`npm test -- test/winrm-stderr.test.ts test/producer-adapter.test.ts test/output-collector.test.ts test/full-logs.test.ts test/output-error-bound.test.ts --maxWorkers=2 --reporter=json --outputFile=.scratch/stderr-focused-<engine>.json`

Both final focused runs: **77 discovered, 77 passed, 0 failed, 0 skipped**, 5 files.
Actual engine probes: Windows PowerShell **5.1.26100.33648**, pwsh **7.6.8**.
Runtime: Windows x64, Node **v26.7.0**.

Engine-specific runs assigned `$env:MCP_REQUIRED_ENGINE='powershell'` or `'pwsh'`.
`TEMP`, `TMP`, `TMPDIR`, `POWERSHELL_MCP_EXEC_PARENT` and
`POWERSHELL_MCP_LOG_PARENT` pointed into this clone's `.scratch` for the Vitest
runs; telemetry was disabled with `POWERSHELL_MCP_NO_TELEMETRY=1`. Installation
used a clone-local `npm_config_cache`. Scratch evidence is locally excluded from Git.

## Final checks

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `MCP_REQUIRED_ENGINE=powershell npm test -- --maxWorkers=2 --reporter=json --outputFile=.scratch/stderr-full-powershell.json` | 275 discovered, 274 passed, 0 failed, 1 skipped; 37 files |
| `MCP_REQUIRED_ENGINE=powershell node scripts/check-test-report.mjs .scratch/stderr-full-powershell.json` | Passed, including required child-version proof |
| `MCP_REQUIRED_ENGINE=pwsh npm test -- --maxWorkers=2 --reporter=json --outputFile=.scratch/stderr-full-pwsh.json` | 275 discovered, 274 passed, 0 failed, 1 skipped; 37 files |
| `MCP_REQUIRED_ENGINE=pwsh node scripts/check-test-report.mjs .scratch/stderr-full-pwsh.json` | Passed, including required child-version proof |
| `node scripts/check-collector-tests.mjs` | Passed; 29 tests, no failures/skips/cancellations |
| `git diff --check` | Passed |

The environment prefixes in the table are shorthand for PowerShell environment
assignments. Both full suites ran against the final production and test code.

## Verification limits

- All WinRM coverage uses local invocation doubles. Real WinRM serialization,
  authentication, endpoint policies and packaged `winrm_exec` execution against a
  remote host remain unverified.
- The single skipped test in each full run is the opt-in live SSH
  test. Network fixtures used loopback; no real remote host was invoked.
- Ubuntu and Node 20 were not run. Windows Node 26 results do not verify those CI
  environments. Unrelated Python analytics/operations tests were not run.
- Installed-artifact smoke tests and the baseline memory replay were not rerun
  for this correction; the prior report's artifact hash does not apply.
- The inherited producer requires `Add-Type`; endpoints prohibiting compilation
  remain unsupported. Output bounds exclude user allocations and PowerShell
  formatting/remoting internals. Cancellation does not prove remote termination.
- No production remote commands, push, merge or release were performed.

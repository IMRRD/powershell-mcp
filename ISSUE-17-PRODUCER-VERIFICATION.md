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

## Unicode boundary blocker correction — 2026-10-23

This appended section records the independently reproduced combination blocker
against base `a1e52c7a336fe80318c097ab29b4ece2a21d85e4` on the existing isolated
branch `fix/17-producer-bounds`. The preceding report and its evidence are
preserved as historical evidence; its Unicode-combination claims and test
totals do not establish this correction. Work used one coder and no agents.
The previously documented workspace-write failure remains historical; this run
used the provided full-access environment only for this clone and synthetic
scratch. No production systems or existing credential stores were accessed.

### Regression first and contracts

The first edit added two decoder regressions, before any production edit:
cap 1, tail local `A` plus remote `€`, and complementary head local `€` plus
remote `A`. Both require empty stderr, observed 4, captured 0, omitted 4,
truncated true. Both originally returned `A`, captured 1, omitted 3.

With the scratch environment below, the pre-fix command was:

```powershell
npm test -- test/winrm-stderr.test.ts -t 'does not fill an omitted Unicode boundary' --reporter=json --outputFile=$scratch/unicode-before.json
```

Result: **50 discovered, 0 passed, 2 failed, 48 filtered/skipped**, exit 1.
`unicode-before.json` is retained. Its SHA-256 is
`f467b0d1bbe7456a1dfb0f045feccfb186016ba34d306ec05bdc092ab4c25f04`.

Read contracts/callers: `runWinRm` and `decodeWinRmResult`,
`captureFromEnvelope`, `displayCapture`, `protectedPayload`, `StreamCapture`,
the C# producer snapshot, result metrics and protected-log storage. The local
and remote inputs use the same retention direction and payload budget.
Envelope captures are validated UTF-8; local captures carry original raw bytes.
Local-then-remote ordering is deterministic, without cross-host arrival ordering.

Combination now computes the global head/tail byte window from summed observed
segment lengths and intersects it with actual retained-byte positions. It keeps
private position metadata through display recapping so gaps cannot move retained
bytes into a later display window. Only adjacent retained ranges share UTF-8
boundary context. Original malformed bytes remain available to protected logs;
public envelope fields and accounting invariants are unchanged.

The selected context contains at most limit + 3 bytes; the returned raw payload
contains at most limit bytes. Missing/observed regions are never allocated.
Position metadata scales with retained pieces, not observed byte counts. Tests
include a synthetic billion-byte omitted segment at cap 1. This is a code-bound
and functional check, not a new heap-profile or memory-replay measurement.

Additional malformed-prefix reference cases initially failed 4 of 254 collector
tests (`unicode-malformed-prefix-before.json`). A local terminal UTF-8 lead byte
at a head cut still needs trimming when the next segment retains no bytes. The
existing collector head-boundary rule is shared for that case; the same 254
tests then passed (`unicode-malformed-prefix-after.json`). The first adapter
attempt also exposed Windows PowerShell 5.1 console encoding of a local euro as
`?`; the local invocation fixture now writes explicit UTF-8 OS stderr bytes.
That attempt's 425 discovered / 423 passed / 2 failed report is retained as
`unicode-focused-powershell-fixture-encoding.json`. Intermediate reports are
preserved and are not the final verification evidence below. A first full run
with the final source discovered 695 tests (692 passed, 2 failed, 1 skipped):
two loopback SSH tests failed because this run's known-hosts environment setting
named a nonexistent scratch file. Creating an empty synthetic known-hosts file
corrected the validation setup without product/test edits. That report is kept
as `unicode-full-powershell-known-hosts-config.json` and its matching `.log`.

### Final commands and evidence

Task-created scratch artifacts, final package installs/caches, test reports and
logs are beneath:

`C:/Users/aegis/AppData/Local/hermes/cache/scratch/issue17-unicode`

For the commands below, `$scratch` is that absolute path. `TEMP`, `TMP`,
`TMPDIR`, `POWERSHELL_MCP_EXEC_PARENT` and `POWERSHELL_MCP_LOG_PARENT` point there;
`npm_config_cache` points to `$scratch/npm-cache`. Telemetry is disabled with
`POWERSHELL_MCP_NO_TELEMETRY=1`; `SSH_TEST_HOST` is removed; default credential
and known-host paths are redirected to synthetic scratch paths (the known-hosts
file contains only a comment; loopback fixtures supply explicit pins). Existing
canonical tests use only synthetic credential fixtures under scratch. No real
credentials are read. The scratch-only `validate.ps1` records the exact setup
and captures final command output in `final-<stage>-<engine>.log`.

Runtime: Windows x64, Node **v26.7.0**, npm **11.19.0**. Fresh engine probes:
Windows PowerShell **5.1.26100.33648**, pwsh **7.6.8**. Each engine-specific run
sets `$env:MCP_REQUIRED_ENGINE='powershell'` or `'pwsh'`.

Focused command, for each engine:

```powershell
npm test -- test/winrm-stderr.test.ts test/producer-adapter.test.ts test/output-collector.test.ts test/full-logs.test.ts test/output-error-bound.test.ts --maxWorkers=2 --reporter=json --outputFile=$scratch/final-focused-<engine>.json
```

Both final focused runs: **497 discovered, 497 passed, 0 failed, 0 skipped**,
5 files. Unicode cases compare same-cap input captures against a single-stream
reference collector for head/tail, caps 0 through scalar boundaries, empty
remote output, malformed local bytes, and smaller display recaps. Decoder cases
check both streams plus protected-log raw readback, quota and completeness.
Production-adapter regressions run on each real engine with only local
`Invoke-Command` replacement. Installed smoke imports the installed collector
and checks 56 Unicode/malformed combination cases against the same reference.

| Final command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test -- --maxWorkers=2 --reporter=json --outputFile=$scratch/final-full-powershell.json` with required powershell | 695 discovered, 694 passed, 0 failed, 1 skipped; 37 files |
| `node scripts/check-test-report.mjs $scratch/final-full-powershell.json` | Passed, including actual child-version proof |
| `npm test -- --maxWorkers=2 --reporter=json --outputFile=$scratch/final-full-pwsh.json` with required pwsh | 695 discovered, 694 passed, 0 failed, 1 skipped; 37 files |
| `node scripts/check-test-report.mjs $scratch/final-full-pwsh.json` | Passed, including actual child-version proof |
| `node scripts/check-collector-tests.mjs` | Passed: 29 tests, 29 passed, no failures/skips/cancellations |
| `node scripts/installed-smoke.mjs` with required powershell | Passed, 99 assertions |
| `node scripts/installed-smoke.mjs` with required pwsh | Passed, 99 assertions |
| `git diff --check` | Passed |

Both installed smokes tested locally packed `@imrrd/powershell-mcp@0.7.0`, schema
1, tarball `imrrd-powershell-mcp-0.7.0.tgz`, SHA-256
`09eedb045c75bb737c09387ab38af71d8fc835d810bf974bda1b6204bb17c3e2`.
The existing smoke removes its temporary installation. A separate final
`npm pack --json --pack-destination $scratch` preserved the tarball and
`final-pack.json` in scratch; its SHA-256 matches both installed-smoke outputs.
The smoke logs say `commit=local`; the exact local commit is returned separately
after committing this report. No source or test edits occurred during these
final canonical/smoke runs.

`final-evidence.json` in scratch indexes the SHA-256 hashes and test counts for
the regression reports, final focused/full reports, final smoke/build/collector
logs and the preserved tarball.

Canonical report SHA-256 hashes:

- `final-full-powershell.json`: `bf5275af3c8adda6f97d9e6a50df8ad9a35729694c99b72b8c721ffc9d0b844b`
- `final-full-pwsh.json`: `09abf9df022323a1b94e46582e177d5d67aef4f737a62fac586015d1bc7a9ed6`

### Remaining limits for this correction

- Real WinRM serialization, authentication, endpoint policy and packaged remote
  `winrm_exec` execution remain unverified; the adapter uses a local invocation
  double. Installed transport fixtures are local/loopback only.
- The opt-in live SSH test remains skipped. Ubuntu, Node 20, unrelated Python
  analytics/operations tests, interactive desktop focus behavior and the earlier
  memory replay were not run for this correction.
- Upstream omitted bytes cannot be recovered. Plain envelope captures rely on
  the caller's shared head/tail direction; private range metadata does not add
  fields to the wire schema. Endpoints prohibiting the inherited producer's
  `Add-Type` remain unsupported; cancellation does not prove remote termination.
- No push, merge, release, deployment, production command or real credential
  access was performed. Changes are limited to this Unicode combination blocker,
  its display recapping, regressions, installed verification and this report.

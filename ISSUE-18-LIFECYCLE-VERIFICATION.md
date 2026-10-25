# Issue #18 lifecycle acceptance

Source baseline: `6924d7178d541248274a61788b07aceb323141b3`, isolated branch
`fix/18-lifecycle-acceptance`. One coder; no agents delegated.

Read the README, actual [issue #18 and its acceptance comment](https://github.com/IMRRD/powershell-mcp/issues/18),
[closed #17 and its final native acceptance](https://github.com/IMRRD/powershell-mcp/issues/17),
the lifecycle implementation/tests, CI and installed smoke. No applicable AGENTS.md
was present in the repository or its ancestor directories. Swept all 37 returned
PRs and local lifecycle history: #30 already merged local persistence, restart,
Windows Job Objects and logging; #58 merged producer bounds. No competing open
lifecycle PR appeared in the repository PR sweep. This change retains that work.

## Criterion evidence

| Original criterion | Implementation and executable evidence |
| --- | --- |
| start/status/read/cancel, ownership, bounded persistence | Existing 64-run/8 MiB store, hashed requests, owner checks and byte pages retained. `execution-lifecycle.test.ts` exercises ACLs, quotas, output integrity by length, disk failure, owner isolation, reads and recovery. Installed smoke exercises all four MCP tools, wrong-owner denial and byte readback. |
| disconnect, MCP restart, OS reboot | README specifies persistent-store requirements, completed recovery and conservative unknown for previous running/reserved work. No old PID is adopted or signalled. Existing actual server-process restart test retained. New fresh-process test rewrites only synthetic metadata to previous-boot ownership pointing at a live unrelated PID, then tests status/cancel/same-key start. Installed smoke starts a new CLI process and repeats stale-ownership reconciliation plus completed output readback. **These are restart/reconciliation tests, not real reboot or power-loss evidence.** |
| verified local tree, PID reuse safety, bounded cancellation | All actual local callers now use `spawnOwned`: native, legacy/strict PowerShell, WinRM's local host and the durable lifecycle. Windows retains process/Job Object handles; Linux uses a subreaper, direct-child ancestry and pidfds, including adopted descendants in separate sessions. No PID/group-kill fallback remains. Cancellation is requested once, native cleanup waits at most four seconds, and the caller resolves unknown after six seconds without proof. `owned-process.test.ts` injects failed kill, stalled kill, stale/reused PID, broken channel and forged proof; it checks no bare-PID kill or retry. `lifecycle-acceptance.test.ts` tests real three-generation trees for each caller and preserves a separate live process. Windows executed; Linux runtime remains a gate below. |
| SSH/WinRM timeout vs remote termination | `fromProcess` now keeps every WinRM result's remote certainty unknown even when its local PowerShell host exited. SSH already stays unknown. Real loopback SSH refusal, authentication rejection and prefix-before-timeout fixtures run through `runSsh`, with one connection/no redispatch. Isolated WinRM exceptions run through the real `runWinRm` dispatcher and local PowerShell bootstrap with only Invoke-Command substituted. These are not live remoting or production authorization tests. Installed MCP smoke covers refused and unauthorized loopback SSH. |
| explicit idempotency; no ambiguous retries | Existing atomic reservation and request conflict contract retained. A matching request returns the same ID even after synthetic reboot recovery; a changed request fails. Stalled/failed/unknown cancellation does not relaunch or resend. Installed smoke checks matching key, conflict, restart, no additional tree markers and unrelated PID survival. No remote supervisor or remote durable replay was added. |
| parent/child/grandchild, failed kill, prefix, reconnect/restart, inaccessible/unauthorized remote | Covered by the suites above and the installed artifact. Linux tree fixtures explicitly detach children into new sessions. Failure tests inject control-channel/native-outcome uncertainty; they do not change real process permissions to provoke denial. Synthetic stale PID ownership substitutes for forcing real PID reuse. |

Windows Store-installed PowerShell 7 exposed an additional real failure during
implementation: its native descendants escaped the Job Object's scope. The
supervisor now sets `PROCESS_CREATION_DESKTOP_APP_BREAKAWAY_DISABLE_PROCESS_TREE`
before resuming the owned root. See Microsoft's
[desktop app policy contract](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
It also explicitly uses CREATE_NO_WINDOW, preserves stdin/EOF through a separate
inherited pipe, and bounds drain joins. Hidden-process flags do not prove real
desktop foreground-focus behavior.

The Linux helper requires pwsh, readable process ancestry and kernel pidfd/subreaper
support (Linux 5.3+); unavailable supervision fails closed. Each local invocation
now starts a PowerShell supervisor, so a short full-invocation deadline can expire
during startup. Prefix fixtures allow five seconds for startup and still assert
timeout plus incomplete logging; native cleanup deadlines were not relaxed.

## Executed verification (Windows, 2026-10-25)

Runtime: hash-verified Node **20.20.2**, Windows PowerShell **5.1.26100.33648**,
Store-installed PowerShell **7.6.8**. Telemetry disabled. TMPDIR/TEMP/TMP and
POWERSHELL_MCP_EXEC_PARENT pointed under the dedicated synthetic scratch parent.
Locked `npm ci`, `npm run typecheck` and `npm run build` passed.

| Check | Discovered | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Final canonical `npm test`, MCP_REQUIRED_ENGINE=powershell | 712 | 711 | 0 | 1 |
| Final canonical `npm test`, MCP_REQUIRED_ENGINE=pwsh | 712 | 711 | 0 | 1 |
| Final targeted lifecycle + owned-process + remote-lifecycle + existing lifecycle | 35 | 35 | 0 | 0 |
| Isolated collector gate | 29 | 29 | 0 | 0 |
| Final acceptance regressions on untouched baseline production files | 7 | 4 | 3 | 0 |

The canonical skip is `runSsh (live) executes a command on the real host`.
Both canonical reports pass `scripts/check-test-report.mjs`. The baseline failures
are the unbounded/non-idempotent stalled cancellation and the two incorrect WinRM
certainty results, not fixture cleanup errors. The final baseline test file is
identical to this branch's acceptance test. It runs in a detached scratch worktree
at the baseline commit, sharing only dependencies through a junction.

Commands (with the environment above):

```text
npm ci
npm run typecheck
npm run build
npm test -- --reporter=json --outputFile=<scratch>/final-<engine>.json
node scripts/check-test-report.mjs <scratch>/final-<engine>.json
node node_modules/vitest/vitest.mjs run test/lifecycle-acceptance.test.ts test/execution-lifecycle.test.ts test/owned-process.test.ts test/remote-lifecycle.test.ts --reporter=json --outputFile=<scratch>/final-targeted.json
node scripts/check-collector-tests.mjs
node scripts/installed-smoke.mjs
```

The JSON reports and installed smoke transcripts are retained under
`C:/Users/aegis/AppData/Local/hermes/cache/scratch/issue18-acceptance`.
The initial regression run preceded production corrections; the final baseline
rerun reconfirmed those same three failures using the finalized regression.
The Linux C# helper also compiled successfully with pwsh on Windows; that does
**not** execute Linux syscalls or establish Linux termination behavior.

## Installed artifact

Final installed smoke: Windows PowerShell **189 assertions passed**, pwsh
**207 assertions passed**, no failed assertions in either lane. Smoke assertion
counts include polling and therefore vary with process startup.
Both lanes install only an npm-packed tarball from this clone into a fresh scratch
project and exercise the installed CLI over MCP stdio. This is not a registry release.

Both lanes and the separately retained tarball have SHA-256
`d70cb59cba9c1ad903dfe70f19c9e1d26ff6b8d00c819a27fcf1791a7a784e54`.
The retained local artifact is
`C:/Users/aegis/AppData/Local/hermes/cache/scratch/issue18-acceptance/artifact/imrrd-powershell-mcp-0.7.0.tgz`.

## Exact remaining gates

1. Parent-owned exact-commit CI on Node 20: Windows PowerShell 5.1, Windows pwsh and
   Ubuntu pwsh, including the existing collector/analytics jobs. The actual CI
   report gate now requires the lifecycle, owned-process, remote-lifecycle and
   existing lifecycle suites, plus all three real owned-tree cases. The existing
   installed-artifact step runs the expanded MCP smoke. No new disconnected test
   workflow was introduced.
2. In particular, execute Linux subreaper/pidfd ownership, detached descendants,
   unrelated-process preservation and installed MCP cancellation on Ubuntu. This
   machine has no installed WSL distribution or container runtime; Windows
   compilation/mocks cannot substitute for this runtime gate.
3. Independent parent review and acceptance reconciliation. This work does not
   close #18, create/push a PR, merge, publish, deploy or authorize a release.

No real reboot or OS power-loss proof is claimed or required by the documented
reconciliation contract. File fsync plus rename does not prove directory-entry or
hardware crash durability. Losing the whole store loses its idempotency history.
Remote verified termination and remote durable supervision remain explicitly
unsupported, not a prerequisite silently replaced with local-host exit evidence.
No production host, service, credential store or installed MCP deployment was used
or changed. Tests used synthetic processes, credentials and loopback endpoints only.

# PR82 npm fixture ownership repair

The protected-artifact fixture now owns npm cancellation through the existing collector command lifecycle. This repairs the independently demonstrated defect: npm's abort/close could return while its installer descendant continued writing. It does not establish the cause of the historical hosted stalls.

One Sol writer, no agents. Baseline commit: `719f76c6be8fbd2483a7eddb463ad08df5d04692`; baseline tree: `b2d44ead9a1b2a72ca19b69c4843e0c5681911cb`. Read the supplied `PR82-CI-REPAIR.md` and `pr82-ci-repair-evidence/reproduce-npm-ownership.mjs` before changing source.

## Implementation and preserved boundaries

`test/artifact-npm.mjs` calls `runCommand` from `collector/fixtures/packaged-process.mjs`. The signal cancels its waiter, rather than killing npm through `spawn({signal})`. The runner's `finally` calls `stopProcess` and drains close before returning. On Windows this invokes the existing, bounded `taskkill /T /F` against the still-live owned root, with the existing fallback and close handling. POSIX retains its existing live keeper/group mechanism. No process discovery, numeric PID ownership inference, new process primitive, or replacement ownership adapter was introduced.

The shared 150,000 ms pack/install signal, 180,000 ms setup hook, 90,000 ms acceptance test, default 10,000 ms cleanup hook, invocation deadlines, and four-worker configuration remain unchanged. The adapter's command bound matches the existing shared setup signal; the collector's default bound remains 120,000 ms. All protected-artifact acceptance assertions and the actual pack/install arguments are preserved. Runtime, assets, dependency metadata, and installation scripts are unchanged. Fixture directory removal now awaits asynchronous `rm` under the existing cleanup hook bound.

The runner adds optional phase measurement and output suppression. Protected-artifact failures expose status without copying npm output into errors or console diagnostics. Existing `cleanup` preserves the original failure as the aggregate cause and first member while attempting all cleanup tasks. The MCP client cleanup uses that same precedence.

`test-evidence/protected-artifact.json` survives fixture removal. It uses the existing evidence writer's 8,192-byte cap, fixed phase allowlist, bounded durations, best-effort writes, and started/completed/failed snapshots. Pack, install, command wait/abort/close, proof, client close, and deletion are recorded; no raw npm output, error messages, argv, paths, environment, or credentials are serialized. Shared command phases retain their latest entry. CI's existing failure upload adds only this explicit JSON path; both fixed upload-list assertions were updated. No raw-log glob was added.

## Regression and validation

RED used the original npm helper moved to the imported adapter boundary, erasing TypeScript types only. After the ready marker, abort returned and the installer descendant's heartbeat grew from **2 to 13 bytes in 300 ms**. The focused run failed its ownership assertion: 1 failure, 22 filtered tests. Its finite writer was allowed to exit before teardown. The original helper's CRLF extraction SHA-256 is `c6f2e1cad467d9bffc909edde59dc352297119c74aea00300d3bfcf4162e4d2c`, matching the supplied probe; its LF Git-source extraction SHA-256 is `69f401153ecd9b26613f3fbd8fd8a74f8d692e163b609e6f26653869126693b6`.

GREEN tests the adapter actually imported by the protected-artifact fixture. It packs and installs a local dependency-free package with lifecycle scripts enabled, waits for an installer descendant's ready marker and heartbeat, aborts, checks cancellation identity and heartbeat cessation, and verifies an unrelated sentinel continues writing. Its bounded phase snapshot survives removal of the install directory without serializing the cancellation message. Four existing root-first cases now also check heartbeat cessation: success/failure with inherited/ignored pipes, retaining their original 1,000 ms proof bound and sentinel-survival assertions. An added artifact-npm case injects termination failure and verifies aggregate/cause preservation; another rejects raw npm output disclosure. The mandatory collector count increases by exactly these three tests: Windows 57 to 60, POSIX 58 to 61.

All checks below use Node **20.20.2**, npm **10.8.2**, and selected Windows PowerShell **5.1.26100.33648**. Dependencies and the pinned supervisor compiler were already present; this does not recreate a fresh hosted `npm ci` or constitute hosted CI validation.

| Check | Result | Exact source tree |
| --- | --- | --- |
| Typecheck and build | Both exit 0 | `9684919cca4de9a1616d09bb3fbbeab4f6e44b56` |
| Focused process/evidence/gate regressions | 32 passed, 0 failed/skipped | `a2f3127f1795b3269d83737839e9fbe988e726f6` |
| Real affected group: error-policy, producer-streaming, Linux supervisor diagnostics, protected artifact | 4 files, 33 tests passed, 0 failed/skipped; 101.62 s | `e9d86ced927378143363d7b1987af07783668cc8` |
| Full selected Vitest lane | Exit 0; 61 files: 60 passed, 1 wholly skipped; 1,023 tests: 1,017 passed, 0 failed, 6 skipped; 273.87 s | `a2f3127f1795b3269d83737839e9fbe988e726f6` |
| Report gate | Exit 0; required discovery and lifecycle proofs admitted | `a2f3127f1795b3269d83737839e9fbe988e726f6` |
| Mandatory collector gate | Exit 0; 60/60 passed, 0 failed/skipped/cancelled; 51.00 s | `a2f3127f1795b3269d83737839e9fbe988e726f6` |
| Actual packed/installed MCP smoke | Exit 0; 184 assertions, including two-hop control and three independent host-key refusals; 69.80 s | `a2f3127f1795b3269d83737839e9fbe988e726f6` |

The typecheck/build preceded the upload-list assertion correction and synthetic fault-injection teardown correction. The affected group preceded only the latter collector-test correction; all affected-group source bytes match the final source. The full lane and final collector/focused checks use the final implementation/test tree. The protected-artifact tarball SHA-256 remains `5922df160d978cb27d13b7aeb9198275d67339a68e0e0023690026dc5a24edbd`, identical to baseline.

The retained allowlisted install-lifecycle summary confirms both `ssh2@1.17.0` and `cpu-features@0.0.10` install scripts ran in the real affected/full installs. `ssh2` closed with code 0; the optional `cpu-features` build closed with code 1 while npm succeeded. No lifecycle script was bypassed to obtain these results.

Full-gate status is green for this local selected lane. The earlier baseline diagnostics-store availability failure did not recur; no unchanged full-lane retry was made. The existing artifact-client `MaxListenersExceededWarning` remains visible and was not suppressed. Passing this lane does not identify a cause for the historical hosted stalls.

Two intermediate validation failures are retained: the first affected run rejected the newly extended upload list (32/33 tests passed), and a later focused run's intentional taskkill rejection left a lifecycle shell briefly holding its cwd (31/32 passed). The upload expectation was extended, and fault-injection teardown now waits for the published lifecycle parent's natural exit after stopping its installer. Neither correction changes a runtime deadline or retries an unchanged failure. Their logs and metadata remain alongside the final checks.

## Exact source and evidence

Final implementation/test tree, excluding only this report: **`a2f3127f1795b3269d83737839e9fbe988e726f6`**. The following are all nine changed source blobs in that tree; `source-verification.json` additionally records their SHA-256 values and verifies preservation of the owned-process primitives, protected assertion lines, install arguments, deadlines, runtime, and package metadata.

| Source | Git blob |
| --- | --- |
| `.github/workflows/ci.yml` | `f58ac3c9372a624f7ef5ae4d556754c250ea616f` |
| `collector/fixtures/packaged-evidence.mjs` | `1d9fa723c588afc7d8deead6e0770fd727982799` |
| `collector/fixtures/packaged-process.mjs` | `76e22da0d1af25bdd3beaf5e3eea93f04e1f0402` |
| `collector/packaged-process.node-test.mjs` | `5505e9a0cd8680903aafb38e161ccdcb7c51734d` |
| `scripts/check-collector-tests.mjs` | `4da04bef4245142c1c2fe090be67a1a08d57fc6d` |
| `scripts/check-collector-tests.node-test.mjs` | `f5f9af0b2f944f78defd2e6a06b198057f3b08aa` |
| `test/artifact-npm.mjs` | `32ca0b1a6ae367bd2d29c91e5c999b44194f06f8` |
| `test/linux-supervisor-diagnostics.test.ts` | `3dfe7ed664581475baf58bb7d070451457b250c0` |
| `test/winrm-protected-artifact.test.ts` | `a5be4f47a3f01ae08e17ce9b25e846ec254ed5e6` |

Local evidence is retained under `C:/Users/aegis/AppData/Local/hermes/operations/mcp-actionable-reliability-scope/pr82-ownership-fix-evidence/`: RED/GREEN logs, per-check arguments/source hashes/results, JSON test reports, safe phase snapshots, source verification, and a SHA-256 manifest. Raw local test output remains local and is not committed or added to public uploads. `final-source-status.json` records the final commit/tree, verifies that removing only this report reproduces the exact source tree above, and records the final working-tree status.

Independent review is next and has not been performed or claimed. No push, production action, or GitHub retry occurred.

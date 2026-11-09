# PR82 collector fixture portability correction

Baseline HEAD: `37edfd2d5ef1eaa2a563f9a3e774a48e88d3a028`; tree: `0414d6b09a3547c6055c3c8ee2074ed02ad4dea1`.
Validated implementation tree, excluding this report: `36e68d13966d53ce62cc66078b1d5318f1db629e`.
One Sol writer, no agents. Independent review is the next step. No push, CI retry, deployment, or production host modification occurred.

## Evidence read before edits

Read the entire supplied failed log, `C:/Users/aegis/AppData/Local/hermes/cache/terminal-output/out-1794247178-1568-5e00.log`, for [run 42668180884](https://github.com/IMRRD/powershell-mcp/actions/runs/42668180884). Retained it unchanged as `original-failed.log`. Downloaded both original failure ZIPs, metadata, reports, and phase artifacts under `C:/Users/aegis/AppData/Local/hermes/operations/mcp-actionable-reliability-scope/pr82-collector-portability-evidence/`. ZIP SHA-256 values match the API digests:

- Windows PowerShell, artifact `13699165053`: `1b22d33e72bc4e3d69a6947b49abf7ed577b099f95372a27711e04ea196cfaae`.
- Linux pwsh, artifact `13697153612`: `bb94b51ac3b16180636e93d0e852ddd19408ecd3957c51d75418c08ea0269db9`.

Both Linux failures were inspected, including the second failure's readiness await at `collector/packaged-process.node-test.mjs:329`:

1. The protected artifact npm abort/heartbeat test failed during its initial pack at line 49: `artifact npm failed (1)`.
2. The artifact npm primary-failure preservation test timed out waiting for `delayed command started`. Its npm invocation had already exited after 57 ms, before the 600 ms readiness publisher could run. Increasing the 5-second readiness limit would not start that installer.

The direct Node CI entrypoint supplies no `npm_execpath`. The adapter also assumed npm lived at `node_modules/npm/bin/npm-cli.js` beside Node. Common POSIX layouts place it elsewhere. With both candidates absent, it constructed `[undefined, ...args]`. The POSIX keeper's JSON transport turns that first element into `null`; the child receives a script argument of `null`. An isolated argument probe retained the resulting `Cannot find module '/work/null'` and exit 1. The privacy test previously accepted this unrelated failure without proving its intended lifecycle script ran.

The Windows collector result was 60 discovered, 59 passed, 1 cancelled, 0 skipped. Its phase artifact proves install **completed**, exit 0: 117,019 ms install, 105,008 ms unpack, 3,601 ms install scripts. Product proof received only 2,245 ms before the original 120-second total expired. Wrong-ACK retention and replay completed; positive deletion was interrupted; metric proof never started. This demonstrates prerequisite work consuming the proof clock. It does not establish a product ACK defect or explain why that runner unpacked slowly. The hosted Linux installed-tarball proof itself passed in 7.7 seconds; the hosted Windows pwsh job passed independently.

## Bounded correction

Only three fixture/test files change:

- `test/artifact-npm.mjs` preserves the resolved CLI/Node invocation when available and uses `npm` from PATH on POSIX when neither CLI candidate exists. Windows missing-CLI admission fails explicitly. All args remain separate argv elements; cancellation, ownership, error privacy, and the original shared 150,000 ms protected-artifact signal remain intact.
- The existing privacy regression publishes a marker from its real failing install script and requires that marker, in addition to the existing raw-output exclusion assertions. Test registration/counts and its 10-second limit remain unchanged.
- `collector/packaged-client.node-test.mjs` performs real pack/install in a `before` hook bounded at 120,000 ms. That hook's signal covers both commands; setup failure preserves its primary error, closes owned commands, removes the fixture, and records failed acceptance. The existing registered proof remains bounded at 120,000 ms with its complete original assertion/cleanup body. Node hook failure fails the registered test, and the unchanged exact-count gate rejects cancellation.

The scheduling contract intentionally becomes **up to 120 seconds for cold preparation, followed by up to 120 seconds for proof**, with the existing owned cleanup settlement. This is the explicit separation justified by the retained install/proof phases, not a larger proof or npm command deadline. No test registration, assertion, command timeout, readiness bound, lifecycle script, gate count, worker setting, CI step, or upload allowlist is removed or relaxed. Source runtime, assets, dependencies, and package metadata do not change. There is no `--ignore-scripts`, mock installed product, or registry substitute in this correction.

## Actual validation

All substantive validation used Node 20.20.2 and npm 10.8.2. Windows used the existing isolated Node 20 runtime and Windows PowerShell 5.1.26100.33648. Linux ran natively in a disposable x64 Debian container on development worker `docker-xrv6`, with no host mounts or production service access: image `node:20.20.2-bookworm`, digest `sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5`, init enabled, 2 CPUs, 2 GiB memory, 256 PID limit, all capabilities dropped.

| Check | Result |
| --- | --- |
| Unchanged Linux process fixtures, direct Node entrypoint | RED: 25 tests, 23 passed, the same two failures, zero skips/cancellations; 15.66 s TAP duration |
| Corrected Linux process fixtures, same entrypoint/layout | GREEN: 25/25 passed, zero skips/cancellations; 18.02 s |
| Linux mandatory collector gate | GREEN: **61/61**, zero failures/skips/cancellations; 22.55 s |
| Windows mandatory collector gate | GREEN: **60/60**, zero failures/skips/cancellations; 55.14 s |
| Windows shared-adapter consumer, actual protected artifact acceptance | GREEN: 1 file, 1 test passed, zero skips; 61.73 s Vitest duration |
| Windows TypeScript typecheck | Exit 0 |
| Linux setup deadline, unchanged 120-second bound | Control passed: intended hook failure, 1 discovered/failed test, 0 skipped/cancelled; 120.21 s; owned command dead, heartbeat stopped, fixture removed, install/proof unstarted |

Both collector gates perform real tarball installation with lifecycle scripts enabled and complete wrong-ACK retention, durable receipts, replay deduplication, positive deletion, and tool counts/metrics. Corrected Windows phase evidence records install 45,660 ms and proof 6,705 ms; Linux records install 8,143 ms and proof 1,603 ms. Both have completed acceptance/cleanup and npm exit 0; install-script timings are nonzero. The Windows protected-artifact tarball SHA-256 is unchanged from baseline: `5922df160d978cb27d13b7aeb9198275d67339a68e0e0023690026dc5a24edbd`.

Linux used a fresh, successful `npm ci --no-audit --no-fund` and TypeScript compilation inside the container. Its unchanged deterministic supervisor DLL and two supervisor scripts were copied from the existing Windows distribution; a full Linux .NET supervisor build was not executed. The Linux packed artifact hash is `d6de5cae64081156c12677896a4c9f0675809b5549c9f60eafececbf6f3d3343`; cross-OS package byte equality is not claimed. The complete Linux tracked-source index was reconstructed from the exact baseline archive plus the three corrections and independently matched implementation tree `36e68d13966d53ce62cc66078b1d5318f1db629e`.

The separate setup-deadline control uses the unchanged test file and an isolated blocking npm shim. It exercises the actual 120,000 ms deadline, rather than shortening the limit. Its final retained result proves failed setup, owned command termination and stopped heartbeat, directory removal, one discovered/failed test with zero skips/cancellations, and no install/proof phase. The control assertions passed with exit 0; its intentionally blocked child test correctly exited 1 after 120,205 ms. This probe is additional evidence outside mandatory discovery; it is not a replacement for either passing collector gate.

Transport/harness failures are retained separately. Three initial archive/file transfers failed before tests could run. A command-length/quoting transfer error caused one nominal green attempt to execute unchanged source and repeat the RED; that log is explicitly classified as a copy-harness failure. Source download by exact GitHub commit and bounded chunk transfers resolved those harness problems. The first long setup control lost its SSH connection after 78.6 seconds; its recovered artifact nevertheless recorded failed setup at 120,071 ms, completed removal, and no install/proof. A detached repeat retains the full test output and final control assertions inside the container before retrieval. None of these failures is omitted or described as a product pass.

Windows dependencies/compiler/distribution already existed. The full Vitest matrix, installed MCP smoke, Windows pwsh acceptance, macOS, ARM, and hosted CI were not rerun on this correction. Existing `MaxListenersExceededWarning` remains in the protected-artifact log. These local scoped passes do not certify the full CI matrix or diagnose unrelated historical runner stalls.

## Exact commands and handoff

From `C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-finish76`, the substantive commands were:

```text
<isolated-node20>/node.exe scripts/check-collector-tests.mjs
<isolated-node20>/node.exe node_modules/vitest/vitest.mjs run test/winrm-protected-artifact.test.ts --reporter=default --reporter=json --outputFile=<evidence>/windows-protected-report.json
<isolated-node20>/node.exe node_modules/typescript/bin/tsc --noEmit
node --test --test-reporter=tap collector/packaged-process.node-test.mjs
npm ci --no-audit --no-fund
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/check-collector-tests.mjs
node test-evidence/setup-deadline-probe.mjs
```

The evidence drivers retain exact expanded arguments and exit codes. Verify the final commit and tree with:

```powershell
git -C C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-finish76 rev-parse HEAD
git -C C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-finish76 rev-parse 'HEAD^{tree}'
git -C C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-finish76 status --porcelain=v1
git -C C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-finish76 show --stat --oneline HEAD
```

The operations copy of this report and `final-source-status.json` record the resulting commit/tree after commit. A separate index removing only this report reproduces the validated implementation tree. `SHA256SUMS.json` binds preserved original artifacts, failures, successful runs, control scripts, and provenance. Independent review has not been performed; no publication is authorized by these validation results.

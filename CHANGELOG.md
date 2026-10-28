# Changelog

## 0.8.0 — release candidate (not published)

This minor release adds optional privacy adoption fields and finite WinRM failure diagnostics to the published 0.7.0 client. The minor increment follows [Semantic Versioning](https://semver.org/) for added functionality; package versions remain in initial development (0.y.z).

- Optional external self-declaration and app-specific random user pseudonyms remain opt-in. Internal/test enrollment uses the protected server registry, never a client claim. Missing consent leaves user pseudonyms disabled; installation proxies are not people. Telemetry opt-out continues to prevent identity, queue and network activity.
- WinRM discards remote payloads unless local completion is proved and reports bounded, allowlisted failure reasons without sending targets, commands, credentials, raw errors or output. MCP output schema remains version 1; telemetry wire schema is separate.
- Installed-package acceptance retains privacy-safe package timing evidence for slow or failed setup. No dependency or release workflow changes are included in this release preparation.

Deploy compatible collector and analytics ingestion before activating this client. Keep compatible ingestion, additive analytics state, all historical records and pending client events through any client rollback; never reactivate a schema-1-only collector while newer events may replay. Client rollback pins the previously approved scoped package and restores its protected configuration. The deprecated unscoped package remains frozen.

Publication and live installation require separate review and the existing cross-engine/analytics CI and trusted-publishing gates. Local validation and previously accepted source CI do not establish CI acceptance for this release candidate.

## 0.7.0 — published October 21, 2026

This minor release adds reliable, privacy-bounded telemetry delivery on top of 0.6.0. Clients emit schema v2 startup and aggregate tool-metric events with stable event IDs; the local bounded durable queue retries ambiguous deliveries without duplicating collector records. The collector accepts both historical schema v1 and schema v2, rebuilds its receipt index from the retained JSONL on restart, and fails closed when storage is unavailable. No raw commands, arguments, addresses, or result text belong in telemetry.

The v2-compatible collector was deployed before any v2 client activation. After any v2 client has transmitted or queued events, **do not roll the collector back to a v1-only image**, even if clients themselves are rolled back: queued v2 events can replay later. Preserve the append-only history, sidecar recovery semantics, and backup when changing the collector. Disable client reporting with the existing telemetry opt-out where required; do not discard pending events as a release rollback shortcut.

This candidate changes only scoped package and MCP Registry release metadata. The deprecated unscoped package stays frozen. Cross-engine CI and packed-artifact checks passed on the original candidate head `9d2ee45c10348dc59faa4f864ed835b24ea4935c` (tree `03daf9a39d9601a0f8fa30151c8abff72779522f`; CI run `39591903012`). The independently packed artifact SHA-256 is `525ff137a116d1affa4efb85397a762f35afd00e7588ff6f0896677ca83bc303`.

### Interactive Windows acceptance (October 21, 2026 UTC)

The exact locally installed 0.7.0 tarball above was exercised with telemetry opted out in active RDP session 2, not a Session 0/headless surrogate. A same-session out-of-context WinEvent observer recorded foreground, top-level CREATE and SHOW events (UTC timestamps, handles, PIDs and window classes only; no titles/screens). A real, off-screen, nonactivating 1-pixel control window generated a captured SHOW event, establishing that the hook detects genuine window visibility events; a synthetic NotifyWinEvent was attempted separately but had no console HWND and is not positive evidence. During the MCP calls (11:41:44–11:41:47 UTC), the foreground remained handle `0x10258`, PID `3416`; no foreground change or SHOW event was captured. CREATE events for nonvisual `OleMainThreadWndClass` were observed and are not treated as popups. The hook cannot prove the absence of an event outside its 15-second observation interval or a window invisible to these WinEvent categories.

- `run_powershell` (Windows PowerShell 5.1): success, exit 0, `interactive-ps-ok`, MCP execution ID `573f0452-ea75-41d4-b5cd-b23321360286`.
- `run_program` (installed Node executable): success, exit 0, `interactive-native-ok`, MCP execution ID `02c07fac-fba7-4d4b-85c3-632e3c145a2f`.
- `start_execution` → `cancel_execution`: job `04c428063cdba8b5a5253e91e4a30cd8249e849b7681d875` changed running → cancelled. Owned parent PID `13756` and native child PID `6932` were recorded before cancellation; both were absent in an independent process readback afterward. An earlier exploratory run reported cancelled but had not identified its child; it is not the child-termination proof.

Evidence (local, not committed; privacy-limited): `C:/Users/aegis/AppData/Local/hermes/cache/scratch/pr46-interactive-events-v3.jsonl`, `pr46-interactive-results.json`, and `pr46-interactive-session.json` in the same directory; observer/client source `pr46-interactive-observer.py` and `pr46-interactive-run.mjs`. The session receipt establishes that the launch session was the active RDP session 2 (distinct from console session 1). An initial observer failed before observation (incorrect DLL binding) and its failure is not counted as acceptance; the subsequent v2/v3 receipts distinguish exploratory from final child-termination proof. Separate parent review and fresh CI against this documentation commit remain required before any tag or publication. This PR does not publish or activate clients.

## 0.6.0 — published

This minor version reflects a breaking secure default relative to 0.5.3: SSH and SFTP fail closed without independently verified host trust. The scoped npm package `@imrrd/powershell-mcp@0.6.0` and GitHub release `v0.6.0` were published on October 21, 2026; no MCP Registry publication is implied.

### Migration checklist

- Before any SSH/SFTP call, verify the server's host key out of band and pass `hostKeyPins` with an OpenSSH `SHA256:` fingerprint, or set `POWERSHELL_MCP_KNOWN_HOSTS` to an operator-controlled, exact-host OpenSSH known-hosts file. Nonstandard ports use `[host]:port`; unknown and changed keys are rejected. Credential references do not confer trust. There is no trust-on-first-use or insecure bypass.
- PowerShell `errorPolicy: "strict"` is opt-in. Existing callers retain legacy behavior; test scope/output differences before opting in. Typed parameter binding is available without script interpolation.
- Local execution jobs support idempotency, status, logs and cancellation with bounded storage/output. Configure the private execution parent deliberately and monitor retention; after a restart, previously running jobs are `unknown`, not proven stopped. Reconcile side effects before retrying. Remote SSH/WinRM lifecycle supervision is not included.
- `sftp_upload` and `sftp_download` offer `staged: true` as an opt-in verified transfer. The default remains direct transfer; treat an uncertain staging result as requiring reconciliation rather than blindly retrying.
- Output logs are opt-in via `logOutput: true` where supported and may contain secrets. Restrict access and retention. MCP structured results continue `schemaVersion: 1` with text content for older clients; check client compatibility rather than assuming every consumer reads structured content.
- The deprecated unscoped `powershell-mcp` package is frozen. Migrate to the scoped package. Credential stores and persisted lifecycle records do not automatically migrate or roll back; back up/reprovision credentials through approved operator procedures.

### Release gates and rollback

For this historical release, cross-engine CI, explicit nonzero collector discovery, installed-tarball smoke, and manual interactive hidden-execution/unchanged-focus checks were required before tagging. Headless tests alone cannot establish foreground preservation. Live host trust/credential migration and production behavior remain operator acceptance responsibilities. This release does not include the unmerged batch/jump work from PR #35 (or any #23 batch/jump scope).

Rollback of a 0.6.0 client means pinning the previously approved scoped package (for example `@imrrd/powershell-mcp@0.5.3`) and restoring its client configuration, after reconciling running/unknown jobs and credential state. Older trust behavior may be less secure: do not remove host-key verification merely to make rollback work. Publication did not automatically switch production clients.

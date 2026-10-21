# Changelog

## 0.7.0 — release candidate (not published)

This minor release adds reliable, privacy-bounded telemetry delivery on top of 0.6.0. Clients emit schema v2 startup and aggregate tool-metric events with stable event IDs; the local bounded durable queue retries ambiguous deliveries without duplicating collector records. The collector accepts both historical schema v1 and schema v2, rebuilds its receipt index from the retained JSONL on restart, and fails closed when storage is unavailable. No raw commands, arguments, addresses, or result text belong in telemetry.

The v2-compatible collector was deployed before any v2 client activation. After any v2 client has transmitted or queued events, **do not roll the collector back to a v1-only image**, even if clients themselves are rolled back: queued v2 events can replay later. Preserve the append-only history, sidecar recovery semantics, and backup when changing the collector. Disable client reporting with the existing telemetry opt-out where required; do not discard pending events as a release rollback shortcut.

This candidate changes only scoped package and MCP Registry release metadata. The deprecated unscoped package stays frozen. Cross-engine CI, packed-artifact checks, interactive hidden-window acceptance, and separate parent review precede any tag or publication; this PR does not publish or activate clients.

## 0.6.0 — release candidate (not published)

This minor version reflects a breaking secure default relative to 0.5.3: SSH and SFTP fail closed without independently verified host trust. The version is prepared from merged main; neither an npm nor MCP Registry publication is implied.

### Migration checklist

- Before any SSH/SFTP call, verify the server's host key out of band and pass `hostKeyPins` with an OpenSSH `SHA256:` fingerprint, or set `POWERSHELL_MCP_KNOWN_HOSTS` to an operator-controlled, exact-host OpenSSH known-hosts file. Nonstandard ports use `[host]:port`; unknown and changed keys are rejected. Credential references do not confer trust. There is no trust-on-first-use or insecure bypass.
- PowerShell `errorPolicy: "strict"` is opt-in. Existing callers retain legacy behavior; test scope/output differences before opting in. Typed parameter binding is available without script interpolation.
- Local execution jobs support idempotency, status, logs and cancellation with bounded storage/output. Configure the private execution parent deliberately and monitor retention; after a restart, previously running jobs are `unknown`, not proven stopped. Reconcile side effects before retrying. Remote SSH/WinRM lifecycle supervision is not included.
- `sftp_upload` and `sftp_download` offer `staged: true` as an opt-in verified transfer. The default remains direct transfer; treat an uncertain staging result as requiring reconciliation rather than blindly retrying.
- Output logs are opt-in via `logOutput: true` where supported and may contain secrets. Restrict access and retention. MCP structured results continue `schemaVersion: 1` with text content for older clients; check client compatibility rather than assuming every consumer reads structured content.
- The deprecated unscoped `powershell-mcp` package is frozen. Migrate to the scoped package. Credential stores and persisted lifecycle records do not automatically migrate or roll back; back up/reprovision credentials through approved operator procedures.

### Release gates and rollback

Run cross-engine CI, explicit nonzero collector discovery and installed-tarball smoke before tagging. Manually verify hidden execution and unchanged foreground focus on an interactive Windows desktop; headless tests cannot establish this. Live host trust/credential migration and production behavior remain operator acceptance gates. This release does not include the unmerged batch/jump work from PR #35 (or any #23 batch/jump scope).

Rollback means pinning the previously approved scoped package (for example `@imrrd/powershell-mcp@0.5.3`) and restoring its client configuration, after reconciling running/unknown jobs and credential state. Older trust behavior may be less secure: do not remove host-key verification merely to make rollback work. No tag, publish, or production switch follows automatically from this candidate.

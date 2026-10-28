# Bounded WinRM diagnostics (issue 64; not deployed)

`winrm_exec` adds an optional `winrmReasons` marginal to wire schema 2 tool
metrics. Every newly recorded WinRM call contributes exactly one reason and one
existing outcome/duration/feature count. Reasons never add calls. Schema 1 and
schema 2 rows without reasons remain valid. No exception text, command, argument,
output, target, credential or user identity enters this marginal.

The local bootstrap inspects the caught exception's **exact runtime type**:
`AuthenticationException`, `UnauthorizedAccessException`, and
`PSRemotingTransportException` become `authentication_exception`,
`access_exception`, and `remoting_transport_exception`, respectively. Other
Invoke-Command exceptions become `invoke_exception`. These describe observed
types, not a verified Kerberos, TLS, endpoint or permission root cause. In
particular, WinRM commonly wraps failures in a remoting transport exception;
the code does not guess the underlying cause from messages, numeric codes,
ErrorRecord category strings or remote output. Unknown/nested types stay generic.

Other codes are `wrapper_result_invalid`, `frame_invalid`, `frame_body_invalid`,
`local_host_error`, `local_launch_error`, `remote_script_error`, `completed`,
`timeout`, `cancelled`, and `unknown`. Timeout and cancellation take precedence;
local exit remains distinct from remote native exit (null). Remote termination
certainty stays unknown. Errors inside the remote script remain script errors
even if the script throws an authentication/access exception. Native stderr and
unchecked native nonzero exits retain the existing WinRM ErrorRecord policy.
Preparation failures before the framed catch may only yield a missing-frame
boundary. A bootstrap compilation failure is not separately diagnosed.

`runWinRm` also serves batch targets. Their adapter outputs retain the code, but
batch start/status/cancel metrics remain RPC metrics: they do not emit additional
WinRM execution metrics or multiply counts when polled. Pre-dispatch throws in
`winrm_exec` record `unknown` reason with the existing error outcome.

Apply `migrate_issue64.sql` as the analytics owner after issue 63, before the new
importer/client. It is transactional and repeatable; it changes no historical
rows, classifications, source bytes or checkpoints. Fresh databases use
`schema.sql` and `roles.sql`. Keep frozen activation manifests/pins unchanged;
the deployment owner must separately review a new deployment closure.

Use the existing restricted analytics login:

```sql
SELECT * FROM winrm_diagnostics_utc(:from_utc, :to_utc);
```

This report uses a half-open UTC event window of at most 31 days and the existing
cohort/privacy guard. It exposes only origin, reason and aggregate calls. It
withholds the entire result for small reason cells, their complements, missing
coverage remainders, and remainders derived by subtracting known reason groups
from outcome groups. Empty results mean unavailable or withheld, not zero.
`uninstrumented` explicitly accounts for metric calls without recorded reasons;
`unknown` is an instrumented call without more specific boundary evidence.
Neither assigns a cause. Existing dashboard/digest metric views retain the
original three axes. Counts, outcomes and reasons must never be summed together.
This is not a general guarantee against every possible multi-query inference.

The historical 24 aggregate WinRM errors did not emit these distinctions. Their
authentication/access/endpoint/protocol/script attribution remains unsupported.
The parent's successful authorized DEV Kerberos positive control proves that
route at that observation time; it neither diagnoses nor resolves those errors.
Local synthetic exception injection verifies classifier boundaries, not an
actual rejected Kerberos login, access denial or endpoint outage.

Roll out the compatible database migration, importer and collector before new
clients. Older collectors reject the optional axis; older importers reject it
and leave their checkpoint unchanged. Keep reader compatibility while queues
can replay new events; do not roll the collector/importer back beneath that
contract or remove persisted reason rows. Preserve opt-out and delivery queues.
No package version, production policy, runtime activation or release is changed.
Windows PowerShell 5.1/PowerShell 7 acceptance, required hosted OS/runtime lanes,
independent review and separately authorized release/runtime acceptance remain
distinct gates.

# Issue 43: readable private digest candidate

Issue 75 adds a bounded consumer repair, developed against synthetic fixtures.
The first screen now distinguishes observed, active and startup-only installations
by origin, names the largest recorded error volume and highest error proportion
independently, and offers at most three evidence-backed review actions. Error,
nonzero, timeout, cancellation and unknown remain separate in the detail table.
Outcome coverage describes complete metric tool/origin marginals, not the share
of all executed calls. Groups with fewer than 100 recorded outcomes are labelled
small samples; this is a descriptive caution, not a statistical confidence bound.

The same read-only repeatable-read snapshot now requests
`winrm_diagnostics_utc(start,end)` separately from general metric axes. Both
alternatives render only validated finite reasons and same-window reason coverage
when disclosed. `unknown` is instrumented without a specific reason;
`uninstrumented` is a missing reason axis. Reasons are independent marginals,
never extra calls or error-specific rates, and observed boundaries do not prove
authentication, permission, transport or script root causes. Empty results are
unavailable or withheld; the renderer never reconstructs suppressed reasons from
other totals. Diagnostic small-cell, missing-axis and outcome-minus-known-reason
complement protection applies even with private small-count permission. The
existing audience opt-in continues to govern other private aggregate counts.

The trend correction queries adjacent complete Monday-to-Monday UTC weeks and
`(origin, version_bucket, event)` batch counts in the **same** read-only
repeatable-read transaction, using half-open windows. Prior-week hourly receipts
and valid timestamp quality are required for comparison. Prior-week health
refusal preserves the current report's existing health admission. Both MIME
alternatives compare actual version/instrumentation batch coverage and flag
changed version shares, distinguishing batches from calls.

Call changes and error/timeout percentage-point changes require positive
same-stream tool/origin denominators and the **same single known client version
within that origin/stream** in both weeks. This permits tool/version attribution
without joining the versionless tool/axis views to event rows. Legacy and metric
streams can qualify independently at different versions. Matching multi-version
batch shares do **not** establish matching per-tool call shares; such call/rate
comparisons refuse even with stable batch mix. `other`, missing cohorts,
missing/zero denominators and missing outcome axes have explicit refusals.
Complete outcome marginals supply error/timeout denominators; absent outcomes
never become zero. Samples below 100 are flagged. Changes remain descriptive:
batching, workload, selection and late arrivals preclude statistical or causal
improvement claims. A later reconstruction may include late arrivals; this does
not freeze historical delivery or establish complete upstream collection.

Before findings render, cells, partition complements, outcome-coverage
complements and absolute cross-week differences are checked. Composite changes
are checked for every union of cells within each guarded partition: version
batches by origin/event, instrumentation by origin/version, event/version cells
by origin, tools by origin/stream and by stream across origins, and each separate
tool/origin metric axis. This includes `total - error - timeout`, failure totals
(`nonzero + error + timeout`) and their remainders, rather than just one-cell
complements. Source cells are nonnegative; once each endpoint cell is zero or at
least ten, their unions and complements also meet that endpoint threshold. The
cross-week guard checks signed sums of cell changes, including unions whose
individual changes cancel to a positive absolute value below ten.

A positive value below ten withholds both
windows' numeric surfaces, including current findings/details that would reveal
a suppressed delta. The private small-count opt-in does not bypass new trend
suppression. Existing audience validation and SQL diagnostic suppression retain
their behavior. No installation linkage across weeks is inferred. This is
conservative partition protection, not a general differential-privacy guarantee
across unlimited independently retained reports. It does not establish privacy
for arbitrary relations between different partitions or link installations
across weeks. Optional-user and installation complements and the independent
WinRM reason/outcome guards retain their existing scope; no joint distribution
is inferred from overlapping marginals.

The privacy correction is exercised through the actual JSONL importer and
restricted PostgreSQL queries, then the sender entrypoint and both serialized
MIME alternatives using a memory sink. The reproduced remainder is 120 versus
121, despite all source cells, individual changes and one-cell complement
changes meeting ten. Default and approved private output both withhold it;
a remainder of 120 versus 130 still publishes useful comparisons. Unit MIME
regressions also cover zero and nine, three-cell failure complements, other
metric axes, tool partitions and version batches. Independent review of the
replacement exact tree remains required before any PR.

Mixed-version per-tool comparisons and per-version WinRM reasons remain an
explicit parent SQL dependency described below. The implemented batch and
eligible same-stream comparisons are substantive supported comparisons, not an
unconditional unavailable claim. Release/deployment status remains unavailable.
Remaining parent acceptance includes independent review, real restricted preview,
installed dashboard/frontend acceptance and hosted CI/release gates. No timer,
recipient, transport, configuration or original intent ledger is changed.

### Minimal restricted SQL dependency (proposal only; not installed)

For mixed-version tool comparisons, add exactly one restricted function after
parent review: `tool_version_outcomes_utc(from_utc timestamptz, to_utc timestamptz)`
returning `(origin text, version_bucket text, stream text, tool text, axis text,
bucket text, calls numeric)`. Its aggregate core is:

```sql
WITH e AS (
  SELECT event_key, origin, version_bucket FROM telemetry_event
  WHERE event_at >= from_utc AND event_at < to_utc
), cells AS (
  SELECT e.origin, e.version_bucket, t.stream, t.tool,
         'calls'::text AS axis, 'total'::text AS bucket, sum(t.calls)::numeric AS calls
  FROM e JOIN telemetry_tool t USING (event_key)
  GROUP BY e.origin, e.version_bucket, t.stream, t.tool
  UNION ALL
  SELECT e.origin, e.version_bucket, 'metrics', a.tool, 'outcomes', a.bucket,
         sum(a.calls)::numeric
  FROM e JOIN telemetry_metric_axis a USING (event_key)
  WHERE a.axis = 'outcomes'
  GROUP BY e.origin, e.version_bucket, a.tool, a.bucket
)
SELECT * FROM cells;
```

That core is **not** safe as a standalone grant. The parent-owned function must
be `STABLE SECURITY DEFINER SET search_path = public, pg_temp`, revoke PUBLIC
execution, and admit only `0 < to_utc-from_utc <= interval '31 days'` with the
existing `privacy_window_safe_utc` gate. Before returning **any** row, suppress
the entire result on a negative or positive-below-ten cell/complement in:
`(origin,stream,tool,axis)` partitioned by `(version_bucket,bucket)`;
`(origin,version_bucket,stream,axis,bucket)` partitioned by tool; and
`(origin,version_bucket,tool)` call total minus summed outcome coverage. Retain
all six finite outcome buckets as separate marginals and validate totals; emit
no invented zero outcomes for absent instrumentation. Consumer admission must
check version-specific complete outcome coverage and the two-window complement
guard before publishing. Grant only function execution to the existing restricted
reporting role after parent review; never grant raw tables, keys or payloads.

This is the exact minimal new grouping required; extending the identifier-free
views cannot safely recover the missing join. A version-specific reason marginal
would separately require a sibling restricted function
`winrm_diagnostics_version_utc(from_utc timestamptz, to_utc timestamptz)` returning
`(origin text, version_bucket text, reason text, calls numeric)`, retaining the
existing `winrm_diagnostics_utc` consumer contract and all its current
reason/outcome complement checks at the new grain. Neither proposal creates a
reason/outcome **joint** distribution: no conditional per-version error-reason
rate is supported by these stored independent marginals. No migration, schema,
grant or deployment change is included in this correction.

This source is prepared for parent review. No deployment, timer activation, production authentication or mail submission is performed here. The operator confirmed receipt of the original 12–19 October 2026 UTC email. Preserve its intent permanently; presentation changes never authorize a resend. Issue 43 remains open until an actual timer-triggered delivery is confirmed separately from the manual one-shot.

The report uses the existing restricted PostgreSQL views and repeatable-read, read-only snapshot. It renders matching plain-text and HTML alternatives, readable UTC dates, separate legacy-count and metric-stream totals, per-tool bars, installation proxies and startup-only segmentation, failure numerators and compatible outcome denominators, cancellations, unknown outcomes, and recorded duration buckets. Investigation rows rank observed failures and slow operations without asserting root causes. Missing outcomes are unavailable, including weeks preceding instrumentation; no synthetic zeros, averages or percentiles fill missing evidence. HTML escapes dynamic values and has no remote assets or tracking.

Default suppression withholds all numeric adoption/event/tool/axis marginals and bars if any small cell could disclose a complement. Exact small counts require a protected `private_small_counts` object equal to the outer `sender`, `recipient`, and `approved_recipients` fields. The only admitted private recipient and allowlist are `isak@ialogics.com` and `["isak@ialogics.com"]`. Bind the exact established sender during commissioning; do not invent a replacement sender. This validation also runs for both preview formats. Dashboard/public policy and grants are unchanged. Only finite client/importer dimensions may appear; identifiers, hostnames, commands, arguments, outputs, credentials and raw errors never enter the report.

The existing gates still require a checkpoint no older than two hours, zero unassignable all-history receipts, valid selected-week timestamps, and a positive receipt in every hour of the closed week. Future checkpoints fail too. Sparse legitimate traffic can therefore refuse a report; hourly evidence cannot establish complete upstream delivery. Failures produce a nonzero process exit and a generic diagnostic, not a false-zero digest. Monitor failed/absent service runs and importer failures externally.

## Durable schedule and rollback

The disabled systemd template invokes `--scheduled` Monday 03:00 UTC with `Persistent=false`. The application accepts scheduled execution only Monday 03:00–05:00 UTC. Missed weeks are not automatically caught up. Set `schedule_prior_week_end` to `2026-10-19` in protected config and retain the original intent in the same stable state directory. Scheduled execution refuses missing state, an empty/missing anchor, or a symlink anchor. Do not generate a replacement anchor to pass readiness.

Intent names retain the original SHA-256 input and `.attempted` suffix. Exclusive creation, file fsync, and POSIX directory fsync precede SMTP. Concurrent ticks, restart and ambiguous acceptance cannot automatically resubmit. An additional durable `.accepted` receipt records SMTP acceptance and whether the CLI used `--scheduled`; it does not prove a systemd tick or recipient receipt. Keep journal/timer evidence separately. Windows tests do not establish POSIX directory durability.

Rollback disables/stops the timer, retains all intent/acceptance files, restores prior reviewed script/unit/config bytes and ownership/modes, and verifies the timer is inactive. Never restore a stale state backup over newer intents. Preserve the earlier deployment rollback bundles and all collector/database history permanently. Monitor state capacity, JSONL/database/WAL/index growth, checkpoint lag and restore-tested protected backups; query windows are not retention periods.

## Verified access and remaining commissioning prerequisites

Read-only discovery on 26 October 2026:

- PostgreSQL host: `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i C:/Users/aegis/.ssh/aegis_golem_ed25519 aegis@192.168.100.81` reports `docker-xrv3`. The installed existing code/venv is under `/opt/analytics-reviewed`; `/etc/analytics-recurring/digest.json` is disabled and has no configured audience or transport. Its protected importer DSN is not a substitute for the restricted digest role.
- `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes golem` reports `docker-xrv1`. Original intent: `/opt/analytics-reviewed/digest-state/81662c20e8dbb66c17ada57f133a7bda93b901af9eda8c50a7fecf018f7675db.attempted`, 87 bytes, SHA-256 `07e0ea74d817554eb748e9af1bc1adcc0845569bb9f5a4341c459817a86b1e44`. The key independently matches the original UTC week and approved recipient. No original intent bytes were changed.
- Production route from docker-xrv3 resolves `mail.ialogics.co.uk` to `154.73.188.14` and completes certificate-validated STARTTLS (TLS 1.3) on 587. No login or MAIL transaction was attempted. SMTP is Palladium; Golem development Mailforge is not an alternate route. The adapter refuses another hostname/port.
- The timer is absent/inactive. Proposed `/opt/analytics-private-data/venv/bin/python` and `analytics-digest` identity are absent. The template is therefore not ready to enable. No reusable digest commissioning script was found in the inspected local/target locations; do not claim one ran. Existing protected config references were projected by allowlisted keys only, without exposing credential contents.

After independent source review and exact-head CI, parent must commission the template's actual caller on docker-xrv3: root-owned reviewed code/unit bytes, dedicated identity, pinned psycopg 3.3.6 runtime, protected `/etc/analytics-private/digest.json` and `digest.env`, and private `/var/lib/analytics-private/digest`. Bind `ANALYTICS_DSN` to the established aggregate-only role using verify-full and the protected CA from that caller's actual namespace; the known container-local route is not proof of host-network admission. Bind SMTP password by protected reference and retain the established sender. Preserve previous files/permissions outside provisioning before replacing anything. Transfer the original intent from Golem byte-for-byte, verify the above hash at both ends, and leave the Golem copy intact. Do not use an empty state directory. Set `enabled` to the JSON boolean `true` only at the parent live gate.

Use committed Git blobs for installation, not CRLF-converted working-tree bytes. Validate installed hashes, environment-file ACLs, Linux unit syntax, restricted role raw SELECT/INSERT denial, same-caller authenticated aggregate preview, and SMTP TLS/auth readiness without sending. A private preview command after those prerequisites is:

```sh
sudo systemd-run --wait --pipe --collect --unit=analytics-digest-preview \
  -p User=analytics-digest -p Group=analytics-digest \
  -p EnvironmentFile=/etc/analytics-private/digest.env \
  /opt/analytics-private-data/venv/bin/python /opt/analytics-private-data/weekly_digest.py \
  --config /etc/analytics-private/digest.json --state-dir /var/lib/analytics-private/digest --preview-html
```

Capture that output only in a protected local artifact. It creates no send intent. This command requires parent approval for transient service creation and has not been executed by this dispatch. If data refuses the report, fix the actual collection condition; do not relax the gate or substitute fixture figures.

The executable activation step, **only after parent approval and the prerequisites above**, is:

```powershell
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -i C:/Users/aegis/.ssh/aegis_golem_ed25519 aegis@192.168.100.81 'sudo -n systemctl daemon-reload && sudo -n systemctl enable --now analytics-weekly-digest.timer'
```

At discovery time `systemd-analyze calendar "Mon *-*-* 03:00:00 UTC"` returned the next tick as 2 November 2026 03:00 UTC. Recheck before activation. Acceptance requires timer-triggered journal provenance, a new week-specific `.attempted` and `.accepted` receipt, operator-confirmed receipt by the approved recipient, and a replay refusal with no second submission. A manually invoked `--scheduled` fixture or successful `systemctl start` does not establish that gate.

## Reproduction and evidence

From the candidate worktree, with a disposable PostgreSQL database on loopback:

```powershell
$env:PYTHONDONTWRITEBYTECODE='1'
$env:ANALYTICS_TEST_DSN='postgresql://postgres@127.0.0.1:55443/postgres'
python -m unittest discover -s collector/analytics -v
python -m unittest discover -s collector/analytics/operations -p 'test_*.py' -v
git diff --check
```

A scratch-only PostgreSQL 17.11 cluster was created under `C:/Users/aegis/AppData/Local/hermes/cache/scratch/issue43-candidate-20261026`. Set the fixture database timezone to UTC, matching CI. The initial run with the cluster's inherited Africa/Johannesburg timezone exposed an existing date-literal health-test assumption; rerunning with UTC passes without SQL/dashboard changes. The real database test ingests synthetic hourly rows, connects as a dedicated restricted LOGIN (asserting both session_user and current_user), executes the actual aggregate queries, verifies separate 3/2 streams and 1/2 failure rate, denies raw reads/writes, and checks unavailable metrics and stale refusal. These are local synthetic proofs, never production usage.

The isolated SMTP test creates a short-lived localhost certificate, uses real STARTTLS/AUTH and multipart DATA to a loopback-only sink, races fresh scheduled CLI processes, then replays in another process. Exactly one message is accepted; the anchor remains unchanged. Separate outage, audience, route, serialization and uncertain-acceptance tests prevent sends. POSIX-only tests may skip on Windows; hosted exact-head CI and independent review are pending because this dispatch does not push or open a PR.

The original issue43 worktree was archived byte-for-byte (tracked and untracked files) at `C:/Users/aegis/AppData/Local/hermes/cache/scratch/issue43-candidate-20261026/original-worktree.zip`. All original worktrees remain unchanged. Neither the suggested `fix/43-digest-readable` branch nor uncommitted readable source was present at inventory. Candidate work is isolated on `fix/43-reviewed-digest` from current `origin/main` (`7e9d9e4`). Synthetic HTML/text examples in the same scratch directory are explicitly labelled, not live reports.

Baseline local results before independent review: analytics ran 24 tests with no skips; operations ran 81 tests with one POSIX-only backup-fsync skip on Windows. These results did not catch the two blockers corrected below.

## Independent-review corrections, 26 October 2026

Correction base: `8d3ee721a581adc3ffb2587c5d9a8e85dc190866`. Default suppression now checks derivable installation complements: observed minus active, observed minus startup-only, and observed minus both disjoint subsets. The actual importer/PostgreSQL regression produces observed 12, active 11, startup-only 0, with every positive supplied reporting aggregate at least 10. Both renderings now withhold numeric detail because the other-installations remainder is 1. Explicit audience-bound private exact-count approval still renders the proxies. Boundary tests cover complements 0, 1, 9 and 10. The general rendering fixture now uses 12/12/0 so unrelated presentation tests exercise an unsuppressed report.

Investigation rows retain absent outcomes or duration axes as unavailable in both serialized MIME parts. Separate tables rank complete evidence by failures then slow operations, outcomes-only evidence by failures, and duration-only evidence by slow operations. Missing values never enter a numeric ranking. Tests cover both missing-axis directions, descending ordering within each available-evidence group, and an actual zero slow count from a present duration axis.

RED was recorded before changing production code: the complement unit regression, missing-axis MIME/ranking regression, and actual PostgreSQL complement regression each failed. The same three tests passed after the fix. Logs are scratch-only under `C:/Users/aegis/AppData/Local/hermes/cache/scratch/issue43-candidate-20261026`:

| Evidence | Result | SHA-256 |
| --- | --- | --- |
| `correction-red.log` | 3 tests, 3 expected failures | `26c4a5a1b306e17e0128ae5a08fd8d3a060af97a229ee944c32e065ffd841aa0` |
| `correction-green.log` | Same 3 tests passed | `c481d410f638b8e666b7ef1748c18e560b36fb5d62f1c7466f67d9d26310131c` |
| `correction-analytics.log` | 25 tests passed, no skips; actual PostgreSQL 17.11, UTC | `7da41409f7ba405ba9783f28480c58816a6ffe7daa6eaccd03e58adcbf812bca` |
| `correction-operations.log` | 84 tests run: 83 passed, 1 skipped | `c260dfa263dd6b8fd8af326f43bb027f497d46f411e2fce59d2133e519564b69` |

The sole skip is `test_private_backup.BackupTests.test_posix_receipt_syncs_parent_directory`: `POSIX directory fsync requires POSIX runner`. The real localhost STARTTLS concurrent-process/replay test ran and passed. The disposable PostgreSQL fixture was stopped after testing; zero analytics test schemas remained. All temporary fixture files stayed under the scratch root. No production SMTP, credentials, raw production data, timers, or installed state were accessed or changed.

The added original-week replay regression seeds the exact synthetic copy of the 87-byte intent payload and verifies refusal before SMTP, with unchanged bytes and no extra receipt. The 12–19 October key remains `81662c20e8dbb66c17ada57f133a7bda93b901af9eda8c50a7fecf018f7675db.attempted`; production intent-generation/submission code and systemd templates are unchanged. The sole admitted audience remains `isak@ialogics.com`. `git diff --check` passed. Parent review and the live scheduled-delivery gate remain outstanding; this correction does not authorize a resend, deployment, push, merge, or issue closure.

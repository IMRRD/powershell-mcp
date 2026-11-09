# Issue 75 joint-partition correction — 9 November 2026

The residual same-stream cross-tool partition blocker is corrected locally.
Independent exact-tree re-review is required before PR. This records one bounded
implementation pass; it grants no independent approval or issue75 acceptance.

One session, no agents or model switch. Read the complete
`REVIEW-75-PRIVACY-CORRECTION.md`, unchanged `review_joint_axes.py`, prior review
and correction contracts, reporting/importer/schema/role/rendering contracts,
and the telemetry operations and TDD skills. No applicable AGENTS.md was found
in the checkout or relevant ancestry. No production access, real mail, existing
credential/consent changes, publication, push, GitHub writes or deployment.

## Source and evidence binding

- Checkout: `C:/Users/aegis/AppData/Local/hermes/workspace/powershell-mcp-issue75`.
- Baseline HEAD: `1bf8e3d6150c4d53c0d618086984cfc76daa2a05`.
- Baseline tree: `a19bb5f8f7d329d88b4692d78ce960f5e27f9669`.
- Tested implementation HEAD: `356cc8d0df9991e7e1ac94fb9291c00d88e5763f`.
- Tested implementation tree: `1f99f1a0d5b0d3c78201864e5d3e81c7ef66bc04`.
- Implementation commit: `fix(reporting): guard jointly released stream partitions`.
- Implementation correction: four files, 250 insertions, 16 deletions.
- Implementation cumulative against `a2ac01f5a038874e9e36f8c4f002e3bd02bab131`:
  15 files, 1,499 insertions, 38 deletions.

This committed receipt is a documentation-only follow-up to the tested
implementation. The companion receipt at
`C:/Users/aegis/AppData/Local/hermes/operations/mcp-actionable-reliability-scope/RESULT-75-JOINT-PARTITION.md`
records the final receipt commit's HEAD/tree and complete path comparison,
avoiding a self-referential commit hash inside this file.

Evidence root:
`C:/Users/aegis/AppData/Local/hermes/operations/mcp-actionable-reliability-scope/issue75-joint-partition-evidence/`.
Old evidence directories were never output destinations. Their manifests still
verify: original review 30 entries, previous correction 31, correction review 87.
Baseline/candidate copies of all three independent scripts are byte-identical
to the retained review sources. SHA-256:

- `review_privacy.py`: `cdae9542a2b38d17a26ab0ada916304f6959947e31a25b70bcf4c1be1c3be57f`.
- `review_joint_axes.py`: `833f659a9fcd8a432807a873e7a813de6c759d37b5cff8830e143a1f725266b4`.
- `independent_controls.py`: `8f368263224063544ced0ced1789eb943e7e201a7ae4588eed3a4e412dbf5233`.

## Partition construction and limits

The previous helper received outcome cells separately per origin/tool, allowing
errors 100 + 20 to become 79 + 42 across two tools: a union of 120 versus 121.
Both tool totals stayed 1,000 and all local nonzero changes met ten.

Construction now uses six maximal disjoint partitions: all
`(origin,version,event)` batch cells; `(origin,tool)` calls separately for each
counts/metrics stream; and `(origin,tool,bucket)` metric calls separately for
each outcome, duration and feature axis. Missing-axis groups contribute a
whole-tool uninstrumented cell. No overlapping streams or independent axes are
added together, and missing outcomes remain distinct from observed zero.

Within the scoped partition class, every local table, tool total, same-axis
cross-tool/origin union and its complement is a union of these refined cells.
Complete nonnegative marginals are validated first. Zero-or-at-least-ten
primitive endpoint cells establish the same endpoint property for every union.
The signed subset guard then checks every possible union's cross-week change;
its complementary union is another subset of the same partition. This addresses
the partition construction class rather than a particular error numerator.
The event-batch refinement likewise covers unions across origins and event
types that the per-origin construction missed.

Each search refuses after 1,024 union keys, 128 bits per cell change, 8,192
carried partial sums or 262,144 partial-sum expansions. Temporary candidate and
pruned sets have at most 16,384 entries; an over-limit pruned set is never carried
to another expansion. At most six searches run. Same-sign/GCD shortcuts and
remaining-sum pruning retain exact admission within budget. Exhaustion withholds
comparison endpoints and current reconstructing numeric findings/details for
both default and correctly approved private audiences. These are finite search
bounds, not an end-to-end database result-size or memory/time guarantee.

Other inspected current-only surfaces retain existing policy: installation and
optional-user complements, and WinRM reason/outcome mappings. No previous user,
adoption or diagnostic-reason distribution is queried or rendered. Duration and
feature prior buckets are conservatively guarded, although the trend table
does not print their previous endpoints. No hidden joint distribution is inferred.

## RED, correction and execution

Before changing production code, the unchanged joint reproducer ran on the
baseline: four methods, two controls passed, two privacy methods failed in both
MIME alternatives (four failing subtests), no errors/skips. The new nine-method
selection then had four passing methods and five failing methods, 47 assertion
or subtest failures, no setup errors/skips. It exposed cross-tool/origin axes,
missing-instrumentation remainders, global event batches and absent search limits.

The first candidate selection passed eight methods and failed the state-limit
test: its two-cell fixture pruned down to one state, so a one-state cap was never
exceeded. The fixture was corrected to three mixed-sign cells; production code
was unchanged. Final selection and subsequent full suites passed. No additional
privacy failures were silently patched after those suites.

| Fresh check | Run | Passed | Failed | Errors / skips |
| --- | ---: | ---: | ---: | --- |
| New final regression selection | 9 methods | 9 | 0 | 0 / 0 |
| Full analytics discovery | 61 | 61 | 0 | 0 / 0 |
| Full operations discovery | 106 | 105 | 0 | 0 / 1 |
| Unchanged original review reproducer | 5 methods | 5 | 0 | 0 / 0 |
| Unchanged joint review reproducer | 4 methods | 2 | 2 | 0 / 0 |
| Unchanged independent controls, including 1,650 oracle cases | 6 methods | 6 | 0 | 0 / 0 |
| Unchanged issue70 consumer handoff | 3 | 3 | 0 | 0 / 0 |
| Retained restricted-LOGIN MIME selection | 4 methods | 4 | 0 | 0 / 0 |
| Additional exhaustive bounded-guard oracle | 1,950 cases | 1,950 | 0 | 0 / 0 |

Selections overlap full-suite discovery. No tests were excluded. The sole skip
is `test_private_backup.BackupTests.test_posix_receipt_syncs_parent_directory`,
reason `POSIX directory fsync requires POSIX runner`.

The unchanged joint reproducer is **not green** after correction. Both privacy
methods stop at line 81, `assertFalse(completed_week_trends(...)["unsafe"])`,
because the corrected guard returns true. Later assertions also require the
disclosing endpoint strings to remain present before checking for withholding.
Those exposure-witness assertions are incompatible with successful suppression.
The two ten-change controls pass unchanged. The script was neither edited nor
relabelled successful; new source tests establish the desired suppression.

Those source tests use actual non-superuser importer and reader LOGIN sessions,
not SET ROLE: importer DDL and reader raw SELECT/INSERT are denied;
current_user equals session_user; 376 JSONL rows import and replay imports zero;
both SQL privacy windows are true; both tools have complete 1,000-call
marginals, singleton 0.8.0 batch cohorts, 20 observed/active installations and
complete receipt hours. Read-only repeatable-read settings are asserted. The
production sender makes a fresh restricted connection and serializes into an
in-memory sink. Eight labelled synthetic MIME artifacts retain suppression for
both audiences, zero/default and ten/private controls. Unit MIME controls cover
zero and ten for both audiences and cross-origin groups; unchanged independent
controls also exercise boundaries zero, one, nine and ten for both audiences.

Additional native-budget evidence uses a mathematically safe 101-cell partition
whose sums are multiples of 10,000 or congruent to -11 mod 10,000. It refuses at
8,193 pruned states (8,194 candidate states, 8,205 expansions), in about 0.016 s
on this machine. This is conservative budget refusal, not a privacy finding.
A 1,024-cell GCD control is admitted, a 1,025-key union is refused, and a
129-bit change is refused. The extra oracle enumerates all subset sums in 1,950
deterministic cases up to 12 cells, including missing/empty cells, with no mismatch.

Full suites preserve actual concurrent late-arrival snapshot behavior, version
refusals, observed-zero/missing distinctions, audience admission and isolated
loopback STARTTLS/AUTH scheduled-process/replay acceptance. The latter accepts
exactly one synthetic SMTP message; no production SMTP is contacted.

## Owned runtime, commands and cleanup

Reused Python 3.11.15, psycopg 3.3.6 and PostgreSQL 16.15; no downloads/upgrades.
Initialized a new owned cluster at `$e/pgdata`, with `$e` the evidence root above,
listener exclusively `127.0.0.1:57580`, database `issue75_joint`, UTC. No existing
cluster was started or modified. `run_checks.py` records exact arguments, exit
codes and log hashes in `executions.jsonl`; it sets disposable ANALYTICS_TEST_DSN,
PGOPTIONS UTC, PYTHONPATH for both reporting directories, no bytecode and
POWERSHELL_MCP_NO_TELEMETRY=1. Principal invocations through that runner:

```powershell
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" analytics-full -m unittest discover -s collector/analytics -v
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" operations-full -m unittest discover -s collector/analytics/operations -p 'test_*.py' -v
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" original-reproducer-final "$e/candidate/review_privacy.py"
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" joint-reproducer-final "$e/candidate/review_joint_axes.py"
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" independent-controls-final "$e/candidate/independent_controls.py"
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" accepted-consumers-final test-evidence/issue70-consumer-gaps.py
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" retained-mime "$e/capture_mime.py"
test-evidence/venv/Scripts/python.exe -B "$e/run_checks.py" bounded-guard "$e/check_bounded_guard.py"
test-evidence/postgres-runtime/pgsql/bin/pg_ctl.exe -D "$e/pgdata" -m fast -w stop
test-evidence/postgres-runtime/pgsql/bin/pg_ctl.exe -D "$e/pgdata" status
```

Runner labels are immutable output destinations; replay under new labels.
Analytics and operations ran concurrently against independent random schemas.
Final database inspection found zero test schemas and zero fixture roles. Owned
stop returned 0, status returned 3 (`no server running`), and subsequent loopback
connection returned 2 (connection refused). The owned cluster is stopped.

Primary evidence includes `joint-reproducer-red.log`, `regression-red.log`,
`regression-green.log` (the state-fixture failure), `regression-final.log`,
the full-suite/reproducer/control logs, eight synthetic MIME bodies,
`bounded-guard.log`, source/path bindings, final DB/stop/refusal logs and SHA256SUMS.

## Remaining limits and acceptance

No new blocker was found within the scoped disjoint same-stream/same-axis
partition class. This is local implementation evidence, not independent approval
or a general privacy guarantee across arbitrary overlapping marginals,
installation linkage, unlimited retained reports or hidden joint distributions.
Conservative search exhaustion can withhold useful large safe reports.

Importer, schema, grants, migrations, mixed-version SQL, dashboard, transport,
scheduler, send intents, audience configuration, Node, packaging and CI source
are unchanged. Proposed mixed-version restricted SQL remains unimplemented and
unaccepted. Previous installed-package offline ENOTCACHED failure remains
unpassed; this reporting-only pass did not rerun or relabel that gate. Hosted
exact-head PR and merged-main CI, full platform/native/installed-artifact gates,
POSIX durability, restricted live previews, frontend/installed consumer
acceptance, deployment and real/natural scheduled delivery remain outstanding.
Parent must independently re-review the final exact tree and reassess the design
before any further correction, PR or acceptance claim.

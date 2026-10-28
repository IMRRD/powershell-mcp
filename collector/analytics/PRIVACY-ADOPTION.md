# Privacy adoption contract (candidate; no live adoption asserted)

The wire still uses schema 1 for startup/counts and schema 2 for metrics. Optional
`cohort` accepts only `external_self_declared`; optional `userId` accepts only a
canonical lowercase random UUIDv4. Existing installation UUIDs remain unchanged.
Both the collector allowlist and the worker's complete disk replay validator
validate these fields; unknown fields and arbitrary error/command/output/host/IP
labels are rejected. Telemetry opt-out prevents worker, identity, disk and network
activity even when both optional settings exist. The collector never captures peer IP.
Historical JSONL, including legacy IP/probe records, stays protected and permanently retained.

`internal`, `test`, `external_self_declared`, `cohort_conflict`, and `unknown_origin`
are per-event classifications. Internal/test registry plus an external declaration
is a conflict, not silently internal or external. Older missing declarations remain
unknown. An installation/token can occur in several cohorts or windows; distinct
counts are not additive. Only tool-count/metric events establish active installations;
the two overlapping streams and the three metric marginals are never added as calls.

## Protected enrollment

No public enrollment endpoint exists. On the protected importer server, create a
directory owned by the operator with mode 0700 (Windows: protected DACL allowing
only the owner and SYSTEM). Securely transfer the existing `.powershell-mcp-id`
file from an operator-verified internal/test installation into protected storage.
Do not put ID values in commands, tickets, reports, receipts, dashboards or the repo.
Run the following with real protected file paths, not ID values:

```sh
umask 077
mkdir -m 700 /protected/telemetry-cohorts
python collector/analytics/enroll_installation.py \
  --registry /protected/telemetry-cohorts/classes.json \
  --installation-file /protected/telemetry-cohorts/installation-id \
  --cohort internal
```

The helper checks directory ownership/permissions and existing registry access,
locks against concurrent enrollment, caps the registry at 10,000 entries / 1 MiB,
rejects duplicate/conflicting registration, and atomically replaces the JSON after
fsync. An uncertain outcome requires private registry readback; do not remove locks
while an enrollment is running. On Windows directory fsync is not established.
Registry paths must have trusted ancestors and are never supplied by public clients.
Protect importer read access separately using the existing service identity.

Legacy `{internalHostIds:[],testHostIds:[]}` files remain supported for explicitly
verified historical inventory. New enrollment adds `enrollments` with a server UTC
`fromReceiptUtc`. Only receipts at/after that time classify as internal/test; missing
or older receipts remain unknown. Do not edit enrollment times or legacy arrays to
guess historical origins. Imported event origins are immutable on restart; changing
the registry never updates already imported events. Keep protected versioned registry
backups with importer checkpoints for reproducible restoration. The offline report
uses the same receipt-time boundary but does not have the database's historical snapshot;
retain the exact classification snapshot used for each offline report.

## Database and consumer compatibility

Before any operator-authorized rollout, preserve JSONL prefix bytes, database backup,
classification snapshots, checkpoint identity, prior collector image and prior client.
Restore/rehearse in an isolated database first. Fresh databases use `schema.sql` then
`roles.sql`; existing baseline databases use `migrate_issue63.sql` as the owner with
`psql -X --set ON_ERROR_STOP=1 --file collector/analytics/migrate_issue63.sql` and a
protected `PGSERVICE`/password file. The migration adds nullable `user_key`, widens
the finite origin constraint, creates functions and grants only safe functions to
the existing `telemetry_dashboard` role. It is transactional and repeatable; no event,
checkpoint or source is deleted or reclassified. Existing rows retain null user keys.
The importer stores only a domain-separated SHA-256 user key, never the token in `raw`
or views. This remains pseudonymous protected data; hashing is not anonymization.

`adoption_utc` retains its original signature, as do the three identifier-free views
and delivery-health function. `user_proxy_raw_utc` is owner-only, not a dashboard
grant. `user_proxy_utc` releases default-suppressed coverage for observed installations:
observed, covered, unknown-user, distinct consistently covered user-token proxies.
User identity is never inferred for events without it or installations without an ID.
`privacy_window_safe_utc` admits windows at most 31 days and gates **both**
`dashboard.json` and `overview-preview.json`, including collapsed details. Missing
function/migration fails closed. Empty results mean unavailable/suppressed, never zero.

The offline CLI suppresses the whole numeric report on a positive cell under 10 or
a small derivable partition remainder. Dashboard SQL checks displayed event/tool/axis,
version/OS, instrumentation `(origin, version, event)`, receipt-day, quality,
installation and user partitions and complements. Instrumentation complements are
the other tool-batch events within each origin/version, matching the displayed rows.
Selected event and receipt windows consistently use **[from, to)**: exact-start
rows are included; exact-end and later rows are excluded. Dashboard SQL uses explicit
`>= $__timeFrom()` and `< $__timeTo()` filters because Grafana's PostgreSQL
`$__timeFilter` expands to inclusive `BETWEEN`. Delivery health and Data receipt use
the same receipt window. Timestamp-quality panels intentionally cover all history;
their all-history partitions remain checked separately. Import checkpoint timestamps
remain feed metadata rather than event-window counts.
Repeated or overlapping arbitrary windows and arbitrary SQL queries are not a
differential-privacy system; keep Grafana private with bounded query/time access.
Existing restricted roles can read identifier-free event views for approved aggregate
reports; they cannot SELECT/INSERT the raw table or call the raw user aggregate.
Do not expose the datasource as an untrusted query API.

The weekly digest accepts the new finite cohort labels and includes safe optional
user coverage. Its existing exact-small-count exception stays bound to the approved
sender, recipient and allowlist, including previews. It does not bypass the new SQL
user suppression or change dashboard/offline policy. Both MIME parts omit user
counts when small or unavailable. No email is sent by tests to a real recipient.

Deployment helpers under `operations/` have frozen reviewed blob contracts. Their
old hashes intentionally do not authorize these new bytes. The empty-database
recognizer accepts the exact old or issue-63 function inventory; populated databases
still cannot be removed. Re-freezing an activation bundle, verifying restricted
roles/TLS, rendering Grafana and natural production arrivals are separate parent-owned
review/deployment gates. Do not use the old frozen launcher to force this migration.

Roll forward: owner-reviewed migration, compatible collector, new importer and registry,
both dashboards/digest, then client. On rollback, pin the prior client/config first;
retain the compatible collector while any new event can replay. Retain additive database
columns/functions and history; do not drop user data or revert the widened constraint.
Old importers ignore optional fields and cannot supply new coverage; avoid running one
against pending new history. Restore prior presentation only with suppression retained.

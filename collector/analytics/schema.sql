CREATE TABLE telemetry_event (
 event_key text PRIMARY KEY,
 payload_hash text NOT NULL,
 origin text NOT NULL CHECK (origin IN ('internal','test','unknown_origin','external_self_declared','cohort_conflict')),
 installation_key text,
 user_key text,
 event text NOT NULL,
 event_at timestamptz,
 received_at timestamptz,
 version_bucket text NOT NULL,
 os_bucket text NOT NULL,
 raw jsonb NOT NULL,
 event_time_quality text NOT NULL CHECK (event_time_quality IN ('valid','missing','invalid')),
 receipt_time_quality text NOT NULL CHECK (receipt_time_quality IN ('valid','missing','invalid'))
);
CREATE INDEX telemetry_event_window ON telemetry_event (event_at, origin);
CREATE INDEX telemetry_event_installation ON telemetry_event (origin, installation_key, event_at);
CREATE INDEX telemetry_event_arrival ON telemetry_event (received_at) WHERE received_at IS NOT NULL;
CREATE TABLE telemetry_tool (event_key text NOT NULL REFERENCES telemetry_event(event_key), stream text NOT NULL CHECK(stream IN ('counts','metrics')), tool text NOT NULL, calls bigint NOT NULL CHECK(calls > 0), PRIMARY KEY(event_key, stream, tool));
CREATE INDEX telemetry_tool_stream ON telemetry_tool (stream, tool);
CREATE TABLE telemetry_metric_axis (event_key text NOT NULL REFERENCES telemetry_event(event_key), tool text NOT NULL, axis text NOT NULL CHECK(axis IN ('outcomes','durations','features','winrmReasons')), bucket text NOT NULL, calls bigint NOT NULL CHECK(calls > 0), PRIMARY KEY(event_key,tool,axis,bucket));
CREATE TABLE telemetry_checkpoint (source_key text PRIMARY KEY, device bigint NOT NULL, inode bigint NOT NULL, position bigint NOT NULL, prefix_hash text NOT NULL, imported_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION adoption_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS TABLE(origin text, observed_installations bigint, active_installations bigint, startup_only_installations bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT x.origin, count(*), count(*) FILTER (WHERE x.active), count(*) FILTER (WHERE NOT x.active AND x.startup)
 FROM (SELECT e.origin, e.installation_key, bool_or(e.event IN ('tool_counts','tool_metrics')) AS active, bool_or(e.event='startup') AS startup
 FROM telemetry_event e WHERE e.event_at >= from_utc AND e.event_at < to_utc AND e.installation_key IS NOT NULL
 GROUP BY e.origin, e.installation_key) x GROUP BY x.origin
$$;
-- Issue 63: append-only event classification; never rewrite historical origins.
CREATE OR REPLACE FUNCTION user_proxy_raw_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS TABLE(origin text, observed_installations bigint, covered_installations bigint, unknown_user_installations bigint, user_proxies bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH installations AS (
 SELECT e.origin, e.installation_key,
   CASE WHEN count(DISTINCT e.user_key) = 1 AND count(*) = count(e.user_key) THEN min(e.user_key) END AS user_key
 FROM telemetry_event e WHERE e.event_at >= from_utc AND e.event_at < to_utc AND e.installation_key IS NOT NULL
 GROUP BY e.origin, e.installation_key)
 SELECT i.origin, count(*), count(i.user_key), count(*) - count(i.user_key), count(DISTINCT i.user_key)
 FROM installations i GROUP BY i.origin
$$;
CREATE OR REPLACE FUNCTION user_proxy_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS TABLE(origin text, observed_installations bigint, covered_installations bigint, unknown_user_installations bigint, user_proxies bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH cells AS (SELECT * FROM user_proxy_raw_utc(from_utc,to_utc))
 SELECT * FROM cells WHERE to_utc > from_utc AND to_utc - from_utc <= interval '31 days'
 AND NOT EXISTS (SELECT 1 FROM cells c CROSS JOIN LATERAL
 unnest(ARRAY[c.observed_installations,c.covered_installations,c.unknown_user_installations,c.user_proxies,c.covered_installations-c.user_proxies]) n WHERE n > 0 AND n < 10)
$$;
-- Suppress the entire dashboard count surface when any displayed partition or
-- its complement is small. Zero rows mean withheld or unavailable, never zero use.
CREATE OR REPLACE FUNCTION privacy_window_safe_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH e AS (SELECT * FROM telemetry_event WHERE event_at >= from_utc AND event_at < to_utc),
 partitions AS (
 SELECT 'event:'||origin AS partition, event AS cell, count(*)::numeric AS n FROM e GROUP BY origin,event
 UNION ALL SELECT 'version:'||origin, version_bucket||':'||os_bucket, count(*) FROM e GROUP BY origin,version_bucket,os_bucket
 -- Instrumentation panels display event cells within each origin/version.
 UNION ALL SELECT 'instrumentation:'||origin||':'||version_bucket,event,count(*) FROM e WHERE event IN ('tool_counts','tool_metrics') GROUP BY origin,version_bucket,event
 UNION ALL SELECT 'tool:'||e.origin||':'||t.stream,t.tool,sum(t.calls) FROM e JOIN telemetry_tool t USING(event_key) GROUP BY e.origin,t.stream,t.tool
 UNION ALL SELECT 'axis:'||e.origin||':'||a.tool||':'||a.axis,a.bucket,sum(a.calls) FROM e JOIN telemetry_metric_axis a USING(event_key) GROUP BY e.origin,a.tool,a.axis,a.bucket
 UNION ALL SELECT 'receipt:'||origin,date_trunc('day',received_at,'UTC')::text,count(*) FROM telemetry_event WHERE received_at >= from_utc AND received_at < to_utc AND event_at IS NOT NULL GROUP BY origin,date_trunc('day',received_at,'UTC')
 UNION ALL SELECT 'quality',event_time_quality||':'||receipt_time_quality,count(*) FROM telemetry_event GROUP BY event_time_quality,receipt_time_quality
 UNION ALL SELECT 'receipt-quality',event_time_quality||':'||receipt_time_quality,count(*) FROM telemetry_event WHERE received_at >= from_utc AND received_at < to_utc GROUP BY event_time_quality,receipt_time_quality
 ), checks AS (
 SELECT n FROM partitions UNION ALL SELECT sum(n) OVER (PARTITION BY partition)-n FROM partitions
 UNION ALL SELECT unnest(ARRAY[a.observed_installations,a.active_installations,a.startup_only_installations,a.observed_installations-a.active_installations,a.observed_installations-a.startup_only_installations,a.observed_installations-a.active_installations-a.startup_only_installations]) FROM adoption_utc(from_utc,to_utc) a
 UNION ALL SELECT unnest(ARRAY[u.observed_installations,u.covered_installations,u.unknown_user_installations,u.user_proxies,u.covered_installations-u.user_proxies]) FROM user_proxy_raw_utc(from_utc,to_utc) u
 ) SELECT to_utc > from_utc AND to_utc - from_utc <= interval '31 days' AND NOT EXISTS (SELECT 1 FROM checks WHERE n > 0 AND n < 10)
$$;
REVOKE ALL ON FUNCTION user_proxy_raw_utc(timestamptz,timestamptz), user_proxy_utc(timestamptz,timestamptz), privacy_window_safe_utc(timestamptz,timestamptz) FROM PUBLIC;
CREATE VIEW dashboard_events AS SELECT origin, event, event_at, received_at, version_bucket, os_bucket, event_time_quality, receipt_time_quality FROM telemetry_event;
CREATE VIEW dashboard_tools AS SELECT e.origin, e.event_at, t.stream, t.tool, t.calls FROM telemetry_tool t JOIN telemetry_event e USING(event_key);
CREATE VIEW dashboard_metric_axes AS SELECT e.origin, e.event_at, a.tool, a.axis, a.bucket, a.calls FROM telemetry_metric_axis a JOIN telemetry_event e USING(event_key) WHERE a.axis <> 'winrmReasons';
CREATE OR REPLACE FUNCTION delivery_health_utc(as_of timestamptz, from_utc timestamptz, freshness interval)
RETURNS TABLE(status text, last_receipt timestamptz, last_import timestamptz, invalid_event_times bigint, invalid_receipt_times bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM telemetry_checkpoint) THEN 'Unknown: no feed/checkpoint'
             WHEN NOT EXISTS (SELECT 1 FROM telemetry_event) THEN 'Unknown: no receipts'
             WHEN max(e.received_at) IS NULL THEN 'Unknown: no valid receipts'
             WHEN max(e.received_at) < as_of - freshness THEN 'Stale'
             WHEN count(*) FILTER (WHERE e.event_time_quality = 'invalid') > 0 THEN 'Partial: invalid event time'
             WHEN count(*) FILTER (WHERE e.receipt_time_quality = 'invalid') > 0 THEN 'Partial: invalid receipt time'
             ELSE 'Recent receipts (not end-to-end proof)' END,
        max(e.received_at), (SELECT max(imported_at) FROM telemetry_checkpoint),
        count(*) FILTER (WHERE e.event_time_quality = 'invalid'), count(*) FILTER (WHERE e.receipt_time_quality = 'invalid')
 FROM telemetry_event e WHERE e.received_at >= from_utc AND e.received_at < as_of
$$;
-- Run role.sql as an operator after replacing the password placeholder via secret provisioning.

-- Issue 64: bounded diagnostics; separate marginal, never additional calls.
CREATE OR REPLACE FUNCTION winrm_diagnostics_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS TABLE(origin text, reason text, calls numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH totals AS (
 SELECT e.origin,sum(t.calls)::numeric AS calls FROM telemetry_event e JOIN telemetry_tool t USING(event_key)
 WHERE e.event_at >= from_utc AND e.event_at < to_utc AND t.stream='metrics' AND t.tool='winrm_exec' GROUP BY e.origin
 ), reasons AS (
 SELECT e.origin,a.bucket AS reason,sum(a.calls)::numeric AS calls FROM telemetry_event e JOIN telemetry_metric_axis a USING(event_key)
 WHERE e.event_at >= from_utc AND e.event_at < to_utc AND a.tool='winrm_exec' AND a.axis='winrmReasons' GROUP BY e.origin,a.bucket
 ), cells AS (
 SELECT * FROM reasons
 UNION ALL SELECT t.origin,'uninstrumented',t.calls-coalesce((SELECT sum(r.calls) FROM reasons r WHERE r.origin=t.origin),0)
 FROM totals t
 ), outcomes AS (
 SELECT e.origin,a.bucket,sum(a.calls)::numeric AS calls FROM telemetry_event e JOIN telemetry_metric_axis a USING(event_key)
 WHERE e.event_at >= from_utc AND e.event_at < to_utc AND a.tool='winrm_exec' AND a.axis='outcomes' GROUP BY e.origin,a.bucket
 ), known AS (
 SELECT r.origin,CASE WHEN r.reason='completed' THEN 'success'
 WHEN r.reason IN ('timeout','cancelled') THEN r.reason ELSE 'error' END AS bucket,sum(r.calls) AS calls
 FROM reasons r WHERE r.reason <> 'unknown' GROUP BY r.origin,
 CASE WHEN r.reason='completed' THEN 'success' WHEN r.reason IN ('timeout','cancelled') THEN r.reason ELSE 'error' END
 ), checks AS (
 SELECT c.calls AS n FROM cells c
 UNION ALL SELECT t.calls-c.calls FROM cells c JOIN totals t USING(origin)
 -- Also guard error-outcomes minus known error reasons (and other mapped
 -- outcomes); otherwise a large unknown bucket could disclose a small remainder.
 UNION ALL SELECT o.calls-coalesce(k.calls,0) FROM outcomes o LEFT JOIN known k USING(origin,bucket)
 )
 SELECT c.origin,c.reason,c.calls FROM cells c
 WHERE c.calls > 0 AND privacy_window_safe_utc(from_utc,to_utc)
 AND NOT EXISTS (SELECT 1 FROM checks WHERE n < 0 OR (n > 0 AND n < 10))
 ORDER BY c.origin,c.reason
$$;
REVOKE ALL ON FUNCTION winrm_diagnostics_utc(timestamptz,timestamptz) FROM PUBLIC;

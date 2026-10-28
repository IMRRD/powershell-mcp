BEGIN;
ALTER TABLE telemetry_event ADD COLUMN IF NOT EXISTS user_key text;
ALTER TABLE telemetry_event DROP CONSTRAINT IF EXISTS telemetry_event_origin_check;
ALTER TABLE telemetry_event ADD CONSTRAINT telemetry_event_origin_check CHECK(origin IN ('internal','test','unknown_origin','external_self_declared','cohort_conflict'));
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

GRANT EXECUTE ON FUNCTION user_proxy_utc(timestamptz,timestamptz), privacy_window_safe_utc(timestamptz,timestamptz) TO telemetry_dashboard;
COMMIT;

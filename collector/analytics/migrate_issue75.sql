-- Apply as analytics owner after issue64, before upgrading the weekly consumer.
-- Add only the bounded aggregate; retain all rows, views and existing grants.
-- Repeatable after an uncertain response. Production activation is separate.
BEGIN;

-- Issue 75: actual event-version/tool joins; counts and metrics stay separate.
CREATE OR REPLACE FUNCTION tool_version_outcomes_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS TABLE(origin text, version_bucket text, stream text, tool text, axis text, bucket text, calls numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 WITH e AS (
 SELECT event_key,origin,version_bucket FROM telemetry_event
 WHERE to_utc > from_utc AND to_utc-from_utc <= interval '31 days'
 AND event_at >= from_utc AND event_at < to_utc
 ), cells AS (
 SELECT e.origin,e.version_bucket,t.stream,t.tool,'calls'::text AS axis,'total'::text AS bucket,sum(t.calls)::numeric AS calls
 FROM e JOIN telemetry_tool t USING(event_key)
 GROUP BY e.origin,e.version_bucket,t.stream,t.tool
 UNION ALL
 SELECT e.origin,e.version_bucket,'metrics',a.tool,'outcomes',a.bucket,sum(a.calls)::numeric
 FROM e JOIN telemetry_metric_axis a USING(event_key) WHERE a.axis='outcomes'
 GROUP BY e.origin,e.version_bucket,a.tool,a.bucket
 ), checks AS (
 SELECT c.calls AS n FROM cells c
 UNION ALL
 -- Versions and outcome buckets within one tool/stream/axis.
 SELECT sum(c.calls) OVER (PARTITION BY c.origin,c.stream,c.tool,c.axis)-c.calls FROM cells c
 UNION ALL
 -- Tools within each version/stream/axis/bucket.
 SELECT sum(c.calls) OVER (PARTITION BY c.origin,c.version_bucket,c.stream,c.axis,c.bucket)-c.calls FROM cells c
 UNION ALL
 -- Missing outcome instrumentation must not reveal a small complement.
 SELECT t.calls-coalesce((SELECT sum(a.calls) FROM cells a
   WHERE a.origin=t.origin AND a.version_bucket=t.version_bucket AND a.stream='metrics'
   AND a.tool=t.tool AND a.axis='outcomes'),0)
 FROM cells t WHERE t.stream='metrics' AND t.axis='calls'
 ), invalid AS (
 -- Finite outcomes only. Missing/partial coverage is preserved, never padded.
 SELECT 1 FROM cells c WHERE c.axis='outcomes' AND
 (c.bucket NOT IN ('success','nonzero','error','timeout','cancelled','unknown') OR NOT EXISTS (
   SELECT 1 FROM cells t WHERE t.origin=c.origin AND t.version_bucket=c.version_bucket
   AND t.stream='metrics' AND t.tool=c.tool AND t.axis='calls'))
 UNION ALL
 -- Validate per-event coverage too, rather than letting versions/tools cancel
 -- malformed totals. Absence or partial instrumentation is allowed explicitly.
 SELECT 1 FROM e JOIN telemetry_metric_axis a USING(event_key)
 LEFT JOIN telemetry_tool t ON t.event_key=a.event_key AND t.tool=a.tool AND t.stream='metrics'
 WHERE a.axis='outcomes' GROUP BY a.event_key,a.tool,t.calls
 HAVING t.calls IS NULL OR sum(a.calls)>t.calls
 )
 SELECT c.origin,c.version_bucket,c.stream,c.tool,c.axis,c.bucket,c.calls FROM cells c
 WHERE to_utc > from_utc AND to_utc-from_utc <= interval '31 days'
 AND privacy_window_safe_utc(from_utc,to_utc)
 AND NOT EXISTS (SELECT 1 FROM checks WHERE n < 0 OR (n > 0 AND n < 10))
 AND NOT EXISTS (SELECT 1 FROM invalid)
 ORDER BY c.origin,c.version_bucket,c.stream,c.tool,c.axis,c.bucket
$$;
REVOKE ALL ON FUNCTION tool_version_outcomes_utc(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tool_version_outcomes_utc(timestamptz,timestamptz) TO telemetry_dashboard;
COMMIT;

-- Apply as analytics owner before the new importer/client. Historical rows and
-- checkpoints remain untouched. Safe to repeat after an uncertain response.
BEGIN;
ALTER TABLE telemetry_metric_axis DROP CONSTRAINT IF EXISTS telemetry_metric_axis_axis_check;
ALTER TABLE telemetry_metric_axis ADD CONSTRAINT telemetry_metric_axis_axis_check
 CHECK(axis IN ('outcomes','durations','features','winrmReasons'));
-- Keep existing reports on their original three marginals. Diagnostics have a
-- dedicated restricted aggregate with explicit missing-instrumentation coverage.
CREATE OR REPLACE VIEW dashboard_metric_axes AS SELECT e.origin, e.event_at, a.tool, a.axis, a.bucket, a.calls FROM telemetry_metric_axis a JOIN telemetry_event e USING(event_key) WHERE a.axis <> 'winrmReasons';

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
GRANT EXECUTE ON FUNCTION winrm_diagnostics_utc(timestamptz,timestamptz) TO telemetry_dashboard;
COMMIT;

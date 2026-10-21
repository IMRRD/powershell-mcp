-- Bind :from_utc and :to_utc as TIMESTAMPTZ; enforce max 31-day range in caller.
-- Adoption: distinct observed installation proxies, not people.
SELECT * FROM adoption_utc(:from_utc, :to_utc);
-- Distinct events, separately from summed calls; legacy replays can inflate counts.
SELECT origin, event, count(*) AS delivered_events FROM dashboard_events
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, event;
SELECT origin, stream, tool, sum(calls) AS delivered_calls FROM dashboard_tools
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, stream, tool;
-- Versions and OS count events, not distinct installations; never label these people.
SELECT origin, version_bucket, os_bucket, count(*) AS delivered_events FROM dashboard_events
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, version_bucket, os_bucket;
-- Arrival lag and health must not substitute event time for collector receipt time.
SELECT origin, date_trunc('day', received_at) AS received_day, count(*) AS received_events,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (received_at-event_at))) AS p95_lag_seconds
FROM dashboard_events WHERE received_at >= :from_utc AND received_at < :to_utc
AND event_at IS NOT NULL GROUP BY origin, received_day;
-- Feed health is based on checkpoint existence, last actual receipt and importer run.
-- A checkpoint only proves the importer scanned a source; it cannot prove upstream delivery.
SELECT * FROM delivery_health_utc(:to_utc, :from_utc, interval '2 hours');
-- Axes are independent marginals; never sum across axes or add schema-1 counts to schema-2 metrics.
SELECT origin, tool, axis, bucket, sum(calls) AS calls FROM dashboard_metric_axes
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, tool, axis, bucket;
SELECT event_time_quality, receipt_time_quality, count(*) AS records FROM dashboard_events
GROUP BY event_time_quality, receipt_time_quality;

-- Bind UTC timestamptz parameters. Default suppression includes derivable complements.
-- Distinct installation/user proxies are not people. Counts/metrics and axes remain separate.
SELECT * FROM (SELECT * FROM adoption_utc(:from_utc, :to_utc)) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT * FROM user_proxy_utc(:from_utc, :to_utc)) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT origin, event, count(*) AS delivered_events FROM dashboard_events
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, event) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT origin, stream, tool, sum(calls) AS delivered_calls FROM dashboard_tools
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, stream, tool) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT origin, version_bucket, os_bucket, count(*) AS delivered_events FROM dashboard_events
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, version_bucket, os_bucket) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT origin, date_trunc('day', received_at) AS received_day, count(*) AS received_events,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (received_at-event_at))) AS p95_lag_seconds
FROM dashboard_events WHERE received_at >= :from_utc AND received_at < :to_utc
AND event_at IS NOT NULL GROUP BY origin, received_day) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT * FROM delivery_health_utc(:to_utc, :from_utc, interval '2 hours')) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT origin, tool, axis, bucket, sum(calls) AS calls FROM dashboard_metric_axes
WHERE event_at >= :from_utc AND event_at < :to_utc GROUP BY origin, tool, axis, bucket) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

SELECT * FROM (SELECT event_time_quality, receipt_time_quality, count(*) AS records FROM dashboard_events
GROUP BY event_time_quality, receipt_time_quality) privacy_query WHERE privacy_window_safe_utc(:from_utc, :to_utc);

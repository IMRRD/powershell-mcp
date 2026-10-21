CREATE TABLE telemetry_event (
 event_key text PRIMARY KEY,
 payload_hash text NOT NULL,
 origin text NOT NULL CHECK (origin IN ('internal','test','unknown_origin')),
 installation_key text,
 event text NOT NULL,
 event_at timestamptz,
 received_at timestamptz,
 version_bucket text NOT NULL,
 os_bucket text NOT NULL,
 raw jsonb NOT NULL
);
CREATE INDEX telemetry_event_window ON telemetry_event (event_at, origin);
CREATE INDEX telemetry_event_installation ON telemetry_event (origin, installation_key, event_at);
CREATE INDEX telemetry_event_arrival ON telemetry_event (received_at) WHERE received_at IS NOT NULL;
CREATE TABLE telemetry_tool (event_key text NOT NULL REFERENCES telemetry_event(event_key), stream text NOT NULL CHECK(stream IN ('counts','metrics')), tool text NOT NULL, calls bigint NOT NULL CHECK(calls > 0), PRIMARY KEY(event_key, stream, tool));
CREATE INDEX telemetry_tool_stream ON telemetry_tool (stream, tool);
CREATE TABLE telemetry_checkpoint (source_key text PRIMARY KEY, device bigint NOT NULL, inode bigint NOT NULL, position bigint NOT NULL, prefix_hash text NOT NULL);
CREATE OR REPLACE FUNCTION adoption_utc(from_utc timestamptz, to_utc timestamptz)
RETURNS TABLE(origin text, observed_installations bigint, active_installations bigint, startup_only_installations bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT x.origin, count(*), count(*) FILTER (WHERE x.active), count(*) FILTER (WHERE NOT x.active AND x.startup)
 FROM (SELECT e.origin, e.installation_key, bool_or(e.event IN ('tool_counts','tool_metrics')) AS active, bool_or(e.event='startup') AS startup
 FROM telemetry_event e WHERE e.event_at >= from_utc AND e.event_at < to_utc AND e.installation_key IS NOT NULL
 GROUP BY e.origin, e.installation_key) x GROUP BY x.origin
$$;
CREATE VIEW dashboard_events AS SELECT origin, event, event_at, received_at, version_bucket, os_bucket FROM telemetry_event;
CREATE VIEW dashboard_tools AS SELECT e.origin, e.event_at, t.stream, t.tool, t.calls FROM telemetry_tool t JOIN telemetry_event e USING(event_key);
-- Run role.sql as an operator after replacing the password placeholder via secret provisioning.

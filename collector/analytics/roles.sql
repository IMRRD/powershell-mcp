-- Execute in the dedicated private analytics database as its owner.
-- Provision telemetry_importer and telemetry_dashboard externally with separate secrets.
-- Do not grant either role raw collector volume access; restrict PostgreSQL networking.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO telemetry_importer, telemetry_dashboard;
GRANT SELECT, INSERT, UPDATE ON telemetry_event, telemetry_tool, telemetry_metric_axis, telemetry_checkpoint TO telemetry_importer;
GRANT SELECT ON dashboard_events, dashboard_tools, dashboard_metric_axes TO telemetry_dashboard;
GRANT EXECUTE ON FUNCTION adoption_utc(timestamptz,timestamptz) TO telemetry_dashboard;
GRANT EXECUTE ON FUNCTION delivery_health_utc(timestamptz,timestamptz,interval) TO telemetry_dashboard;
-- PostgreSQL views run as their owner; dashboard role cannot SELECT raw tables.
-- Analytics database must contain only this schema; manage other schemas separately.

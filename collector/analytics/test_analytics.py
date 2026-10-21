import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone

import psycopg

from import_jsonl import ingest

DSN = os.environ.get('ANALYTICS_TEST_DSN')
ROOT = pathlib.Path(__file__).parent


@unittest.skipUnless(DSN, 'ANALYTICS_TEST_DSN required for disposable PostgreSQL integration')
class AnalyticsTest(unittest.TestCase):
    def setUp(self):
        self.db = psycopg.connect(DSN, autocommit=True)
        self.schema = 'test_analytics_' + os.urandom(8).hex()
        self.db.execute(f'CREATE SCHEMA {self.schema}')
        self.db.execute(f'SET search_path TO {self.schema}')
        self.db.execute((ROOT / 'schema.sql').read_text().replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp'))
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(self.tearDownDb)
        self.source = pathlib.Path(self.dir.name) / 'events.jsonl'
        self.classes = pathlib.Path(self.dir.name) / 'classes.json'
        self.classes.write_text(json.dumps({'internalHostIds': ['internal'], 'testHostIds': ['test']}))

    def tearDownDb(self):
        self.db.execute(f'DROP SCHEMA {self.schema} CASCADE')
        self.db.close()

    def append(self, rows):
        with self.source.open('a') as f:
            for row in rows:
                f.write(json.dumps(row) + '\n')

    def test_restart_history_classification_and_aggregates(self):
        base = dict(event='startup', version='0.7.0', os='win32', ts='2026-01-01T00:00:00.000Z')
        self.append([dict(base, hostId='internal', _ip='private'), dict(base, hostId='unknown', eventId='11111111-1111-4111-8111-111111111111', schemaVersion=1), dict(base, hostId='test', event='tool_counts', counts={'ssh_exec': 3}), dict(base, hostId='unknown', event='tool_metrics', schemaVersion=2, eventId='22222222-2222-4222-8222-222222222222', metrics={'ssh_exec': {'outcomes': {'success': 2}, 'durations': {'lt100': 2}, 'features': {'remote': 2}}}, _receivedAt='2026-01-01T00:00:10.000Z'), dict(base, hostId='unknown', event='probe', _ip='private')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 5)
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_event').fetchone()[0], 5)
        self.assertEqual(self.db.execute("SELECT origin FROM telemetry_event WHERE event = 'historical_other'").fetchone()[0], 'unknown_origin')
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_event WHERE raw::text LIKE %s', ('%private%',)).fetchone()[0], 0)
        self.assertEqual(self.db.execute("SELECT sum(calls) FROM telemetry_tool WHERE stream = 'metrics'").fetchone()[0], 2)
        self.assertEqual(self.db.execute("SELECT sum(calls) FROM telemetry_tool WHERE stream = 'counts'").fetchone()[0], 3)
        self.assertEqual(self.db.execute("SELECT observed_installations, active_installations FROM adoption_utc('2026-01-01', '2026-01-02') WHERE origin='unknown_origin'").fetchone(), (1, 1))
        self.assertEqual(self.db.execute("SELECT count(*) FROM telemetry_event WHERE event_at < '2026-02-01'").fetchone()[0], 5)

    def test_incomplete_line_preserves_checkpoint_and_retry(self):
        self.append([dict(event='startup', hostId='one', version='0.7.0', os='linux', ts='2026-01-01T00:00:00.000Z')])
        with self.source.open('ab') as f:
            f.write(b'{"event":')
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        with self.source.open('ab') as f:
            f.write(b'"probe"}\n')
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_event').fetchone()[0], 2)

    def test_collision_and_rewrite_fail_closed(self):
        row = dict(event='startup', hostId='one', version='0.7.0', os='linux', ts='2026-01-01T00:00:00.000Z', eventId='11111111-1111-4111-8111-111111111111', schemaVersion=1)
        self.append([row])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.append([dict(row, hostId='two')])
        with self.assertRaises(ValueError):
            ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_event').fetchone()[0], 1)
        self.source.write_text('')
        with self.assertRaises(ValueError):
            ingest(self.db, self.source, self.classes)

    def test_dashboard_role_denies_raw_reads_and_writes(self):
        role = 'dashboard_' + os.urandom(8).hex()
        self.db.execute(f'CREATE ROLE {role}')
        try:
            self.db.execute(f'GRANT USAGE ON SCHEMA {self.schema} TO {role}')
            self.db.execute(f'GRANT SELECT ON {self.schema}.dashboard_events, {self.schema}.dashboard_tools TO {role}')
            self.db.execute(f'GRANT EXECUTE ON FUNCTION {self.schema}.adoption_utc(timestamptz,timestamptz) TO {role}')
            self.db.execute(f'SET ROLE {role}')
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.db.execute(f'SELECT * FROM {self.schema}.telemetry_event')
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                self.db.execute(f'INSERT INTO {self.schema}.telemetry_event(event_key) VALUES (\'x\')')
            self.assertEqual(self.db.execute(f'SELECT count(*) FROM {self.schema}.dashboard_events').fetchone()[0], 0)
            self.assertEqual(self.db.execute(f'SELECT count(*) FROM {self.schema}.adoption_utc(now() - interval \'1 day\', now())').fetchone()[0], 0)
        finally:
            self.db.execute('RESET ROLE')
            self.db.execute(f'DROP OWNED BY {role}')
            self.db.execute(f'DROP ROLE {role}')

    def test_restore_from_immutable_source_preserves_old_window(self):
        self.append([dict(event='startup', hostId='one', version='0.7.0', os='linux', ts='2020-01-01T00:00:00.000Z')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        restored = 'restore_' + os.urandom(8).hex()
        self.db.execute(f'CREATE SCHEMA {restored}')
        try:
            self.db.execute(f'SET search_path TO {restored}')
            self.db.execute((ROOT / 'schema.sql').read_text().replace('SET search_path = public, pg_temp', f'SET search_path = {restored}, pg_temp'))
            self.assertEqual(ingest(self.db, self.source, self.classes), 1)
            self.assertEqual(self.db.execute("SELECT count(*) FROM telemetry_event WHERE event_at < '2021-01-01'").fetchone()[0], 1)
        finally:
            self.db.execute(f'SET search_path TO {self.schema}')
            self.db.execute(f'DROP SCHEMA {restored} CASCADE')

    def test_metric_axes_are_preserved_without_triple_counting(self):
        self.append([dict(event='tool_metrics', ts='2026-01-01T00:00:00.000Z', metrics={'ssh_exec': {'outcomes': {'success': 2, 'error': 1}, 'durations': {'lt100': 1, 'lt1000': 2}, 'features': {'remote': 3}}})])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.assertEqual(self.db.execute("SELECT axis, bucket, calls FROM dashboard_metric_axes ORDER BY axis,bucket").fetchall(), [('durations', 'lt100', 1), ('durations', 'lt1000', 2), ('features', 'remote', 3), ('outcomes', 'error', 1), ('outcomes', 'success', 2)])
        self.assertEqual(self.db.execute('SELECT sum(calls) FROM dashboard_tools').fetchone()[0], 3)
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)

    def test_malformed_metric_axis_rolls_back_checkpoint(self):
        self.append([dict(event='tool_metrics', ts='2026-01-01T00:00:00.000Z', metrics={'ssh_exec': {'outcomes': {'success': 2}, 'durations': {'lt100': 1}, 'features': {'remote': 2}}})])
        with self.assertRaises(ValueError):
            ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_checkpoint').fetchone()[0], 0)
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_event').fetchone()[0], 0)

    def test_invalid_event_and_receipt_times_are_visible_quality(self):
        self.append([dict(event='startup', ts='not-a-time', _receivedAt='2026-02-30T00:00:00.000Z')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.assertEqual(self.db.execute('SELECT event_time_quality, receipt_time_quality FROM dashboard_events').fetchone(), ('invalid', 'invalid'))
        self.assertEqual(self.db.execute("SELECT event_time_quality, receipt_time_quality, count(*) FROM dashboard_events GROUP BY 1,2").fetchone(), ('invalid', 'invalid', 1))

    def test_delivery_health_empty_stale_and_partial(self):
        self.assertEqual(self.db.execute("SELECT status FROM delivery_health_utc('2026-01-02', '2026-01-01', interval '1 hour')").fetchone()[0], 'Unknown: no feed/checkpoint')
        self.append([dict(event='startup', ts='2026-01-01T00:00:00.000Z', _receivedAt='2026-01-01T00:00:01.000Z')])
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute("SELECT status FROM delivery_health_utc('2026-01-02', '2026-01-01', interval '1 hour')").fetchone()[0], 'Stale')
        self.append([dict(event='startup', ts='bad', _receivedAt='2026-01-02T00:00:00.000Z')])
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute("SELECT status FROM delivery_health_utc('2026-01-02', '2026-01-01', interval '1 hour')").fetchone()[0], 'Partial: invalid event time')

    def test_delivery_health_window_excludes_old_invalid_receipt_and_future_receipt(self):
        self.append([dict(event='startup', ts='bad', _receivedAt='bad')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.append([dict(event='startup', ts='2026-01-02T00:00:00Z', _receivedAt='2026-01-02T00:00:00Z')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        row = self.db.execute("SELECT status, last_receipt, invalid_event_times, invalid_receipt_times FROM delivery_health_utc('2026-01-02T00:30:00Z', '2026-01-01T00:00:00Z', interval '1 hour')").fetchone()
        self.assertEqual(row, ('Recent receipts (not end-to-end proof)', datetime(2026, 1, 2, tzinfo=timezone.utc), 0, 0))
        self.append([dict(event='startup', ts='2026-01-03T00:00:00Z', _receivedAt='2026-01-03T00:00:00Z')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        row = self.db.execute("SELECT status, last_receipt FROM delivery_health_utc('2026-01-02T00:30:00Z', '2026-01-01T00:00:00Z', interval '1 hour')").fetchone()
        self.assertEqual(row, ('Recent receipts (not end-to-end proof)', datetime(2026, 1, 2, tzinfo=timezone.utc)))
        row = self.db.execute("SELECT status, last_receipt FROM delivery_health_utc('2026-01-01T12:00:00Z', '2026-01-01T00:00:00Z', interval '1 hour')").fetchone()
        self.assertEqual(row, ('Unknown: no valid receipts', None))

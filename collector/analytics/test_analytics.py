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
        self.assertEqual(self.db.execute("SELECT origin FROM telemetry_event WHERE event = 'probe'").fetchone()[0], 'unknown_origin')
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

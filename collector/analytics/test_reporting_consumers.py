"""Synthetic importer -> restricted snapshot -> report/dashboard acceptance; never sends mail."""
import datetime as dt
import importlib.util
import json
import os
import unittest

import test_analytics as fixture
from import_jsonl import ingest
from test_privacy_review_regressions import expand, panels

spec = importlib.util.spec_from_file_location('reporting_digest', fixture.ROOT / 'operations/weekly_digest.py')
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)


@unittest.skipUnless(fixture.DSN, 'disposable PostgreSQL required')
class ReportingConsumers(unittest.TestCase):
    setUp = fixture.AnalyticsTest.setUp
    tearDownDb = fixture.AnalyticsTest.tearDownDb
    append = fixture.AnalyticsTest.append

    def seed(self, mode='safe'):
        now = dt.datetime.now(dt.timezone.utc)
        start, end = digest.closed_week(now)
        stamp = lambda t: t.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        base = dict(version='0.8.0', os='win32', ts=stamp(start), _receivedAt=stamp(start))
        rows = [dict(base, hostId='synthetic-0', event='startup', ts=stamp(start + dt.timedelta(hours=i)),
                     _receivedAt=stamp(start + dt.timedelta(hours=i))) for i in range(168)]
        size = 41 if mode == 'outcome_complement' else 30
        for i in range(size):
            metric = dict(outcomes={'error': 1}, durations={'lt100': 1}, features={'remote': 1})
            if mode == 'safe':
                if i < 20: metric['winrmReasons'] = {'invoke_exception' if i < 10 else 'unknown': 1}
            elif mode == 'missing_complement':
                if i < 29: metric['winrmReasons'] = {'invoke_exception': 1}
            elif mode == 'outcome_complement':
                metric['winrmReasons'] = {'invoke_exception' if i < 20 else 'unknown': 1}
                metric['outcomes'] = {'error' if i < 21 else 'success': 1}
            elif mode == 'small_reason':
                metric['winrmReasons'] = {'invoke_exception' if i < 29 else 'unknown': 1}
            rows.append(dict(base, hostId='synthetic-' + str(i), event='tool_metrics', schemaVersion=2,
                             metrics={'winrm_exec': metric}))
            if i < 10:
                rows.append(dict(base, hostId='synthetic-' + str(i), event='tool_counts', counts={'winrm_exec': 1}))
        self.append(rows)
        self.assertEqual(ingest(self.db, self.source, self.classes), len(rows))
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        return now, start, end

    def restricted(self):
        role = 'reporting_' + os.urandom(8).hex()
        self.db.execute('CREATE ROLE ' + role)
        self.db.execute(f'GRANT USAGE ON SCHEMA {self.schema} TO {role}')
        self.db.execute(f'GRANT SELECT ON dashboard_events,dashboard_tools,dashboard_metric_axes TO {role}')
        for sig in ('adoption_utc(timestamptz,timestamptz)', 'user_proxy_utc(timestamptz,timestamptz)',
                    'delivery_health_utc(timestamptz,timestamptz,interval)', 'privacy_window_safe_utc(timestamptz,timestamptz)',
                    'winrm_diagnostics_utc(timestamptz,timestamptz)'):
            self.db.execute(f'GRANT EXECUTE ON FUNCTION {sig} TO {role}')
        def cleanup():
            self.db.execute('RESET ROLE')
            self.db.execute('DROP OWNED BY ' + role)
            self.db.execute('DROP ROLE ' + role)
        self.addCleanup(cleanup)
        self.db.execute('SET ROLE ' + role)

    def reason_panels(self, start, end):
        found = 0
        for name in ('dashboard.json', 'overview-preview.json'):
            for panel in panels(json.loads((fixture.ROOT / name).read_text(encoding='utf8'))['panels']):
                if 'WinRM diagnostics' not in panel['title']: continue
                found += 1
                sql = expand(panel['targets'][0]['rawSql'], "'" + start.isoformat() + "'::timestamptz",
                             "'" + end.isoformat() + "'::timestamptz")
                yield self.db.execute(sql).fetchall()
        self.assertGreaterEqual(found, 2)

    def test_restricted_old_new_calls_reach_both_report_bodies_and_reason_panels(self):
        now, start, end = self.seed()
        self.restricted()
        with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege):
            self.db.execute('SELECT * FROM telemetry_event')
        with self.db.transaction():
            data = digest.aggregates(self.db, start, end)
        self.assertEqual(data['winrm_reasons'], [('unknown_origin', r, 10) for r in ('invoke_exception', 'uninstrumented', 'unknown')])
        for body in digest.report(data, start, end, dt.datetime.now(dt.timezone.utc)):
            for text in ('invoke_exception', 'uninstrumented', 'unknown', '20/30', '66.7%',
                         'Metric stream: 30 recorded calls', 'Legacy count stream: 10 recorded calls'):
                self.assertIn(text, body)
        for rows in self.reason_panels(start, end): self.assertEqual(rows, data['winrm_reasons'])

    def check_suppression(self, mode):
        now, start, end = self.seed(mode)
        self.restricted()
        with self.db.transaction(): data = digest.aggregates(self.db, start, end)
        self.assertEqual(data['winrm_reasons'], [])
        audience = dict(sender='fixture@example.invalid', recipient=digest.RECIPIENT, approved_recipients=[digest.RECIPIENT])
        for config in ({}, audience | {'private_small_counts': audience}):
            for body in digest.report(data, start, end, dt.datetime.now(dt.timezone.utc), config):
                self.assertIn('WinRM diagnostics unavailable or withheld', body)
                self.assertNotIn('invoke_exception', body)
                self.assertNotIn('Reason coverage:', body)
        for rows in self.reason_panels(start, end): self.assertEqual(rows, [])

    def test_small_reason_withheld_in_both_bodies_and_panels_for_both_audiences(self):
        self.check_suppression('small_reason')

    def test_uninstrumented_complement_withheld_for_both_audiences(self):
        self.check_suppression('missing_complement')

    def test_outcome_complement_withheld_for_both_audiences(self):
        self.check_suppression('outcome_complement')


if __name__ == '__main__': unittest.main()

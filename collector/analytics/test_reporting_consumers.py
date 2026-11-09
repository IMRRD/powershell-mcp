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

    def seed_trends(self):
        now = dt.datetime.now(dt.timezone.utc)
        start, end = digest.closed_week(now)
        stamp = lambda t: t.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        rows = []
        for at, success, timeout in ((start-dt.timedelta(days=7), 7, 1), (start, 16, 2)):
            base = dict(version='0.8.0', os='win32', ts=stamp(at), _receivedAt=stamp(at))
            rows.extend(dict(base, hostId='synthetic-0', event='startup', ts=stamp(at+dt.timedelta(hours=i)),
                             _receivedAt=stamp(at+dt.timedelta(hours=i))) for i in range(168))
            for i in range(20):
                rows.append(dict(base, hostId=f'synthetic-{i}', event='tool_metrics', schemaVersion=2,
                                 metrics={'ssh_exec': {'outcomes': {'success':success,'error':2,'timeout':timeout},
                                     'durations': {'lt100':success+2+timeout}, 'features': {'remote':success+2+timeout}}}))
                rows.append(dict(base, hostId=f'synthetic-{i}', version='0.7.9', event='tool_counts', counts={'ssh_exec':50}))
        self.append(rows)
        self.assertEqual(ingest(self.db, self.source, self.classes), 416)
        return dt.datetime.now(dt.timezone.utc), start, end

    def test_completed_week_trends_and_late_arrivals_use_one_real_restricted_snapshot(self):
        now, start, end = self.seed_trends()
        self.restricted()
        reader = self.db
        # A second owned connection imports a late prior-week batch *after* the
        # first aggregate has acquired its MVCC snapshot, before prior queries.
        with fixture.psycopg.connect(fixture.DSN, autocommit=True,
                                    options=f'-c search_path={self.schema} -c timezone=UTC') as writer:
            owner = self
            class InterleavedCursor:
                def __enter__(self):
                    self.cur = reader.cursor()
                    return self
                def __exit__(self, *args): self.cur.close()
                def execute(self, sql, params=None):
                    self.cur.execute(sql, params)
                    if sql.startswith('SELECT origin, observed_installations'):
                        stamp = lambda t: t.strftime('%Y-%m-%dT%H:%M:%S.000Z')
                        owner.append([dict(hostId='synthetic-0', version='0.8.0', os='win32', event='tool_metrics',
                            schemaVersion=2, ts=stamp(start-dt.timedelta(days=7)), _receivedAt=stamp(now),
                            metrics={'ssh_exec': {'outcomes': {'success':160,'error':20,'timeout':20},
                                'durations': {'lt100':200}, 'features': {'remote':200}}})])
                        owner.assertEqual(ingest(writer, owner.source, owner.classes), 1)
                def fetchall(self): return self.cur.fetchall()
                def fetchone(self): return self.cur.fetchone()
            class InterleavedConnection:
                def cursor(self): return InterleavedCursor()
            with reader.transaction():
                data = digest.aggregates(InterleavedConnection(), start, end)
                self.assertEqual(reader.execute('SHOW transaction_isolation').fetchone()[0], 'repeatable read')
                self.assertEqual(reader.execute('SHOW transaction_read_only').fetchone()[0], 'on')
                self.assertEqual(reader.execute('SHOW timezone').fetchone()[0], 'UTC')
            self.assertIn(('unknown_origin','metrics','ssh_exec',200), data.get('previous', {}).get('tools', []))
            self.assertIn(('unknown_origin','0.8.0','tool_metrics',20), data['previous']['cohorts'])
            for body in digest.report(data, start, end, now):
                self.assertIn('40/200 (20.0%)', body)
                self.assertIn('40/400 (10.0%)', body)
                self.assertIn('-10.0 pp', body)
                self.assertIn('late arrivals', body)
            with reader.transaction(): fresh = digest.aggregates(reader, start, end)
            self.assertIn(('unknown_origin','metrics','ssh_exec',400), fresh['previous']['tools'])
            for body in digest.report(fresh, start, end, dt.datetime.now(dt.timezone.utc)):
                self.assertIn('cross-window complementary disclosure risk', body)
                self.assertNotIn('40/200', body)
                self.assertNotIn('<table', body)
        with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege):
            reader.execute('SELECT * FROM telemetry_event')
        with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege):
            reader.execute("INSERT INTO telemetry_event(event_key) VALUES ('forbidden')")

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

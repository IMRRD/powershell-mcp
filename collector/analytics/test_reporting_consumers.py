"""Synthetic importer -> restricted snapshot -> report/dashboard acceptance; never sends mail."""
import datetime as dt
from email import policy
from email.parser import BytesParser
import importlib.util
import json
import os
from pathlib import Path
import tempfile
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

    def seed_composite_trends(self, current):
        start, end = digest.closed_week(dt.datetime.now(dt.timezone.utc))
        stamp = lambda at: at.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        rows = []
        previous = dict(success=100, nonzero=20, error=40, timeout=40)
        for at, outcomes in ((start-dt.timedelta(days=7), previous), (start, current)):
            base = dict(version='0.8.0', os='win32', ts=stamp(at), _receivedAt=stamp(at))
            rows.extend(dict(base, hostId='composite-0', event='startup',
                             ts=stamp(at+dt.timedelta(hours=i)), _receivedAt=stamp(at+dt.timedelta(hours=i)))
                        for i in range(168))
            for i in range(20):
                # Split each aggregate across 20 real schema-v2 metric batches.
                cells = {b:n//20 + (i < n%20) for b,n in outcomes.items()}
                total = sum(cells.values())
                rows.append(dict(base, hostId=f'composite-{i}', event='tool_metrics', schemaVersion=2,
                                 metrics={'ssh_exec': dict(outcomes=cells, durations={'lt100':total},
                                                          features={'remote':total})}))
        self.append(rows)
        self.assertEqual(ingest(self.db, self.source, self.classes), 376)
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        self.restricted()
        with self.db.transaction():
            data = digest.aggregates(self.db, start, end)
            self.assertEqual(self.db.execute('SHOW transaction_read_only').fetchone()[0], 'on')
            self.assertEqual(self.db.execute('SHOW transaction_isolation').fetchone()[0], 'repeatable read')
        self.assertEqual(data['previous']['tools'], [('unknown_origin','metrics','ssh_exec',200)])
        self.assertEqual(data['tools'], [('unknown_origin','metrics','ssh_exec',sum(current.values()))])
        self.assertEqual(data['adoption'], [('unknown_origin',20,20,0)])
        for period, expected in ((data['previous'], previous), (data, current)):
            self.assertEqual({b:int(n) for o,t,a,b,n in period['axes'] if a == 'outcomes'}, expected)
            self.assertEqual([r for r in period['cohorts'] if r[2] == 'tool_metrics'],
                             [('unknown_origin','0.8.0','tool_metrics',20)])
        for a,b in ((start-dt.timedelta(days=7),start), (start,end)):
            self.assertEqual(self.db.execute('SELECT privacy_window_safe_utc(%s,%s)',(a,b)).fetchone(), (True,))
        with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege):
            self.db.execute('SELECT * FROM telemetry_event')
        return data, start, end

    def composite_mime_bodies(self, private, connect=None):
        audience = dict(sender='composite@example.invalid', recipient=digest.RECIPIENT,
                        approved_recipients=[digest.RECIPIENT])
        config = dict(enabled=True, host='mail.ialogics.co.uk', port=587, username='synthetic', **audience)
        if private: config['private_small_counts'] = audience.copy()
        # Run the production sender's real aggregate queries as the restricted
        # role, then serialize to a memory sink. No SMTP connection is made.
        class Reader:
            def __enter__(inner):
                inner.tx = self.db.transaction()
                inner.tx.__enter__()
                return self.db
            def __exit__(inner, *args): return inner.tx.__exit__(*args)
        messages = []
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'config.json'
            path.write_text(json.dumps(config), encoding='utf8')
            digest.main(['--config',str(path),'--state-dir',str(Path(tmp)/'state')],
                        dt.datetime.now(dt.timezone.utc), connect or Reader,
                        lambda m,*args: messages.append(m.as_bytes()))
        self.assertEqual(len(messages), 1)
        message = BytesParser(policy=policy.default).parsebytes(messages[0])
        self.assertEqual(message.get_content_type(), 'multipart/alternative')
        parts = list(message.iter_parts())
        self.assertEqual([p.get_content_type() for p in parts], ['text/plain','text/html'])
        return [(p.get_content_type(),p.get_content()) for p in parts]

    def joint_partition_bodies(self, second_error, private):
        roles = ['reporting_importer_' + os.urandom(8).hex(),
                 'reporting_reader_' + os.urandom(8).hex()]
        importer, reader = roles
        passwords = {role: os.urandom(16).hex() for role in roles}
        for role in roles:
            self.db.execute(fixture.psycopg.sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(
                fixture.psycopg.sql.Identifier(role), fixture.psycopg.sql.Literal(passwords[role])))
            self.db.execute(f'GRANT USAGE ON SCHEMA {self.schema} TO {role}')
        def cleanup():
            for role in reversed(roles):
                self.db.execute(f'DROP OWNED BY {role}')
                self.db.execute(f'DROP ROLE {role}')
        self.addCleanup(cleanup)
        self.db.execute(f'GRANT SELECT,INSERT,UPDATE ON telemetry_event,telemetry_tool,telemetry_metric_axis,telemetry_checkpoint TO {importer}')
        self.db.execute(f'GRANT SELECT ON dashboard_events,dashboard_tools,dashboard_metric_axes TO {reader}')
        for sig in ('adoption_utc(timestamptz,timestamptz)', 'user_proxy_utc(timestamptz,timestamptz)',
                    'delivery_health_utc(timestamptz,timestamptz,interval)',
                    'privacy_window_safe_utc(timestamptz,timestamptz)',
                    'winrm_diagnostics_utc(timestamptz,timestamptz)'):
            self.db.execute(f'GRANT EXECUTE ON FUNCTION {sig} TO {reader}')
        def connect(role, autocommit=True):
            return fixture.psycopg.connect(fixture.DSN, user=role, password=passwords[role], autocommit=autocommit,
                                          options=f'-c search_path={self.schema} -c timezone=UTC')
        start, end = digest.closed_week(dt.datetime.now(dt.timezone.utc))
        stamp = lambda at: at.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        rows = []
        for at, errors in ((start-dt.timedelta(days=7), (100,20)), (start, (79,second_error))):
            base = dict(version='0.8.0', os='win32', ts=stamp(at), _receivedAt=stamp(at))
            rows.extend(dict(base, hostId='joint-0', event='startup',
                             ts=stamp(at+dt.timedelta(hours=i)), _receivedAt=stamp(at+dt.timedelta(hours=i)))
                        for i in range(168))
            for i in range(20):
                metrics = {}
                for tool, n in zip(('ssh_exec','sftp_upload'), errors):
                    error = n//20 + (i < n%20)
                    metrics[tool] = dict(outcomes=dict(error=error, success=50-error),
                                         durations=dict(lt100=50), features=dict(remote=50))
                rows.append(dict(base, hostId=f'joint-{i}', event='tool_metrics', schemaVersion=2, metrics=metrics))
        self.append(rows)
        with connect(importer) as db:
            self.assertEqual(db.execute('SELECT current_user=session_user,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user').fetchone(),
                             (True,False,False,False))
            with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege):
                db.execute('CREATE TABLE denied(i int)')
            self.assertEqual(ingest(db, self.source, self.classes), 376)
            self.assertEqual(ingest(db, self.source, self.classes), 0)
        with connect(reader) as db:
            self.assertEqual(db.execute('SELECT current_user=session_user,rolsuper FROM pg_roles WHERE rolname=current_user').fetchone(), (True,False))
            for sql in ('SELECT * FROM telemetry_event', "INSERT INTO telemetry_event(event_key) VALUES ('denied')"):
                with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege): db.execute(sql)
            for a,b in ((start-dt.timedelta(days=7),start), (start,end)):
                self.assertEqual(db.execute('SELECT privacy_window_safe_utc(%s,%s)', (a,b)).fetchone(), (True,))
            with db.transaction():
                data = digest.aggregates(db, start, end)
                self.assertEqual(db.execute('SHOW transaction_read_only').fetchone(), ('on',))
                self.assertEqual(db.execute('SHOW transaction_isolation').fetchone(), ('repeatable read',))
        for period, errors in ((data['previous'], (100,20)), (data, (79,second_error))):
            self.assertEqual(sorted(period['tools']), [('unknown_origin','metrics',t,1000) for t in ('sftp_upload','ssh_exec')])
            self.assertEqual([r for r in period['cohorts'] if r[2] == 'tool_metrics'], [('unknown_origin','0.8.0','tool_metrics',20)])
            self.assertEqual({t:int(n) for o,t,a,b,n in period['axes'] if a == 'outcomes' and b == 'error'},
                             dict(zip(('ssh_exec','sftp_upload'), errors)))
        self.assertEqual(data['adoption'], [('unknown_origin',20,20,0)])
        # The local partitions are safe; their joint same-axis union is the gap.
        for tool in ('ssh_exec','sftp_upload'):
            cells = [{b:int(n) for o,t,a,b,n in p['axes'] if t == tool and a == 'outcomes'} for p in (data['previous'],data)]
            self.assertTrue(all(n >= 10 for c in cells for n in c.values()))
            self.assertTrue(all(abs(cells[1][b]-cells[0][b]) >= 10 for b in cells[0]))
            self.assertFalse(digest.small_composite_change(*cells))
        self.assertEqual((79+second_error)-(100+20), second_error-41)
        return self.composite_mime_bodies(private, lambda: connect(reader, False))

    def test_joint_tool_outcomes_restricted_importer_mime_suppression(self):
        for mime, body in self.joint_partition_bodies(42, False):
            with self.subTest(mime=mime):
                self.assertIn('Comparison and numeric details withheld', body)
                for forbidden in ('ssh_exec','sftp_upload','100/1000','79/1000','42/1000',
                                  '<table','Largest error','Outcome instrumentation coverage','recorded calls'):
                    self.assertNotIn(forbidden, body)

    def test_joint_tool_outcomes_private_restricted_importer_mime_suppression(self):
        for mime, body in self.joint_partition_bodies(42, True):
            with self.subTest(mime=mime):
                self.assertIn('Comparison and numeric details withheld', body)
                for forbidden in ('ssh_exec','sftp_upload','<table','Largest error','Outcome instrumentation coverage'):
                    self.assertNotIn(forbidden, body)

    def test_joint_tool_outcomes_zero_restricted_importer_mime_control(self):
        for mime, body in self.joint_partition_bodies(41, False):
            with self.subTest(mime=mime):
                for value in ('100/1000 (10.0%)','20/1000 (2.0%)','79/1000 (7.9%)','41/1000 (4.1%)',
                              'Error and timeout comparison','Reliability: metric stream only'):
                    self.assertIn(value, body)
                self.assertNotIn('Comparison and numeric details withheld', body)

    def test_joint_tool_outcomes_ten_private_restricted_importer_mime_control(self):
        for mime, body in self.joint_partition_bodies(51, True):
            with self.subTest(mime=mime):
                for value in ('100/1000 (10.0%)','20/1000 (2.0%)','79/1000 (7.9%)','51/1000 (5.1%)',
                              'Error and timeout comparison','Reliability: metric stream only'):
                    self.assertIn(value, body)
                self.assertNotIn('Comparison and numeric details withheld', body)

    def test_composite_outcome_remainder_restricted_importer_mime_suppression(self):
        current = dict(success=79, nonzero=42, error=140, timeout=139)
        data, start, end = self.seed_composite_trends(current)
        old = {b:int(n) for o,t,a,b,n in data['previous']['axes'] if a == 'outcomes'}
        self.assertTrue(all(n >= 10 for n in [*old.values(), *current.values()]))
        self.assertTrue(all(abs(current[b]-old[b]) >= 10 for b in old))
        self.assertTrue(all(abs((400-current[b])-(200-old[b])) >= 10 for b in old))
        self.assertEqual((200-old['error']-old['timeout'],400-current['error']-current['timeout']), (120,121))
        for private in (False, True):
            for mime,body in self.composite_mime_bodies(private):
                with self.subTest(private=private, mime=mime):
                    self.assertIn('Comparison and numeric details withheld', body)
                    for forbidden in ('40/200','140/400','139/400','ssh_exec','<table',
                                      'Largest error','Outcome instrumentation coverage'):
                        self.assertNotIn(forbidden, body)

    def test_composite_outcome_above_threshold_restricted_importer_mime_control(self):
        self.seed_composite_trends(dict(success=88, nonzero=42, error=131, timeout=139))
        # The other-outcome remainder changes from 120 to 130: ten is allowed.
        for private in (False, True):
            for mime,body in self.composite_mime_bodies(private):
                with self.subTest(private=private, mime=mime):
                    self.assertIn('Error and timeout comparison', body)
                    for value in ('40/200 (20.0%)','131/400','139/400','Reliability: metric stream only'):
                        self.assertIn(value, body)
                    self.assertNotIn('Comparison and numeric details withheld', body)

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
        # Configure the reporting session even when the server defaults to Etc/UTC.
        self.db.execute("SET timezone = 'UTC'")
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

"""Real importer -> restricted joint cohorts -> completed-week MIME consumers."""
import datetime as dt
from email import policy
from email.parser import BytesParser
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

import test_analytics as fixture
from import_jsonl import ingest
from test_reporting_consumers import digest


@unittest.skipUnless(fixture.DSN, 'disposable PostgreSQL required')
class ToolVersionOutcomes(unittest.TestCase):
    setUp = fixture.AnalyticsTest.setUp
    tearDownDb = fixture.AnalyticsTest.tearDownDb
    append = fixture.AnalyticsTest.append

    def logins(self):
        roles = ['mixed_importer_' + os.urandom(8).hex(), 'mixed_reader_' + os.urandom(8).hex()]
        passwords = {r: os.urandom(16).hex() for r in roles}
        for role in roles:
            self.db.execute(fixture.psycopg.sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(
                fixture.psycopg.sql.Identifier(role), fixture.psycopg.sql.Literal(passwords[role])))
            self.db.execute(f'GRANT USAGE ON SCHEMA {self.schema} TO {role}')
        def cleanup():
            for role in reversed(roles):
                self.db.execute(f'DROP OWNED BY {role}')
                self.db.execute(f'DROP ROLE {role}')
        self.addCleanup(cleanup)
        self.db.execute(f'GRANT SELECT,INSERT,UPDATE ON telemetry_event,telemetry_tool,telemetry_metric_axis,telemetry_checkpoint TO {roles[0]}')
        self.db.execute(f'GRANT SELECT ON dashboard_events,dashboard_tools,dashboard_metric_axes TO {roles[1]}')
        for sig in ('adoption_utc(timestamptz,timestamptz)', 'user_proxy_utc(timestamptz,timestamptz)',
                    'delivery_health_utc(timestamptz,timestamptz,interval)', 'privacy_window_safe_utc(timestamptz,timestamptz)',
                    'winrm_diagnostics_utc(timestamptz,timestamptz)', 'tool_version_outcomes_utc(timestamptz,timestamptz)'):
            self.db.execute(f'GRANT EXECUTE ON FUNCTION {sig} TO {roles[1]}')
        def connect(index=1, autocommit=False):
            return fixture.psycopg.connect(fixture.DSN, user=roles[index], password=passwords[roles[index]],
                                          autocommit=autocommit, options=f'-c search_path={self.schema}')
        for index in (0, 1):
            with connect(index, True) as db:
                self.assertEqual(db.execute('SELECT current_user=session_user,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user').fetchone(), (True,False,False,False))
                self.assertEqual(db.execute('SHOW timezone').fetchone(), ('Etc/UTC',))
                for password in ('', 'wrong-synthetic-password'):
                    with self.assertRaises(fixture.psycopg.OperationalError):
                        fixture.psycopg.connect(fixture.DSN, user=roles[index], password=password,
                                               passfile=str(Path(self.dir.name)/'absent.pgpass'), connect_timeout=3)
        with connect(0, True) as db:
            with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege): db.execute('CREATE TABLE denied(i int)')
            self.assertEqual(ingest(db, self.source, self.classes), self.row_count)
            self.assertEqual(ingest(db, self.source, self.classes), 0)
        with connect(1, True) as db:
            for table in ('telemetry_event','telemetry_tool','telemetry_metric_axis','telemetry_checkpoint'):
                with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege): db.execute(f'SELECT * FROM {table}')
            with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege): db.execute("INSERT INTO telemetry_event(event_key) VALUES ('denied')")
        return connect

    def seed(self, composite=False, change=1):
        self.start, self.end = digest.closed_week(dt.datetime.now(dt.timezone.utc))
        stamp = lambda at: at.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        rows = []
        for week, at in enumerate((self.start-dt.timedelta(days=7), self.start)):
            base = dict(version='0.8.0', os='win32', ts=stamp(at), _receivedAt=stamp(at))
            rows.extend(dict(base, hostId='mixed-0', event='startup', ts=stamp(at+dt.timedelta(hours=i)),
                             _receivedAt=stamp(at+dt.timedelta(hours=i))) for i in range(168))
            for version_index, version in enumerate(('0.8.0','0.8.1')):
                if composite:
                    errors = ((100,20),(200,300)) if week == 0 else ((79,41+change),(221,279-change))
                    cells = {t: dict(error=n, success=1000-n) for t,n in zip(('ssh_exec','sftp_upload'), errors[version_index])}
                else:
                    total = 1000 if week == version_index else 2000
                    error = 100 if total == 1000 else 400
                    cells = {'ssh_exec': dict(error=error, timeout=total//50, success=total-error-total//50)}
                for i in range(20):
                    metrics = {}
                    for tool, outcomes in cells.items():
                        buckets = {b:n//20+(i<n%20) for b,n in outcomes.items()}
                        total = sum(buckets.values())
                        metrics[tool] = dict(outcomes=buckets, durations={'lt100':total}, features={'remote':total})
                    rows.append(dict(base, version=version, hostId=f'mixed-{i}', event='tool_metrics', schemaVersion=2, metrics=metrics))
            for i in range(20):
                rows.append(dict(base, version='0.7.9', hostId=f'mixed-{i}', event='tool_counts', counts={'ssh_exec':25+week*10}))
        self.row_count = len(rows)
        self.append(rows)
        return self.logins()

    def snapshot(self, connect):
        with connect() as db:
            data = digest.aggregates(db, self.start, self.end)
            self.assertEqual(db.execute('SHOW transaction_read_only').fetchone(), ('on',))
            self.assertEqual(db.execute('SHOW transaction_isolation').fetchone(), ('repeatable read',))
        return data

    def bodies(self, connect, private):
        audience = dict(sender='mixed@example.invalid', recipient=digest.RECIPIENT, approved_recipients=[digest.RECIPIENT])
        config = dict(enabled=True, host='mail.ialogics.co.uk', port=587, username='synthetic', **audience)
        if private: config['private_small_counts'] = audience.copy()
        messages = []
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp)/'config.json'
            config_path.write_text(json.dumps(config), encoding='utf8')
            digest.main(['--config',str(config_path),'--state-dir',str(Path(tmp)/'state')],
                        dt.datetime.now(dt.timezone.utc), connect, lambda m,*args: messages.append(m.as_bytes()))
        message = BytesParser(policy=policy.default).parsebytes(messages[0])
        self.assertEqual(message.get_content_type(), 'multipart/alternative')
        parts = list(message.iter_parts())
        self.assertEqual([p.get_content_type() for p in parts], ['text/plain','text/html'])
        return [p.get_content() for p in parts]

    def test_actual_version_joins_and_both_mime_audiences(self):
        connect = self.seed()
        data = self.snapshot(connect)
        for period, totals in ((data['previous'],(1000,2000)), (data,(2000,1000))):
            cells = period['version_outcomes']
            self.assertEqual({v:int(n) for o,v,s,t,a,b,n in cells if (s,t,a)==('metrics','ssh_exec','calls')}, dict(zip(('0.8.0','0.8.1'),totals)))
            self.assertEqual({v:int(n) for o,v,s,t,a,b,n in cells if (s,t,a,b)==('metrics','ssh_exec','outcomes','error')},
                             {v:100 if n==1000 else 400 for v,n in zip(('0.8.0','0.8.1'),totals)})
            self.assertEqual(len([r for r in cells if r[4]=='calls']),3)
        for private in (False,True):
            for body in self.bodies(connect, private):
                for value in ('100/1000 (10.0%)','400/2000 (20.0%)','+10.0 pp','-10.0 pp',
                              '0.8.1','0.7.9','500','700','same event-version/tool join','Outcome instrumentation coverage'):
                    self.assertIn(value,body)
                self.assertNotIn('version mix or version changed',body)
                self.assertNotIn('3500 recorded calls',body)

    def test_partial_missing_and_observed_zero_outcomes_have_explicit_denominators(self):
        connect = self.seed()
        # Represent historical partial instrumentation, without altering the importer contract.
        original = self.db.execute("SELECT * FROM telemetry_metric_axis WHERE axis='outcomes'").fetchall()
        for mode in ('partial','missing','zero'):
            with self.subTest(mode=mode):
                self.db.execute("DELETE FROM telemetry_metric_axis WHERE axis='outcomes'")
                with self.db.cursor() as cur:
                    cur.executemany('INSERT INTO telemetry_metric_axis VALUES (%s,%s,%s,%s,%s)',original)
                if mode in ('partial','missing'):
                    suffix = " AND a.event_key IN (SELECT event_key FROM telemetry_event WHERE version_bucket='0.8.0' AND event='tool_metrics' AND event_at=%s ORDER BY event_key LIMIT 10)" if mode=='partial' else ''
                    at = self.start-dt.timedelta(days=7)
                    self.db.execute("DELETE FROM telemetry_metric_axis a USING telemetry_event e WHERE a.event_key=e.event_key AND e.event_at=%s AND e.version_bucket='0.8.0' AND a.axis='outcomes'"+suffix, (at,at) if mode=='partial' else (at,))
                else:
                    # Change all recorded outcomes in that cohort to observed success.
                    self.db.execute("DELETE FROM telemetry_metric_axis a USING telemetry_event e WHERE a.event_key=e.event_key AND e.event_at=%s AND e.version_bucket='0.8.0' AND a.axis='outcomes'", (self.start-dt.timedelta(days=7),))
                    self.db.execute("INSERT INTO telemetry_metric_axis SELECT t.event_key,t.tool,'outcomes','success',t.calls FROM telemetry_tool t JOIN telemetry_event e USING(event_key) WHERE e.event_at=%s AND e.version_bucket='0.8.0' AND t.stream='metrics'", (self.start-dt.timedelta(days=7),))
                data = self.snapshot(connect)
                rates=digest.completed_week_trends(data,self.start,self.end,dt.datetime.now(dt.timezone.utc))['rates']
                if mode!='zero': self.assertFalse(any(r[2]=='0.8.0' for r in rates))
                for body in [body for private in (False,True) for body in self.bodies(connect,private)]:
                    if mode=='zero': self.assertIn('0/1000 (0.0%)',body)
                    else:
                        self.assertIn('partial or missing outcome instrumentation',body)
                        self.assertIn(('500/1000' if mode=='partial' else '0/1000')+' previous',body)
                    self.assertIn('400/2000 (20.0%)',body)  # Independent complete version remains usable.

    def test_composite_changes_across_versions_and_tools_suppress_both_audiences(self):
        connect = self.seed(composite=True,change=1)
        data = self.snapshot(connect)
        self.assertEqual(data['axes'],data['previous']['axes'])  # Old marginal guard cannot detect this join.
        for private in (False,True):
            for body in self.bodies(connect,private):
                self.assertIn('Comparison and numeric details withheld',body)
                for forbidden in ('ssh_exec','sftp_upload','<table','Largest error','Outcome instrumentation coverage','recorded calls'):
                    self.assertNotIn(forbidden,body)

    def test_composite_zero_control_remains_useful(self):
        connect = self.seed(composite=True,change=0)
        for private in (False,True):
            for body in self.bodies(connect,private):
                for value in ('100/1000 (10.0%)','79/1000 (7.9%)','41/1000 (4.1%)'):
                    self.assertIn(value,body)
                self.assertNotIn('Comparison and numeric details withheld',body)

    def test_composite_nine_suppresses_both_audiences(self):
        connect = self.seed(composite=True,change=9)
        for private in (False,True):
            for body in self.bodies(connect,private):
                self.assertIn('Comparison and numeric details withheld',body)
                self.assertNotIn('<table',body)

    def test_composite_ten_control_remains_useful(self):
        connect = self.seed(composite=True,change=10)
        for private in (False,True):
            for body in self.bodies(connect,private):
                self.assertIn('51/1000 (5.1%)',body)
                self.assertIn('Error and timeout comparison',body)
                self.assertNotIn('Comparison and numeric details withheld',body)

    def test_sql_finer_small_cell_and_permission_refusals(self):
        connect = self.seed()
        with connect(0,True) as db:
            with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege):
                db.execute('SELECT * FROM tool_version_outcomes_utc(%s,%s)',(self.start,self.end))
        # A version-specific error cell of one is hidden inside the safe coarse
        # error marginal of 401. Keep every per-event total complete.
        at = self.start-dt.timedelta(days=7)
        self.db.execute("UPDATE telemetry_metric_axis a SET calls=a.calls+x.calls FROM telemetry_metric_axis x,telemetry_event e WHERE a.event_key=e.event_key AND x.event_key=a.event_key AND x.tool=a.tool AND e.event_at=%s AND e.version_bucket='0.8.0' AND a.axis='outcomes' AND a.bucket='success' AND x.axis='outcomes' AND x.bucket='error'",(at,))
        self.db.execute("DELETE FROM telemetry_metric_axis a USING telemetry_event e WHERE a.event_key=e.event_key AND e.event_at=%s AND e.version_bucket='0.8.0' AND a.axis='outcomes' AND a.bucket='error'",(at,))
        event_key=self.db.execute("SELECT min(event_key) FROM telemetry_event WHERE event_at=%s AND version_bucket='0.8.0' AND event='tool_metrics'",(at,)).fetchone()[0]
        self.db.execute("UPDATE telemetry_metric_axis SET calls=calls-1 WHERE event_key=%s AND axis='outcomes' AND bucket='success'",(event_key,))
        self.db.execute("INSERT INTO telemetry_metric_axis VALUES (%s,'ssh_exec','outcomes','error',1)",(event_key,))
        self.assertEqual(self.db.execute('SELECT privacy_window_safe_utc(%s,%s)',(at,self.start)).fetchone(),(True,))
        with connect(1,True) as db:
            self.assertEqual(db.execute('SELECT * FROM tool_version_outcomes_utc(%s,%s)',(at,self.start)).fetchall(),[])
        for private in (False,True):
            for body in self.bodies(connect,private):
                self.assertIn('joint version/tool/outcome aggregate unavailable or withheld',body)
                self.assertNotIn('Error and timeout comparison',body)

    def test_sql_validates_event_totals_before_aggregation(self):
        self.seed()
        at=self.start-dt.timedelta(days=7)
        keys=self.db.execute("SELECT event_key FROM telemetry_event WHERE event_at=%s AND version_bucket='0.8.0' AND event='tool_metrics' ORDER BY event_key LIMIT 2",(at,)).fetchall()
        self.assertTrue(self.db.execute('SELECT * FROM tool_version_outcomes_utc(%s,%s)',(at,self.start)).fetchall())
        for (key,),delta in zip(keys,(10,-10)):
            self.db.execute("UPDATE telemetry_metric_axis SET calls=calls+%s WHERE event_key=%s AND axis='outcomes' AND bucket='success'",(delta,key))
        # Per-version sums stay complete, but one event covers 60 outcomes for
        # 50 calls; an under-covered sibling event cannot cancel that error.
        self.assertEqual(self.db.execute('SELECT privacy_window_safe_utc(%s,%s)',(at,self.start)).fetchone(),(True,))
        self.assertEqual(self.db.execute('SELECT * FROM tool_version_outcomes_utc(%s,%s)',(at,self.start)).fetchall(),[])

    def test_sql_window_security_and_whole_result_complement_suppression(self):
        connect = self.seed()
        with connect(1,True) as db:
            for a,b in ((self.start,self.start),(self.end,self.start),(self.start,self.start+dt.timedelta(days=32)),(None,self.end)):
                self.assertEqual(db.execute('SELECT * FROM tool_version_outcomes_utc(%s,%s)',(a,b)).fetchall(),[])
        flags = self.db.execute("SELECT provolatile,prosecdef,proconfig,EXISTS(SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') FROM pg_proc WHERE oid='tool_version_outcomes_utc(timestamptz,timestamptz)'::regprocedure").fetchone()
        self.assertEqual(flags,('s',True,[f'search_path={self.schema}, pg_temp'],False))
        # Per-version outcome coverage of 999/1000 exposes a missing complement of one.
        self.db.execute("UPDATE telemetry_metric_axis a SET calls=calls-1 FROM telemetry_event e WHERE a.event_key=e.event_key AND e.event_at=%s AND e.version_bucket='0.8.0' AND a.axis='outcomes' AND a.bucket='success' AND a.event_key=(SELECT min(event_key) FROM telemetry_event WHERE event_at=%s AND version_bucket='0.8.0' AND event='tool_metrics')",(self.start-dt.timedelta(days=7),self.start-dt.timedelta(days=7)))
        self.assertEqual(self.db.execute('SELECT * FROM tool_version_outcomes_utc(%s,%s)',(self.start-dt.timedelta(days=7),self.start)).fetchall(),[])
        for private in (False,True):
            for body in self.bodies(connect,private):
                self.assertIn('Comparison and numeric details withheld',body)
                self.assertNotIn('100/1000 (10.0%)',body)

    def test_repeatable_additive_migration_and_old_new_consumers(self):
        fresh_definition=self.db.execute("SELECT pg_get_functiondef('tool_version_outcomes_utc(timestamptz,timestamptz)'::regprocedure)").fetchone()
        # Use the already-required frozen pre-64 object plus its unchanged
        # migration; never substitute current schema.sql for historical bytes.
        baseline = subprocess.check_output(['git','show','de0664a974d74064d8f805d4b3bad48f21129ac3:collector/analytics/schema.sql']).decode()
        self.db.execute(f'DROP SCHEMA {self.schema} CASCADE')
        self.db.execute(f'CREATE SCHEMA {self.schema}')
        self.db.execute(baseline.replace('SET search_path = public, pg_temp',f'SET search_path = {self.schema}, pg_temp'))
        created = not self.db.execute("SELECT 1 FROM pg_roles WHERE rolname='telemetry_dashboard'").fetchone()
        if created:
            self.db.execute('CREATE ROLE telemetry_dashboard')
            def cleanup_role():
                self.db.execute('DROP OWNED BY telemetry_dashboard')
                self.db.execute('DROP ROLE telemetry_dashboard')
            self.addCleanup(cleanup_role)
        self.db.execute((fixture.ROOT/'migrate_issue64.sql').read_text().replace('SET search_path = public, pg_temp',f'SET search_path = {self.schema}, pg_temp'))
        self.db.execute('GRANT SELECT ON dashboard_tools TO telemetry_dashboard')
        self.db.execute('GRANT EXECUTE ON FUNCTION adoption_utc(timestamptz,timestamptz) TO telemetry_dashboard')
        # Seed via the unchanged importer before migration, then test old consumer admission.
        self.start,self.end = digest.closed_week(dt.datetime.now(dt.timezone.utc))
        stamp = self.start.strftime('%Y-%m-%dT%H:%M:%S.000Z')
        self.append([dict(event='tool_counts',hostId=f'old-{i}',version='0.7.9',os='win32',ts=stamp,_receivedAt=stamp,counts={'ssh_exec':10}) for i in range(20)])
        self.assertEqual(ingest(self.db,self.source,self.classes),20)
        before = self.db.execute('SELECT row_to_json(e) FROM telemetry_event e ORDER BY event_key').fetchall()
        checkpoint = self.db.execute('SELECT * FROM telemetry_checkpoint').fetchall()
        tool_history=self.db.execute('SELECT * FROM telemetry_tool ORDER BY event_key,stream,tool').fetchall()
        axis_history=self.db.execute('SELECT * FROM telemetry_metric_axis ORDER BY event_key,tool,axis,bucket').fetchall()
        functions = self.db.execute('SELECT proname,pg_get_functiondef(oid),proacl::text FROM pg_proc WHERE pronamespace=%s::regnamespace ORDER BY proname',(self.schema,)).fetchall()
        views = self.db.execute('SELECT viewname,definition FROM pg_views WHERE schemaname=%s ORDER BY viewname',(self.schema,)).fetchall()
        tables = self.db.execute('SELECT relname,relacl::text FROM pg_class WHERE relnamespace=%s::regnamespace ORDER BY relname',(self.schema,)).fetchall()
        old_data = self.snapshot(lambda: Borrowed(self.db))
        self.assertNotIn('version_outcomes',old_data)
        with self.subTest(migration='repeatable'):
            migration = (fixture.ROOT/'migrate_issue75.sql').read_text().replace('SET search_path = public, pg_temp',f'SET search_path = {self.schema}, pg_temp')
            self.db.execute(migration)
            self.db.execute(migration)
            self.assertEqual(self.db.execute("SELECT pg_get_functiondef('tool_version_outcomes_utc(timestamptz,timestamptz)'::regprocedure)").fetchone(),fresh_definition)
            self.assertEqual(self.db.execute('SELECT row_to_json(e) FROM telemetry_event e ORDER BY event_key').fetchall(),before)
            self.assertEqual(self.db.execute('SELECT * FROM telemetry_checkpoint').fetchall(),checkpoint)
            self.assertEqual(self.db.execute('SELECT * FROM telemetry_tool ORDER BY event_key,stream,tool').fetchall(),tool_history)
            self.assertEqual(self.db.execute('SELECT * FROM telemetry_metric_axis ORDER BY event_key,tool,axis,bucket').fetchall(),axis_history)
            self.assertEqual(self.db.execute("SELECT proname,pg_get_functiondef(oid),proacl::text FROM pg_proc WHERE pronamespace=%s::regnamespace AND proname<>'tool_version_outcomes_utc' ORDER BY proname",(self.schema,)).fetchall(),functions)
            self.assertEqual(self.db.execute('SELECT viewname,definition FROM pg_views WHERE schemaname=%s ORDER BY viewname',(self.schema,)).fetchall(),views)
            self.assertEqual(self.db.execute('SELECT relname,relacl::text FROM pg_class WHERE relnamespace=%s::regnamespace ORDER BY relname',(self.schema,)).fetchall(),tables)
            self.assertEqual(self.db.execute('SELECT origin,stream,tool,sum(calls) FROM dashboard_tools GROUP BY 1,2,3').fetchall(),old_data['tools'])
            self.assertEqual(self.snapshot(lambda: Borrowed(self.db))['version_outcomes'],[('unknown_origin','0.7.9','counts','ssh_exec','calls','total',200)])
            self.append([dict(event='tool_metrics',schemaVersion=2,hostId=f'old-{i}',version='0.8.1',os='win32',ts=stamp,_receivedAt=stamp,metrics={'ssh_exec':dict(outcomes={'success':10},durations={'lt100':10},features={'remote':10})}) for i in range(20)])
            self.assertEqual(ingest(self.db,self.source,self.classes),20)
            self.assertEqual(self.db.execute('SELECT sum(calls) FROM telemetry_tool').fetchone(),(400,))


class Borrowed:
    """Transaction boundary for testing owner-visible historical fixture changes."""
    def __init__(self, db): self.db=db
    def __enter__(self):
        self.tx=self.db.transaction(); self.tx.__enter__(); return self.db
    def __exit__(self,*args): return self.tx.__exit__(*args)


if __name__=='__main__': unittest.main()

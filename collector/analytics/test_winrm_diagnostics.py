import unittest
import os
import json
import subprocess
import psycopg
import test_analytics as fixture
from import_jsonl import ingest


@unittest.skipUnless(fixture.DSN, 'disposable PostgreSQL required')
class WinrmDiagnosticsTest(unittest.TestCase):
    setUp = fixture.AnalyticsTest.setUp
    tearDownDb = fixture.AnalyticsTest.tearDownDb
    append = fixture.AnalyticsTest.append

    def row(self, reasons=None, n=10):
        metric = dict(outcomes={'error': n}, durations={'lt100': n}, features={'remote': n})
        if reasons is not None:
            metric['winrmReasons'] = reasons
        return dict(event='tool_metrics', schemaVersion=2, hostId='synthetic', ts='2026-01-01T00:00:00.000Z',
                    metrics={'winrm_exec': metric})

    def test_old_missing_axis_and_new_marginal_never_increase_call_totals(self):
        self.append([dict(self.row({'invoke_exception': 1} if i < 10 else None, 1), hostId='synthetic-' + str(i)) for i in range(20)])
        self.assertEqual(ingest(self.db, self.source, self.classes), 20)
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        self.assertEqual(self.db.execute("SELECT sum(calls) FROM telemetry_tool WHERE stream='metrics'").fetchone(), (20,))
        self.assertEqual(self.db.execute("SELECT sum(calls) FROM dashboard_metric_axes WHERE axis='outcomes'").fetchone(), (20,))
        self.assertEqual(self.db.execute("SELECT * FROM winrm_diagnostics_utc('2026-01-01','2026-01-02')").fetchall(), [('unknown_origin', 'invoke_exception', 10), ('unknown_origin', 'uninstrumented', 10)])
        self.assertEqual(self.db.execute("SELECT count(*) FROM dashboard_metric_axes WHERE axis='winrmReasons'").fetchone(), (0,))
        # Missing old reasons are unavailable, not zero or an assigned cause.
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (True,))

    def test_malformed_private_axis_rolls_back_without_checkpoint(self):
        for reasons in ({'PRIVATE': 10}, {'unknown': 9}, {}, {'unknown': True}):
            with self.subTest(reasons=reasons):
                self.source.write_text('')
                self.append([self.row(reasons)])
                with self.assertRaises(ValueError): ingest(self.db, self.source, self.classes)
                self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_checkpoint').fetchone(), (0,))
                self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_event').fetchone(), (0,))

    def test_small_reason_partition_suppresses_existing_aggregate_surface(self):
        self.append([self.row({'invoke_exception': 11, 'unknown': 1}, 12)])
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (False,))
        self.assertEqual(self.db.execute("SELECT * FROM winrm_diagnostics_utc('2026-01-01','2026-01-02')").fetchall(), [])

    def test_safe_reason_count_cannot_disclose_small_uninstrumented_complement(self):
        self.append([dict(self.row({'invoke_exception': 1} if i < 11 else None, 1), hostId='synthetic-' + str(i)) for i in range(12)])
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (True,))
        self.assertEqual(self.db.execute("SELECT * FROM winrm_diagnostics_utc('2026-01-01','2026-01-02')").fetchall(), [])

    def test_outcome_minus_known_reasons_cannot_disclose_small_unknown_error_count(self):
        rows = []
        for i in range(41):
            row = self.row({'invoke_exception' if i < 20 else 'unknown': 1}, 1)
            row['hostId'] = 'synthetic-' + str(i)
            row['metrics']['winrm_exec']['outcomes'] = {'error' if i < 21 else 'success': 1}
            rows.append(row)
        self.append(rows)
        ingest(self.db, self.source, self.classes)
        # All displayed axis cells/complements are >=10, but error(21) minus
        # known error reasons(20) would expose one unknown-reason error.
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (True,))
        self.assertEqual(self.db.execute("SELECT * FROM winrm_diagnostics_utc('2026-01-01','2026-01-02')").fetchall(), [])

    def test_repeatable_migration_preserves_history_and_checkpoint(self):
        self.db.execute('DROP SCHEMA ' + self.schema + ' CASCADE')
        self.db.execute('CREATE SCHEMA ' + self.schema)
        baseline = subprocess.run(['git', 'show', 'de0664a974d74064d8f805d4b3bad48f21129ac3:collector/analytics/schema.sql'], capture_output=True, text=True, check=True).stdout
        self.db.execute(baseline.replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp'))
        self.append([self.row()])
        ingest(self.db, self.source, self.classes)
        before = self.db.execute('SELECT row_to_json(e) FROM telemetry_event e').fetchall()
        checkpoint = self.db.execute('SELECT * FROM telemetry_checkpoint').fetchall()
        created = not self.db.execute("SELECT 1 FROM pg_roles WHERE rolname='telemetry_dashboard'").fetchone()
        if created: self.db.execute('CREATE ROLE telemetry_dashboard')
        try:
            migration = (fixture.ROOT / 'migrate_issue64.sql').read_text().replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp')
            self.db.execute(migration)
            self.db.execute(migration)
            self.assertEqual(self.db.execute('SELECT row_to_json(e) FROM telemetry_event e').fetchall(), before)
            self.assertEqual(self.db.execute('SELECT * FROM telemetry_checkpoint').fetchall(), checkpoint)
            self.append([self.row({'unknown': 10})])
            self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        finally:
            if created:
                self.db.execute('DROP OWNED BY telemetry_dashboard')
                self.db.execute('DROP ROLE telemetry_dashboard')

    def test_real_client_wire_collector_importer_and_restricted_report(self):
        # Telemetry is enabled ONLY against an ephemeral loopback collector.
        script = r"""
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
const root=process.argv[1], socket=createServer();
socket.listen(0,'127.0.0.1'); await once(socket,'listening');
const port=socket.address().port; socket.close(); await once(socket,'close');
const server=spawn(process.execPath,['collector/server.js'],{env:{...process.env,PORT:String(port),TELEMETRY_FILE:join(root,'events.jsonl'),TELEMETRY_TOKEN:''},stdio:'ignore'});
try {
  let ready=false;
  for(let i=0;i<100;i++) {try {if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,25));}
  if(!ready) throw Error('fixture collector deadline');
  const module=n=>pathToFileURL(resolve('dist/'+n+'.js')).href;
  for(let i=0;i<10;i++) {
    const home=join(root,'client-'+i); mkdirSync(home);
    const code=`import {recordTool,flushCounters,telemetryStatus} from ${JSON.stringify(module('telemetry'))};
import {instrumentTool} from ${JSON.stringify(module('tool-instrumentation'))};
import {decodeWinRmResult} from ${JSON.stringify(module('winrm'))};
import {fromProcess,toolResult} from ${JSON.stringify(module('result'))};
import {readdirSync} from 'node:fs'; import {join} from 'node:path'; import {homedir} from 'node:os';
const frame='a'.repeat(48), body={status:'transport_error',reason:'remoting_transport_exception',output:'PRIVATE auth endpoint access'};
const raw={stdout:'WINRM-RESULT:'+frame+':'+Buffer.from(JSON.stringify(body)).toString('base64'),stderr:'',exitCode:0,timedOut:false,durationMs:1,shell:'synthetic',truncated:false};
await instrumentTool('winrm_exec',async()=>toolResult(fromProcess(decodeWinRmResult(raw,frame),'winrm','PRIVATE'),'PRIVATE'),recordTool)({command:'PRIVATE',password:'PRIVATE'});
flushCounters('0.7.0');
const end=Date.now()+12000; do {if(Date.now()>end)throw Error('fixture delivery deadline'); await new Promise(r=>setTimeout(r,20));}while(telemetryStatus().outstanding || readdirSync(join(homedir(),'.powershell-mcp-telemetry')).some(n=>n.startsWith('slot-')));`;
    const client=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,HOME:home,USERPROFILE:home,POWERSHELL_MCP_NO_TELEMETRY:'0',POWERSHELL_MCP_TELEMETRY_USER_ID:'',POWERSHELL_MCP_TELEMETRY_COHORT:'',POWERSHELL_MCP_TELEMETRY_URL:`http://127.0.0.1:${port}/api/telemetry`},stdio:'ignore'});
    if((await once(client,'exit'))[0]!==0)throw Error('fixture client failed');
  }
} finally {const ended=once(server,'exit'); server.kill(); await ended;}
"""
        run = subprocess.run([os.environ.get('ANALYTICS_NODE', 'node'), '--input-type=module', '-e', script, self.dir.name], capture_output=True, timeout=90)
        self.assertEqual(run.returncode, 0, 'isolated client/collector delivery failed')
        self.assertNotIn('PRIVATE', self.source.read_text())
        self.assertEqual(ingest(self.db, self.source, self.classes), 20)
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        self.assertEqual(self.db.execute('SELECT stream,sum(calls) FROM telemetry_tool GROUP BY stream ORDER BY stream').fetchall(), [('counts', 10), ('metrics', 10)])
        role = 'winrm_' + os.urandom(8).hex()
        password = os.urandom(16).hex()
        self.db.execute(psycopg.sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(psycopg.sql.Identifier(role), psycopg.sql.Literal(password)))
        try:
            self.db.execute(f'GRANT USAGE ON SCHEMA {self.schema} TO {role}')
            self.db.execute(f'GRANT EXECUTE ON FUNCTION {self.schema}.winrm_diagnostics_utc(timestamptz,timestamptz) TO {role}')
            with psycopg.connect(fixture.DSN, user=role, password=password, options=f'-c search_path={self.schema}', autocommit=True) as reader:
                rows = reader.execute("SELECT * FROM winrm_diagnostics_utc(now()-interval '1 hour',now()+interval '1 hour')").fetchall()
                self.assertEqual(rows, [('unknown_origin', 'remoting_transport_exception', 10)])
                for table in ('telemetry_event', 'telemetry_tool', 'telemetry_metric_axis'):
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege): reader.execute('SELECT * FROM ' + table)
                self.assertNotIn('PRIVATE', json.dumps(rows, default=str))
                self.assertEqual(reader.execute("SELECT * FROM winrm_diagnostics_utc(now(),now())").fetchall(), [])
        finally:
            self.db.execute(f'DROP OWNED BY {role}')
            self.db.execute(f'DROP ROLE {role}')

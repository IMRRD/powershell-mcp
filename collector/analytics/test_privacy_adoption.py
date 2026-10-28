import json
import uuid
import unittest
from pathlib import Path
import re
import os
import subprocess
import test_analytics as fixture
from import_jsonl import ingest


@unittest.skipUnless(fixture.DSN, 'disposable PostgreSQL required')
class PrivacyAdoptionTest(unittest.TestCase):
    setUp = fixture.AnalyticsTest.setUp
    tearDownDb = fixture.AnalyticsTest.tearDownDb
    append = fixture.AnalyticsTest.append
    def test_releaseable_user_coverage_is_available_when_every_cell_and_complement_is_safe(self):
        tokens = [str(uuid.uuid4()) for _ in range(10)]
        self.append([dict(event='startup', hostId=str(uuid.uuid4()), userId=tokens[i % 10], ts='2026-01-01T00:00:00.000Z') for i in range(20)])
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute("SELECT * FROM user_proxy_utc('2026-01-01','2026-01-02')").fetchall(), [('unknown_origin',20,20,0,10)])
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (True,))
    def test_user_reuse_complement_suppressed_with_all_positive_cells_above_threshold(self):
        tokens = [str(uuid.uuid4()) for _ in range(20)]
        self.append([dict(event='startup', hostId=str(uuid.uuid4()), userId=tokens[i % 20], ts='2026-01-01T00:00:00.000Z') for i in range(21)])
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute("SELECT * FROM user_proxy_raw_utc('2026-01-01','2026-01-02')").fetchall(), [('unknown_origin',21,21,0,20)])
        self.assertEqual(self.db.execute("SELECT * FROM user_proxy_utc('2026-01-01','2026-01-02')").fetchall(), [])
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (False,))
    def test_real_client_collector_importer_user_coverage(self):
        # CI compiles the client before Python tests. Synthetic loopback only.
        script = r"""
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
const root=process.argv[1];
const socket=createServer(); socket.listen(0,'127.0.0.1'); await once(socket,'listening');
const port=socket.address().port; socket.close(); await once(socket,'close');
const server=spawn(process.execPath,['collector/server.js'],{env:{...process.env,PORT:String(port),TELEMETRY_FILE:join(root,'events.jsonl'),TELEMETRY_TOKEN:''},stdio:'ignore'});
try {
  let ready=false;
  for(let i=0;i<100;i++) {try {if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,25));}
  if(!ready) throw Error('fixture collector deadline');
  const module=pathToFileURL(resolve('dist/telemetry.js')).href;
  const token='12345678-1234-4234-8234-123456789abc';
  for(let i=0;i<3;i++) {
    const home=join(root,'client-'+i); mkdirSync(home);
    const source=`import {startupPing,telemetryStatus} from ${JSON.stringify(module)}; import {readdirSync} from 'node:fs'; import {join} from 'node:path'; import {homedir} from 'node:os'; startupPing('0.7.0'); const end=Date.now()+12000; do {if(Date.now()>end)throw Error('fixture delivery deadline'); await new Promise(r=>setTimeout(r,20));}while(telemetryStatus().outstanding || readdirSync(join(homedir(),'.powershell-mcp-telemetry')).some(n=>n.startsWith('slot-')));`;
    const client=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,HOME:home,USERPROFILE:home,POWERSHELL_MCP_NO_TELEMETRY:'0',POWERSHELL_MCP_TELEMETRY_USER_ID:i<2?token:'',POWERSHELL_MCP_TELEMETRY_COHORT:'external_self_declared',POWERSHELL_MCP_TELEMETRY_URL:`http://127.0.0.1:${port}/api/telemetry`},stdio:'ignore'});
    if((await once(client,'exit'))[0]!==0)throw Error('fixture client failed');
  }
} finally {const ended=once(server,'exit'); server.kill(); await ended;}
"""
        run = subprocess.run([os.environ.get('ANALYTICS_NODE', 'node'), '--input-type=module', '-e', script, self.dir.name], capture_output=True, timeout=65)
        self.assertEqual(run.returncode, 0, 'isolated client/collector delivery failed')
        self.assertEqual(ingest(self.db, self.source, self.classes), 3)
        self.assertEqual(self.db.execute("SELECT * FROM user_proxy_raw_utc(now()-interval '1 hour',now()+interval '1 hour')").fetchall(), [('external_self_declared', 3, 2, 1, 1)])
        self.assertEqual(self.db.execute("SELECT * FROM user_proxy_utc(now()-interval '1 hour',now()+interval '1 hour')").fetchall(), [])
    def test_migration_preserves_legacy_history_and_checkpoint(self):
        # Exercise the exact baseline schema then the executable additive migration.
        self.db.execute('DROP SCHEMA ' + self.schema + ' CASCADE')
        self.db.execute('CREATE SCHEMA ' + self.schema)
        baseline = subprocess.run(['git', 'show', '83b8c7bdd7820a756d1b365ee698053e2da4f9c7:collector/analytics/schema.sql'], capture_output=True, text=True, check=True).stdout
        self.db.execute(baseline.replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp'))
        self.db.execute("INSERT INTO telemetry_event VALUES ('old','hash','unknown_origin','key','startup','2020-01-01',NULL,'other','other','{}','valid','missing')")
        before = self.db.execute('SELECT row_to_json(e)::text FROM telemetry_event e').fetchone()[0]
        role = 'telemetry_dashboard'
        created = not self.db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone()
        if created: self.db.execute('CREATE ROLE ' + role)
        try:
            migration = (fixture.ROOT / 'migrate_issue63.sql').read_text().replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp')
            self.db.execute(migration)
            self.db.execute(migration)  # repeatable after an uncertain operator response
            after = self.db.execute('SELECT row_to_json(e)::jsonb - \'user_key\' FROM telemetry_event e').fetchone()[0]
            self.assertEqual(json.loads(before), after)
            self.assertEqual(self.db.execute("SELECT origin FROM telemetry_event WHERE event_key='old'").fetchone(), ('unknown_origin',))
            canonical = (fixture.ROOT / 'schema.sql').read_text().split('-- Issue 63:')[1].split('CREATE VIEW dashboard_events')[0]
            self.assertIn(canonical, (fixture.ROOT / 'migrate_issue63.sql').read_text())
        finally:
            if created:
                self.db.execute('DROP OWNED BY ' + role)
                self.db.execute('DROP ROLE ' + role)
    def test_registry_enrollment_is_bounded_future_only_and_conflicts_fail(self):
        from enroll_installation import enroll
        private = Path(self.dir.name) / 'private'
        if os.name != 'nt': private.mkdir(mode=0o700)
        if os.name == 'nt':
            script = "$p='" + str(private).replace("'", "''") + "'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetOwner($sid); $a.SetAccessRuleProtection($true,$false); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))); Set-Acl -LiteralPath $p -AclObject $a"
            script = script.replace('Set-Acl -LiteralPath $p -AclObject $a', '[void][IO.Directory]::CreateDirectory($p,$a)')
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        host = str(uuid.uuid4())
        identity = private / 'installation-id'
        identity.write_text(host)
        registry = private / 'registry.json'
        enroll(registry, identity, 'internal')
        before = registry.read_bytes()
        with self.assertRaises(ValueError): enroll(registry, identity, 'test')
        self.assertEqual(registry.read_bytes(), before)
        base = dict(event='startup', hostId=host, ts='2026-01-01T00:00:00.000Z')
        self.append([dict(base, _receivedAt='2020-01-01T00:00:00.000Z'), dict(base, _receivedAt='2099-01-01T00:00:00.000Z'), base])
        ingest(self.db, self.source, registry)
        self.assertEqual(self.db.execute('SELECT origin,count(*) FROM telemetry_event GROUP BY origin ORDER BY origin').fetchall(), [('internal', 1), ('unknown_origin', 2)])

    def test_dashboard_render_queries_withhold_complements_and_role_denies_identifiers(self):
        # Every positive adoption/user cell >=10, but observed-active-startup =1.
        rows = [dict(hostId='active'+str(i), event='tool_counts', counts={'ssh_exec': 10}, ts='2026-01-01T00:00:00.000Z') for i in range(11)]
        rows += [dict(hostId='startup'+str(i), event='startup', ts='2026-01-01T00:00:00.000Z') for i in range(10)]
        rows += [dict(hostId='other', event='probe', ts='2026-01-01T00:00:00.000Z') for i in range(10)]
        self.append(rows)
        ingest(self.db, self.source, self.classes)
        role = 'privacy_' + os.urandom(8).hex()
        self.db.execute('CREATE ROLE ' + role)
        try:
            self.db.execute(f'GRANT USAGE ON SCHEMA {self.schema} TO {role}')
            self.db.execute(f'GRANT SELECT ON dashboard_events,dashboard_tools,dashboard_metric_axes TO {role}')
            for signature in ('adoption_utc(timestamptz,timestamptz)', 'user_proxy_utc(timestamptz,timestamptz)', 'privacy_window_safe_utc(timestamptz,timestamptz)', 'delivery_health_utc(timestamptz,timestamptz,interval)', 'winrm_diagnostics_utc(timestamptz,timestamptz)'):
                self.db.execute(f'GRANT EXECUTE ON FUNCTION {signature} TO {role}')
            self.db.execute('SET ROLE ' + role)
            with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege): self.db.execute('SELECT * FROM telemetry_event')
            with self.assertRaises(fixture.psycopg.errors.InsufficientPrivilege): self.db.execute("SELECT * FROM user_proxy_raw_utc('2026-01-01','2026-01-02')")
            def panels(items):
                for panel in items:
                    if panel.get('targets'): yield panel
                    yield from panels(panel.get('panels', []))
            dashboards = [json.loads((fixture.ROOT / name).read_text()) for name in ('dashboard.json', 'overview-preview.json')]
            for panel in panels([p for d in dashboards for p in d['panels']]):
                sql = panel['targets'][0]['rawSql']
                sql = re.sub(r'\$__timeFilter\(([^)]+)\)', r"\1 BETWEEN '2026-01-01'::timestamptz AND '2026-01-02'::timestamptz", sql)
                sql = sql.replace('$__timeFrom()', "'2026-01-01'").replace('$__timeTo()', "'2026-01-02'")
                self.assertEqual(self.db.execute(sql).fetchall(), [], panel['title'])
            example = (fixture.ROOT / 'queries.sql').read_text()
            example = '\n'.join(line for line in example.splitlines() if not line.strip().startswith('--'))
            for sql in example.split(';'):
                if sql.strip():
                    sql = sql.replace(':from_utc', "'2026-01-01'::timestamptz").replace(':to_utc', "'2026-01-02'::timestamptz")
                    self.assertEqual(self.db.execute(sql).fetchall(), [], 'documented aggregate SQL suppression')
        finally:
            self.db.execute('RESET ROLE')
            self.db.execute('DROP OWNED BY ' + role)
            self.db.execute('DROP ROLE ' + role)
    # Reuse the real disposable database fixture, without duplicating its tests.
    def test_cohorts_users_history_and_suppression(self):
        user = str(uuid.uuid4())
        hosts = [str(uuid.uuid4()) for _ in range(3)]
        base = dict(event='startup', version='0.7.0', os='win32', ts='2026-01-01T00:00:00.000Z')
        self.append([dict(base, hostId=hosts[0], userId=user, cohort='external_self_declared'),
                     dict(base, hostId=hosts[1], userId=user, cohort='external_self_declared'),
                     dict(base, hostId=hosts[2])])
        self.assertEqual(ingest(self.db, self.source, self.classes), 3)
        query = "SELECT origin, observed_installations, covered_installations, unknown_user_installations, user_proxies FROM user_proxy_raw_utc('2026-01-01','2026-01-02') ORDER BY origin"
        self.assertEqual(self.db.execute(query).fetchall(), [('external_self_declared', 2, 2, 0, 1), ('unknown_origin', 1, 0, 1, 0)])
        self.assertEqual(self.db.execute(query.replace('user_proxy_raw_utc', 'user_proxy_utc')).fetchall(), [])
        self.classes.write_text(json.dumps(dict(internalHostIds=[hosts[0]], testHostIds=[])))
        self.append([dict(base, hostId=hosts[0], cohort='external_self_declared')])
        self.assertEqual(ingest(self.db, self.source, self.classes), 1)
        self.assertEqual(self.db.execute('SELECT origin, count(*) FROM telemetry_event GROUP BY origin ORDER BY origin').fetchall(), [('cohort_conflict', 1), ('external_self_declared', 2), ('unknown_origin', 1)])
        self.assertEqual(ingest(self.db, self.source, self.classes), 0)
        # A reset or partial opt-in on one installation cannot become two people.
        self.append([dict(base, hostId=hosts[1], userId=str(uuid.uuid4()), cohort='external_self_declared')])
        ingest(self.db, self.source, self.classes)
        external = next(r for r in self.db.execute(query).fetchall() if r[0] == 'external_self_declared')
        self.assertEqual(external, ('external_self_declared', 2, 1, 1, 1))
        self.assertEqual(self.db.execute("SELECT privacy_window_safe_utc('2026-01-01','2026-01-02')").fetchone(), (False,))
        self.assertNotIn(user, str(self.db.execute('SELECT raw FROM telemetry_event').fetchall()))

    def test_malicious_user_fields_abort_without_checkpoint(self):
        self.append([dict(event='startup', userId='private@example.invalid', cohort='internal')])
        with self.assertRaises(ValueError): ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute('SELECT count(*) FROM telemetry_checkpoint').fetchone()[0], 0)

"""Real PostgreSQL regressions for the two issue63 review blockers."""
import json
import re
import unittest
import uuid

import test_analytics as fixture
from import_jsonl import ingest

START = "'2026-01-01'::timestamptz"
END = "'2026-01-02'::timestamptz"


def panels(items):
    for panel in items:
        if panel.get('targets'):
            yield panel
        yield from panels(panel.get('panels', []))


def expand(sql, start=START, end=END):
    # Grafana PostgreSQL timeFilter is inclusive BETWEEN. Never fake a < here.
    sql = re.sub(r'\$__timeFilter\(([^)]+)\)', rf'\1 BETWEEN {start} AND {end}', sql)
    return sql.replace('$__timeFrom()', start).replace('$__timeTo()', end)


@unittest.skipUnless(fixture.DSN, 'disposable PostgreSQL required')
class PrivacyReviewRegressions(unittest.TestCase):
    setUp = fixture.AnalyticsTest.setUp
    tearDownDb = fixture.AnalyticsTest.tearDownDb
    append = fixture.AnalyticsTest.append

    def query(self, name, pid, start=START, end=END):
        panel = next(p for p in panels(json.loads((fixture.ROOT / name).read_text())['panels']) if p['id'] == pid)
        return self.db.execute(expand(panel['targets'][0]['rawSql'], start, end)).fetchall()

    def joint_rows(self, cells):
        rows = []
        for version, counts, metrics in cells:
            for event, n in [('tool_counts', counts), ('tool_metrics', metrics)]:
                for _ in range(n):
                    row = dict(hostId=str(uuid.uuid4()), event=event, version=version, os='win32', ts='2026-01-01T12:00:00.000Z')
                    if event == 'tool_counts':
                        row['counts'] = {'ssh_exec': 10}
                    else:
                        row.update(schemaVersion=2, metrics={'ssh_exec': {'outcomes': {'success': 10}, 'durations': {'lt100': 10}, 'features': {'remote': 10}}})
                    rows.append(row)
        return rows

    def test_joint_cells_and_complements_withhold_all_panels(self):
        self.append(self.joint_rows([('0.7.0', 1, 10), ('0.7.1', 10, 1)]))
        self.assertEqual(ingest(self.db, self.source, self.classes), 22)
        self.assertEqual(self.db.execute("SELECT version_bucket,event,count(*) FROM telemetry_event GROUP BY 1,2 ORDER BY 1,2").fetchall(), [('0.7.0','tool_counts',1), ('0.7.0','tool_metrics',10), ('0.7.1','tool_counts',10), ('0.7.1','tool_metrics',1)])
        # Each displayed cell and the remainder of its version partition matter.
        self.assertEqual(self.db.execute("SELECT n,total-n FROM (SELECT count(*) AS n,sum(count(*)) OVER (PARTITION BY origin,version_bucket) AS total FROM telemetry_event GROUP BY origin,version_bucket,event) s ORDER BY n,total-n").fetchall(), [(1,10),(1,10),(10,1),(10,1)])
        self.assertEqual(self.db.execute(f'SELECT privacy_window_safe_utc({START},{END})').fetchone(), (False,))
        for name in ('dashboard.json', 'overview-preview.json'):
            for panel in panels(json.loads((fixture.ROOT / name).read_text())['panels']):
                self.assertEqual(self.query(name, panel['id']), [], (name, panel['id']))

    def test_joint_cells_above_threshold_release(self):
        self.append(self.joint_rows([('0.7.0', 10, 10), ('0.7.1', 10, 10)]))
        ingest(self.db, self.source, self.classes)
        self.assertEqual(self.db.execute(f'SELECT privacy_window_safe_utc({START},{END})').fetchone(), (True,))
        for name, pid in [('dashboard.json',11), ('overview-preview.json',211)]:
            self.assertEqual([(r[1],r[2],r[3]) for r in self.query(name,pid)], [('0.7.0',10,10), ('0.7.1',10,10)])

    def test_exact_start_end_future_event_and_receipt_windows(self):
        rows = [dict(hostId=str(uuid.uuid4()),event='startup',version='0.7.0',os='win32',ts='2026-01-01T00:00:00.000Z',_receivedAt='2026-01-01T00:00:00.000Z') for _ in range(20)]
        for stamp in ('2026-01-02T00:00:00.000Z','2026-01-03T00:00:00.000Z'):
            rows.append(dict(hostId=str(uuid.uuid4()),event='tool_counts',counts={'ssh_exec':1},version='0.7.0',os='win32',ts=stamp,_receivedAt=stamp))
            rows.append(dict(hostId=str(uuid.uuid4()),event='tool_metrics',schemaVersion=2,metrics={'ssh_exec': {'outcomes': {'success': 1}, 'durations': {'lt100': 1}, 'features': {'remote': 1}}},version='0.7.0',os='win32',ts=stamp,_receivedAt=stamp))
        self.append(rows)
        ingest(self.db,self.source,self.classes)
        self.assertEqual(self.db.execute(f'SELECT privacy_window_safe_utc({START},{END})').fetchone(), (True,))
        for name, offset in [('dashboard.json',0), ('overview-preview.json',200)]:
            self.assertEqual(self.query(name,offset+2), [('unknown_origin','startup',20)])
            self.assertEqual(self.query(name,offset+3), [])
            self.assertEqual(self.query(name,offset+7), [])
            self.assertEqual(self.query(name,offset+11), [])
            self.assertEqual(self.query(name,offset+9), [])
            self.assertEqual(self.query(name,offset+10), [])
            receipt = self.query(name,offset+5)
            self.assertEqual(len(receipt),1)
            self.assertEqual(receipt[0][2:], (20,0.0))
            health = self.query(name,offset+6)[0]
            self.assertEqual(health[1].isoformat(), '2026-01-01T00:00:00+00:00')
            self.assertEqual(health[3:],(0,0))
        self.assertEqual(self.query('overview-preview.json',104)[0][0],1767225600000)
        for pid in (101,102,103):
            self.assertEqual(self.query('overview-preview.json',pid), [(None,)])
        # Reversed/zero-length selections withhold even all-history surfaces.
        for name in ('dashboard.json','overview-preview.json'):
            for panel in panels(json.loads((fixture.ROOT/name).read_text())['panels']):
                self.assertEqual(self.query(name,panel['id'],END,END), [])
                self.assertEqual(self.query(name,panel['id'],END,START), [])

    def test_empty_window_and_actual_grafana_macro_expansion(self):
        self.assertEqual(self.db.execute('SELECT ' + expand('$__timeFilter(' + END + ')')).fetchone(), (True,))
        for name, pid in [('dashboard.json',2), ('overview-preview.json',202)]:
            self.assertEqual(self.query(name,pid), [])
        self.assertEqual(self.db.execute(f'SELECT last_receipt,invalid_event_times,invalid_receipt_times FROM delivery_health_utc({END},{START},interval \'2 hours\')').fetchone(),(None,0,0))


@unittest.skipUnless(fixture.DSN, 'disposable PostgreSQL required')
class MigratedPrivacyReviewRegressions(PrivacyReviewRegressions):
    """Run the same adversarial fixtures through the actual additive migration."""
    def setUp(self):
        import subprocess
        super().setUp()
        self.db.execute('DROP SCHEMA ' + self.schema + ' CASCADE')
        self.db.execute('CREATE SCHEMA ' + self.schema)
        baseline = subprocess.check_output(['git','show','83b8c7bdd7820a756d1b365ee698053e2da4f9c7:collector/analytics/schema.sql']).decode()
        self.db.execute(baseline.replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp'))
        role = 'telemetry_dashboard'
        if not self.db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (role,)).fetchone():
            self.db.execute('CREATE ROLE ' + role)
            self.addCleanup(self.drop_fixture_role)
        migration = (fixture.ROOT/'migrate_issue63.sql').read_text().replace('SET search_path = public, pg_temp', f'SET search_path = {self.schema}, pg_temp')
        self.db.execute(migration)
        self.db.execute(migration)

    def drop_fixture_role(self):
        self.db.execute('DROP OWNED BY telemetry_dashboard')
        self.db.execute('DROP ROLE telemetry_dashboard')


if __name__ == '__main__':
    unittest.main()

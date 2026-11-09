import json
import unittest
from pathlib import Path


class ReliabilityDashboardTests(unittest.TestCase):
    def test_reason_panels_query_restricted_marginal_in_both_definitions(self):
        def walk(items):
            for p in items:
                yield p
                yield from walk(p.get('panels', []))
        for name in ('dashboard.json', 'overview-preview.json'):
            d = json.loads(Path(__file__).with_name(name).read_text(encoding='utf8'))
            panels = [p for p in walk(d['panels']) if 'WinRM diagnostics' in p['title']]
            self.assertTrue(panels, name)
            for p in panels:
                sql = p['targets'][0]['rawSql']
                self.assertIn('winrm_diagnostics_utc($__timeFrom()::timestamptz, $__timeTo()::timestamptz)', sql)
                self.assertNotIn('dashboard_metric_axes', sql)
                self.assertNotIn('JOIN', sql.upper())
                self.assertNotIn('coalesce', sql.lower())
                self.assertIn('uninstrumented', p['description'])
                self.assertIn('unknown', p['description'])
                self.assertIn('withheld', p['description'])

    def test_private_metric_panels_use_marginal_axes_and_explicit_coverage(self):
        dashboard = json.loads(Path(__file__).with_name('dashboard.json').read_text())
        panels = {p['id']: p for p in dashboard['panels']}
        self.assertEqual(dashboard['version'], 5)
        self.assertEqual(len(panels), 13)
        self.assertEqual([panels[n]['gridPos'] for n in (9, 10, 11)], [
            {'x': 0, 'y': 48, 'w': 24, 'h': 9},
            {'x': 0, 'y': 57, 'w': 24, 'h': 9},
            {'x': 0, 'y': 66, 'w': 24, 'h': 9},
        ])
        failures = panels[9]['targets'][0]['rawSql']
        self.assertIn("a.axis = 'outcomes'", failures)
        self.assertIn("a.bucket IN ('nonzero','error','timeout','cancelled','unknown')", failures)
        self.assertIn('NULLIF(sum(a.calls), 0)', failures)
        self.assertNotIn('dashboard_tools', failures)
        durations = panels[10]['targets'][0]['rawSql']
        self.assertIn("a.axis = 'durations'", durations)
        self.assertIn("a.bucket = 'gte10000'", durations)
        self.assertNotIn('percentile', durations.lower())
        coverage = panels[11]['targets'][0]['rawSql']
        self.assertIn('version_bucket', coverage)
        self.assertIn("e.event = 'tool_counts'", coverage)
        self.assertIn("e.event = 'tool_metrics'", coverage)
        self.assertIn("ELSE 'Unknown: no tool batches'", coverage)
        self.assertTrue(all('private-telemetry-pg' == p['datasource']['uid'] for p in panels.values()))
        for p in panels.values():
            g = p['gridPos']
            self.assertLessEqual(g['x'] + g['w'], 24)
        for a in panels.values():
            for b in panels.values():
                if a['id'] >= b['id']:
                    continue
                x, y = a['gridPos'], b['gridPos']
                self.assertFalse(x['x'] < y['x'] + y['w'] and y['x'] < x['x'] + x['w']
                                 and x['y'] < y['y'] + y['h'] and y['y'] < x['y'] + x['h'])


if __name__ == '__main__':
    unittest.main()

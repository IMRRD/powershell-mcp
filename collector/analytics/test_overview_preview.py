import json
import unittest
from pathlib import Path

HERE = Path(__file__).parent

class OverviewPreviewContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = json.loads((HERE / 'overview-preview.json').read_text())
        cls.panels = cls.d['panels']

    def test_preview_is_isolated_and_readable(self):
        self.assertEqual(self.d['uid'], 'powershell-mcp-overview-preview')
        self.assertIn('PREVIEW', self.d['title'])
        self.assertEqual(self.d['time']['from'], 'now-24h')
        self.assertTrue(all(p['datasource']['uid'] == 'powershell-mcp-pg' for p in self.panels if p.get('targets')))
        self.assertTrue(all(p['targets'][0]['datasource']['uid'] == 'powershell-mcp-pg' for p in self.panels if p.get('targets')))
        self.assertEqual([p['title'] for p in self.panels[:4]], ['Recorded calls', 'Non-success', 'Calls ≥10 seconds', 'Data receipt'])

    def test_grid_has_no_overlap_and_details_collapsed(self):
        for p in self.panels:
            g = p['gridPos']; self.assertGreater(g['w'], 0); self.assertGreater(g['h'], 0)
            self.assertGreaterEqual(g['x'], 0); self.assertLessEqual(g['x'] + g['w'], 24)
        for i, a in enumerate(self.panels):
            for b in self.panels[i + 1:]:
                x, y = a['gridPos'], b['gridPos']
                self.assertFalse(x['x'] < y['x'] + y['w'] and y['x'] < x['x'] + x['w'] and x['y'] < y['y'] + y['h'] and y['y'] < x['y'] + x['h'], (a['title'], b['title']))
        rows = [p for p in self.panels if p['type'] == 'row']
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]['collapsed'])
        self.assertGreaterEqual(len(rows[0]['panels']), 7)

    def test_metric_axes_never_add_legacy_counts_or_join_marginals(self):
        for p in self.panels[:3]:
            q = p['targets'][0]['rawSql']
            self.assertIn("axis = 'outcomes'" if p['title'] != 'Calls ≥10 seconds' else "axis = 'durations'", q)
            self.assertNotIn('dashboard_tools', q)
            self.assertNotIn(' JOIN ', q.upper())
        for p in self.panels:
            if p.get('targets'):
                q = p['targets'][0]['rawSql']
                self.assertNotIn('COALESCE(sum(a.calls),0) AS recorded_calls', q)

    def test_ranked_table_has_explicit_denominator_and_no_false_zero(self):
        p = next(p for p in self.panels if p['title'] == 'Tools to review')
        q = p['targets'][0]['rawSql']
        self.assertIn("axis = 'outcomes'", q)
        self.assertIn("axis = 'durations'", q)
        self.assertIn('NULLIF(', q)
        self.assertIn('FULL OUTER JOIN', q.upper())
        self.assertIn('ORDER BY', q)
        self.assertIn('unknown', q.lower())
        self.assertIn('coalesce(o.non_success,0)/NULLIF', q)
        self.assertNotIn('nonzero_exits AS', q)

    def test_receipt_is_numeric_timestamp_and_outcome_chart_has_categories(self):
        receipt = next(p for p in self.panels if p['title'] == 'Data receipt')
        self.assertIn('extract(epoch FROM max(received_at))*1000', receipt['targets'][0]['rawSql'])
        chart = next(p for p in self.panels if p['title'] == 'Recorded outcomes by tool')
        sql = chart['targets'][0]['rawSql']
        self.assertIn('AS success', sql)
        self.assertIn('AS nonzero', sql)
        self.assertIn('AS errors', sql)
        self.assertIn('AS timeouts', sql)
        self.assertNotIn('GROUP BY tool,bucket', sql)
        table = next(p for p in self.panels if p['title'] == 'Tools to review')
        widths = [x['properties'][0]['value'] for x in table['fieldConfig']['overrides']]
        self.assertLessEqual(sum(widths), 1150)
        self.assertGreaterEqual(widths[0], 180)
        self.assertGreaterEqual(next(p for p in self.panels if p['id'] == 105)['gridPos']['h'], 6)
        self.assertNotIn(' AS origin', table['targets'][0]['rawSql'])
        self.assertNotIn('GROUP BY origin,tool', table['targets'][0]['rawSql'])

if __name__ == '__main__': unittest.main()

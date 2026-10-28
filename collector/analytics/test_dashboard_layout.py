import json
import unittest
from pathlib import Path


DASHBOARD = Path(__file__).with_name('dashboard.json')


class PrivateDashboardLayoutTests(unittest.TestCase):
    def test_delivery_health_columns_fit_and_status_remains_readable(self):
        dashboard = json.loads(DASHBOARD.read_text(encoding='utf-8'))
        panel = next(p for p in dashboard['panels'] if p['id'] == 6)
        self.assertEqual(panel['gridPos']['w'], 24)
        expected = {'status': 400, 'last_receipt': 190, 'last_import': 190,
                    'invalid_event_times': 165, 'invalid_receipt_times': 165}
        overrides = panel['fieldConfig']['overrides']
        self.assertTrue(all(o['matcher']['id'] == 'byName' for o in overrides))
        widths = {o['matcher']['options']: next(prop['value'] for prop in o['properties']
                  if prop['id'] == 'custom.width') for o in overrides}
        self.assertEqual(widths, expected)
        self.assertLessEqual(sum(widths.values()), 1110)
        self.assertIn(
                         "SELECT * FROM delivery_health_utc($__timeTo()::timestamptz, $__timeFrom()::timestamptz, interval '2 hours')", panel['targets'][0]['rawSql'])


if __name__ == '__main__':
    unittest.main()

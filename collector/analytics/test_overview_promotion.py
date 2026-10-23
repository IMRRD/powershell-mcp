import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('promote', HERE / 'operations' / 'promote_overview.py')


class FakeGrafana:
    def __init__(self, dashboard):
        self.dashboard = copy.deepcopy(dashboard)
        self.writes = []

    def read(self, uid):
        assert uid == 'powershell-mcp-usage'
        return copy.deepcopy(self.dashboard)

    def write(self, dashboard, expected_version):
        if self.dashboard['version'] != expected_version:
            raise ValueError('concurrent Grafana version drift')
        self.writes.append(copy.deepcopy(dashboard))
        self.dashboard = copy.deepcopy(dashboard)
        self.dashboard['version'] += 1


class PromotionTests(unittest.TestCase):
    def setUp(self):
        self.promote = importlib.util.module_from_spec(SPEC)
        SPEC.loader.exec_module(self.promote)
        self.preview = json.loads((HERE / 'overview-preview.json').read_text())
        self.live = {'uid': 'powershell-mcp-usage', 'version': 7, 'title': 'Original', 'panels': [{'id': 1}]}
        self.client = FakeGrafana(self.live)

    def test_guard_rejects_drift_without_write(self):
        with self.assertRaisesRegex(ValueError, 'baseline drift'):
            self.promote.apply(self.client, self.preview, '0' * 64, 7)
        self.assertFalse(self.client.writes)

    def test_apply_repeat_and_rollback_exact_baseline(self):
        digest = self.promote.digest(self.live)
        receipt = self.promote.apply(self.client, self.preview, digest, 7)
        self.assertEqual(receipt['before'], self.live)
        self.assertEqual(self.client.dashboard['uid'], self.live['uid'])
        self.assertEqual(self.client.dashboard['panels'], self.preview['panels'])
        self.assertEqual(len(self.client.writes), 1)
        self.assertEqual(self.promote.apply(self.client, self.preview, digest, 7, receipt=receipt), receipt)
        self.promote.rollback(self.client, receipt)
        self.assertEqual(self.client.dashboard['panels'], self.live['panels'])
        self.assertEqual(self.client.dashboard['version'], 9)

    def test_rollback_refuses_external_edit(self):
        receipt = self.promote.apply(self.client, self.preview, self.promote.digest(self.live), 7)
        self.client.dashboard['panels'] = []
        with self.assertRaisesRegex(ValueError, 'drift'):
            self.promote.rollback(self.client, receipt)
        self.assertEqual(len(self.client.writes), 1)

    def test_preview_uid_and_source_geometry_are_bounded(self):
        bad = copy.deepcopy(self.preview)
        bad['panels'][0]['gridPos']['w'] = 25
        with self.assertRaisesRegex(ValueError, 'grid'):
            self.promote.apply(self.client, bad, self.promote.digest(self.live), 7)
        self.assertFalse(self.client.writes)


if __name__ == '__main__':
    unittest.main()

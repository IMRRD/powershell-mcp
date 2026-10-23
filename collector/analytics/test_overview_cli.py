import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('overview_cli', HERE / 'operations' / 'overview_cli.py')

class Api:
    def __init__(self):
        self.dashboard = {'id': 42, 'uid': 'powershell-mcp-usage', 'version': 3, 'title': 'Old', 'panels': []}
        self.writes = 0
        self.fail_after_write = False
    def read(self, uid):
        return json.loads(json.dumps(self.dashboard))
    def inventory(self):
        return {self.dashboard['uid']: self.read(self.dashboard['uid']), 'powershell-mcp-overview-preview': {}}
    def write(self, dashboard, expected_version):
        assert self.dashboard['version'] == expected_version
        self.dashboard = json.loads(json.dumps(dashboard))
        self.dashboard['version'] += 1
        self.writes += 1
        if self.fail_after_write:
            raise ConnectionError('reply lost after mutation')

class CliTests(unittest.TestCase):
    def test_crash_after_write_reconciles_without_duplicate_mutation_and_rolls_back(self):
        module = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(module)
        preview = json.loads((HERE / 'overview-preview.json').read_text())
        api = Api()
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'receipt.json'
            api.fail_after_write = True
            with self.assertRaises(ConnectionError):
                module.run(api, preview, path, 'apply')
            self.assertEqual(json.loads(path.read_text())['state'], 'pending-apply')
            api.fail_after_write = False
            module.run(api, preview, path, 'apply')
            self.assertEqual(api.writes, 1)
            self.assertEqual(json.loads(path.read_text())['state'], 'applied')
            module.run(api, preview, path, 'rollback')
            self.assertEqual(api.writes, 2)
            self.assertEqual(api.dashboard['title'], 'Old')
            self.assertEqual(api.dashboard['version'], 5)
    def test_unknown_outcome_refuses_blind_retry(self):
        module = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(module)
        preview = json.loads((HERE / 'overview-preview.json').read_text())
        api = Api()
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'receipt.json'
            api.fail_after_write = True
            with self.assertRaises(ConnectionError): module.run(api, preview, path, 'apply')
            api.dashboard['title'] = 'Concurrent edit'
            api.fail_after_write = False
            with self.assertRaisesRegex(ValueError, 'drift|unknown'):
                module.run(api, preview, path, 'apply')
            self.assertEqual(api.writes, 1)

if __name__ == '__main__': unittest.main()

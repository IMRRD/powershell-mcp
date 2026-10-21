import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name('activate_private.py')
spec = importlib.util.spec_from_file_location('activate_private', SCRIPT)
mod = importlib.util.module_from_spec(spec)
# Missing executor is the intentional RED state.
spec.loader.exec_module(mod)


class Fake:
    def __init__(self, fail=None):
        self.fail = fail
        self.state = {}
        self.calls = []

    def get(self, key):
        return self.state.get(key)

    def identity(self, key):
        return key if key in self.state else None

    def create(self, key, value):
        self.calls.append(('create', key))
        if self.fail == key:
            raise RuntimeError('injected failure')
        assert key not in self.state
        self.state[key] = value

    def delete(self, key, value):
        self.calls.append(('delete', key))
        if self.state.get(key) != value:
            raise ValueError('ownership drift')
        del self.state[key]


class ActivationTests(unittest.TestCase):
    def test_positive_idempotent_and_owned_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Fake()
            path = pathlib.Path(directory) / 'receipt.json'
            mod.apply(adapter, path, mod.resources('approved-admin'))
            self.assertEqual(len(adapter.state), 7)
            mod.apply(adapter, path, mod.resources('approved-admin'))
            self.assertEqual(len([c for c in adapter.calls if c[0] == 'create']), 7)
            mod.rollback(adapter, path)
            self.assertEqual(adapter.state, {})
            mod.rollback(adapter, path)

    def test_failure_after_each_side_effect_rolls_back_only_owned(self):
        for key in mod.resources('approved-admin'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                adapter = Fake(key)
                path = pathlib.Path(directory) / 'receipt.json'
                with self.assertRaises(RuntimeError):
                    mod.apply(adapter, path, mod.resources('approved-admin'))
                adapter.fail = None
                receipt = __import__('json').loads(path.read_text())
                self.assertIn(key, receipt['pending'])
                with self.assertRaisesRegex(ValueError, 'unknown creation outcome'):
                    mod.rollback(adapter, path)
                self.assertEqual(set(adapter.state), set(receipt['owned']))

    def test_foreign_resources_and_drift_are_never_overwritten_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Fake()
            adapter.state['org'] = {'name': 'other'}
            path = pathlib.Path(directory) / 'receipt.json'
            with self.assertRaises(ValueError):
                mod.apply(adapter, path, mod.resources('approved-admin'))
            self.assertEqual(adapter.state['org'], {'name': 'other'})
            del adapter.state['org']
            mod.apply(adapter, path, mod.resources('approved-admin'))
            adapter.state['folder'] = {'uid': 'drift'}
            with self.assertRaises(ValueError):
                mod.rollback(adapter, path)
            self.assertIn('folder', adapter.state)

    def test_missing_admin_fails_before_mutation(self):
        with self.assertRaises(ValueError):
            mod.resources('')


if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
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

    def org_empty(self, oid, admin):
        return self.state.get('org', {}).get('admin') == admin and not any(
            k in self.state for k in ('folder', 'datasource', 'dashboard'))

    def disposable_database_empty(self, name):
        return True

    def credential_active(self, key):
        return True

    def revoke_credentials(self):
        self.calls.append(('revoke_credentials', None))

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
    def test_ssh_mutation_timeout_keeps_pending_receipt_and_does_not_retry(self):
        backend = Fake()
        adapter = mod.SSHAdapter('pg-host', 'grafana-host', 'identity')
        attempts = []
        def execute(host, identity, request):
            if request['action'] == 'create':
                attempts.append(request['key'])
                raise TimeoutError('unknown outcome')
            return {'value': backend.get(request['key'])}
        adapter.execute = execute
        with tempfile.TemporaryDirectory() as tmp:
            receipt = pathlib.Path(tmp) / 'receipt.json'
            for _ in range(2):
                with self.assertRaises((TimeoutError, ValueError)):
                    mod.apply(adapter, receipt, mod.resources('admin'))
            self.assertEqual(attempts, ['database'])
            self.assertIn('database', json.loads(receipt.read_text())['pending'])

    def test_ssh_controller_routes_existing_apply_verify_rollback(self):
        import tempfile
        from pathlib import Path
        backend = Fake()
        calls = []
        adapter = mod.SSHAdapter('pg-host', 'grafana-host', 'identity')
        def execute(host, identity, request):
            key, action = request['key'], request['action']
            self.assertEqual(host, 'pg-host' if key in ('database', 'importer', 'dashboard_role', 'roles') else 'grafana-host')
            calls.append((host, action, key))
            if action in ('create', 'delete'):
                getattr(backend, action)(key, request['value'])
                return {'value': backend.get(key)}
            if action == 'org_empty':
                return {'value': backend.org_empty(backend.identity('org'), request['value']['admin'])}
            if action == 'revoke_credentials':
                backend.revoke_credentials()
                return {'value': True}
            return {'value': getattr(backend, action)(key)}
        adapter.execute = execute
        desired = mod.resources('admin')
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp) / 'receipt.json'
            mod.apply(adapter, receipt, desired)
            mod.apply(adapter, receipt, desired)
            owned = json.loads(receipt.read_text())['owned']
            self.assertTrue(all(adapter.get(k) == v['value'] and adapter.identity(k) == v['identity'] for k, v in owned.items()))
            self.assertTrue(any(host == 'pg-host' and action == 'create' for host, action, _ in calls))
            self.assertTrue(any(host == 'grafana-host' and action == 'create' for host, action, _ in calls))
    def test_positive_idempotent_and_owned_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Fake()
            path = pathlib.Path(directory) / 'receipt.json'
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            self.assertEqual(len(adapter.state), 7)
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            self.assertEqual(len([c for c in adapter.calls if c[0] == 'create']), 7)
            mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            self.assertEqual(adapter.state, {})
            mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})

    def test_failure_after_each_side_effect_rolls_back_only_owned(self):
        for key in mod.resources('approved-admin'):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                adapter = Fake(key)
                path = pathlib.Path(directory) / 'receipt.json'
                with self.assertRaises(RuntimeError):
                    mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
                adapter.fail = None
                receipt = __import__('json').loads(path.read_text())
                self.assertIn(key, receipt['pending'])
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
                self.assertEqual(adapter.state, {})

    def test_foreign_resources_and_drift_are_never_overwritten_or_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            adapter = Fake()
            adapter.state['org'] = {'name': 'other'}
            path = pathlib.Path(directory) / 'receipt.json'
            with self.assertRaises(ValueError):
                mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            self.assertEqual(adapter.state['org'], {'name': 'other'})
            del adapter.state['org']
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            adapter.state['folder'] = {'uid': 'drift'}
            with self.assertRaises(ValueError):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            self.assertIn('folder', adapter.state)

    def test_missing_admin_fails_before_mutation(self):
        with self.assertRaises(ValueError):
            mod.resources('')

    def test_fresh_process_recovers_pending_creation_after_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            desired = mod.resources('approved-admin')
            adapter = Fake()
            original = mod._save
            def interrupted(target, receipt):
                if 'database' in receipt['owned'] and 'database' not in receipt['pending']:
                    raise RuntimeError('process killed before receipt save')
                return original(target, receipt)
            mod._save = interrupted
            try:
                with self.assertRaisesRegex(RuntimeError, 'process killed'):
                    mod.apply(adapter, path, desired, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            finally:
                mod._save = original
            self.assertIn('database', adapter.state)
            self.assertIn('database', __import__('json').loads(path.read_text())['pending'])
            mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            self.assertEqual(adapter.state, {})
            self.assertEqual(__import__('json').loads(path.read_text())['pending'], {})

    def test_pending_drift_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            desired = mod.resources('approved-admin')
            mod._save(path, {'owned': {}, 'pending': {'database': desired['database']}, 'desired': desired, 'disposable_fixture': {'kind': 'isolated-container', 'receipt': str(path)}})
            adapter = Fake()
            adapter.state['database'] = {'name': 'foreign'}
            with self.assertRaisesRegex(ValueError, 'pending creation drift'):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            self.assertEqual(adapter.state['database'], {'name': 'foreign'})

    def test_org_delete_http_500_retains_only_empty_org_and_reuses_owned_identity(self):
        class BrokenOrg(Fake):
            def delete(self, key, value):
                if key == 'org':
                    raise RuntimeError('Grafana org deletion: unsupported DeleteCollection (HTTP 500)')
                super().delete(key, value)

        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = BrokenOrg()
            desired = mod.resources('approved-admin')
            mod.apply(adapter, path, desired, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            with self.assertRaisesRegex(RuntimeError, 'rollback incomplete'):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            receipt = __import__('json').loads(path.read_text())
            self.assertEqual(set(receipt['owned']), {'org'})
            self.assertEqual(set(adapter.state), {'org'})
            self.assertEqual(receipt['retained_org']['name'], desired['org']['name'])
            self.assertEqual(receipt['retained_org']['id'], 'org')
            with self.assertRaisesRegex(RuntimeError, 'rollback incomplete'):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            mod.apply(adapter, path, desired, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            self.assertEqual(len([c for c in adapter.calls if c == ('create', 'org')]), 1)
            self.assertNotIn('retained_org', __import__('json').loads(path.read_text()))

    def test_unknown_org_delete_failure_revokes_but_does_not_drop_database(self):
        class BrokenOrg(Fake):
            def delete(self, key, value):
                if key == 'org':
                    raise RuntimeError('Grafana DELETE /api/orgs/2: HTTP 500')
                super().delete(key, value)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = BrokenOrg()
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            with self.assertRaisesRegex(RuntimeError, 'HTTP 500'):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            self.assertIn(('revoke_credentials', None), adapter.calls)
            self.assertEqual(set(adapter.state), {'org', 'database', 'dashboard_role', 'importer'})

    def test_fixture_binding_and_other_data_fail_closed(self):
        for relation in ('telemetry_checkpoint', 'foreign_table', 'no_telemetry_event'):
            with self.subTest(relation=relation), tempfile.TemporaryDirectory() as directory:
                path = pathlib.Path(directory) / 'receipt.json'
                adapter = Fake()
                adapter.disposable_database_empty = lambda name: False
                mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
                with self.assertRaises(ValueError):
                    mod.rollback(adapter, path, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
                self.assertIn('database', adapter.state)
                self.assertNotIn(('delete', 'database'), adapter.calls)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = Fake()
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            with self.assertRaisesRegex(ValueError, 'fixture binding'):
                mod.rollback(adapter, path, disposable_fixture={'kind': 'isolated-container', 'receipt': 'other'})
            self.assertIn('database', adapter.state)

    def test_populated_database_cannot_be_dropped(self):
        class Populated(Fake):
            def disposable_database_empty(self, name):
                return False
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = Populated()
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            with self.assertRaisesRegex(ValueError, 'retention decision required'):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            self.assertIn('database', adapter.state)
            self.assertNotIn('org', adapter.state)


    def test_production_receipt_rejects_disposable_flag_even_with_empty_database(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = Fake()
            mod.apply(adapter, path, mod.resources('approved-admin'))
            with self.assertRaisesRegex(ValueError, 'fixture binding'):
                mod.rollback(adapter, path, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            self.assertIn('database', adapter.state)
            self.assertNotIn(('delete', 'database'), adapter.calls)

    def test_default_rollback_keeps_database_and_disables_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = Fake()
            mod.apply(adapter, path, mod.resources('approved-admin'), disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            with self.assertRaisesRegex(ValueError, 'database retained'):
                mod.rollback(adapter, path)
            self.assertIn('database', adapter.state)
            self.assertIn(('revoke_credentials', None), adapter.calls)

    def test_retained_org_drift_blocks_reapply(self):
        class BrokenOrg(Fake):
            def delete(self, key, value):
                if key == 'org':
                    raise RuntimeError('Grafana org deletion: unsupported DeleteCollection (HTTP 500)')
                super().delete(key, value)
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'receipt.json'
            adapter = BrokenOrg()
            desired = mod.resources('approved-admin')
            mod.apply(adapter, path, desired, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            with self.assertRaisesRegex(RuntimeError, 'rollback incomplete'):
                mod.rollback(adapter, path, disposable_fixture={"kind": "isolated-container", "receipt": str(path)})
            adapter.state['datasource'] = desired['datasource']
            with self.assertRaisesRegex(ValueError, 'retained org is not empty'):
                mod.apply(adapter, path, desired, disposable_fixture={'kind': 'isolated-container', 'receipt': str(path)})
            self.assertEqual(set(adapter.state), {'org', 'datasource'})

if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
import tempfile
import os
import time
import hashlib
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('transport', HERE / 'ssh_command_transport.py')
transport = importlib.util.module_from_spec(spec)


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec.loader.exec_module(transport)

    def test_local_helper_denies_arbitrary_path_and_mutation(self):
        for request in ({'operation': 'grafana', 'method': 'DELETE', 'path': '/api/orgs/1'},
                        {'operation': 'grafana', 'method': 'GET', 'path': '/api/admin/settings'},
                        {'operation': 'pg', 'query': 'DROP DATABASE postgres'}):
            result = subprocess.run([sys.executable, str(HERE / 'ssh_command_helper.py')],
                                    input=json.dumps(request), text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('DROP DATABASE', result.stdout)

    def test_binding_refuses_missing_mutated_shadow_and_untrusted_code_before_import(self):
        helper = HERE / 'ssh_command_helper.py'
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'install'
            root.mkdir()
            config = Path(temp) / 'config.json'
            config.write_text('{}')
            env = dict(os.environ, ANALYTICS_HELPER_ROOT=str(root), ANALYTICS_HELPER_CONFIG=str(config),
                       ANALYTICS_HELPER_BACKEND='pg')
            request = json.dumps({'operation':'activation','action':'get','key':'database'}).encode()
            result = subprocess.run([sys.executable, str(helper)], input=request, env=env, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn(b'activate_private', result.stdout)

    def test_protected_rejects_ssh_user_owned_ancestry(self):
        spec_helper = importlib.util.spec_from_file_location('helper', HERE / 'ssh_command_helper.py')
        helper = importlib.util.module_from_spec(spec_helper)
        spec_helper.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / 'config.json'
            target.write_text('{}')
            with patch.object(Path, 'lstat', return_value=SimpleNamespace(st_mode=0o100600, st_uid=1001)), \
                 patch.object(helper.os, 'geteuid', return_value=1001, create=True):
                with self.assertRaisesRegex(ValueError, 'owner'):
                    helper._protected(target)

    def test_verified_activation_executes_captured_blob_and_returns_captured_config(self):
        spec_helper = importlib.util.spec_from_file_location('helper', HERE / 'ssh_command_helper.py')
        helper = importlib.util.module_from_spec(spec_helper)
        spec_helper.loader.exec_module(helper)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'operations').mkdir()
            source = b'class LiveAdapter: pass\ndef resources(admin): return admin\n'
            blobs = {name: (source if name == 'operations/activate_private.py' else b'fixture') for name in transport.REVIEWED_BLOBS}
            for name, data in blobs.items():
                (root / name).write_bytes(data)
            config = root / 'helper.json'
            config.write_bytes(b'{"approved_admin":"safe"}')
            helper.REVIEWED_BLOBS = {name: hashlib.sha256(data).hexdigest() for name, data in blobs.items()}
            original_read = Path.read_bytes
            reads = []
            def changing_read(path):
                data = original_read(path)
                reads.append(path)
                if path == root / 'operations/activate_private.py':
                    path.write_bytes(b'raise RuntimeError("unreviewed execution")')
                if path == config:
                    path.write_bytes(b'{"approved_admin":"changed"}')
                return data
            with patch.dict(os.environ, ANALYTICS_HELPER_ROOT=str(root), ANALYTICS_HELPER_CONFIG=str(config)), \
                 patch.object(helper, '_protected'), patch.object(Path, 'read_bytes', changing_read):
                adapter, resources, parsed = helper.verified_activation()
            self.assertEqual(resources('safe'), 'safe')
            self.assertEqual(parsed, {'approved_admin': 'safe'})
            self.assertEqual(reads.count(root / 'operations/activate_private.py'), 1)
            self.assertEqual(reads.count(config), 1)

    def test_bounded_reader_refuses_large_parallel_output_and_accepts_exact_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            code = 'import sys;sys.stdout.buffer.write(b"x"*70000);sys.stderr.buffer.write(b"y"*70000)'
            with self.assertRaises(transport.UnknownOutcome):
                transport._bounded_process([sys.executable, '-c', code], b'', timeout=5)
            code = 'import sys;sys.stdout.buffer.write(b"x"*32768);sys.stderr.buffer.write(b"y"*32768)'
            result = transport._bounded_process([sys.executable, '-c', code], b'', timeout=5)
            self.assertEqual(len(result.stdout) + len(result.stderr), 65536)
            code = 'import sys;sys.stdout.buffer.write("é".encode()*32768)'
            result = transport._bounded_process([sys.executable, '-c', code], b'', timeout=5)
            self.assertEqual(len(result.stdout), 65536)

    def test_reader_deadline_and_invalid_frames_fail_closed(self):
        with self.assertRaisesRegex(transport.UnknownOutcome, 'unknown'):
            transport._bounded_process([sys.executable, '-c', 'import time;time.sleep(10)'], b'', timeout=.1)
        start = time.monotonic()
        with self.assertRaisesRegex(transport.UnknownOutcome, 'unknown'):
            transport._bounded_process([sys.executable, '-c', 'import time;time.sleep(10)'], b'x' * 131072, timeout=.1)
        self.assertLess(time.monotonic() - start, 2)
        for response in (b'', b'{"ok":true,"ok":false,"result":{}}', b'{"ok":true,"result":'):
            with patch.object(transport, '_bounded_process', return_value=subprocess.CompletedProcess([], 0, response, b'')):
                with self.assertRaises(transport.UnknownOutcome):
                    transport.execute('host', 'key', {'operation':'attest'})
        with patch.object(transport, '_bounded_process', return_value=subprocess.CompletedProcess([], 1, b'', b'private-secret')):
            with self.assertRaisesRegex(transport.UnknownOutcome, 'reconcile') as failure:
                transport.execute('host', 'key', {'operation':'attest'})
        self.assertNotIn('private-secret', str(failure.exception))

    def test_controller_uses_fixed_command_and_frames_no_secret_argv(self):
        with patch.object(transport, '_bounded_process') as run:
            run.return_value = subprocess.CompletedProcess([], 0, b'{"ok":true,"result":{"database":false}}\n', b'')
            answer = transport.execute('host', 'key', {'operation': 'pg', 'query': 'private_database_exists'})
        self.assertEqual(answer, {'database': False})
        argv = run.call_args.args[0]
        self.assertNotIn('private_database_exists', ' '.join(argv))
        self.assertEqual(argv[-1], transport.REMOTE_COMMAND)
        self.assertIn(b'private_database_exists', run.call_args.args[1])

    def test_unknown_outcome_does_not_retry_or_expose_stderr(self):
        with patch.object(transport, '_bounded_process', side_effect=transport.UnknownOutcome('SSH outcome unknown')) as run:
            with self.assertRaisesRegex(transport.UnknownOutcome, 'unknown'):
                transport.execute('host', 'key', {'operation': 'grafana', 'method': 'POST', 'path': '/api/orgs', 'payload': {'name': 'private'}})
        self.assertEqual(run.call_count, 1)

    def test_org_unsupported_delete_marker_is_only_classified_for_org_delete(self):
        marker = subprocess.CompletedProcess([], 0, b'{"ok":false,"error":"unsupported DeleteCollection"}\n', b'')
        with patch.object(transport, '_bounded_process', return_value=marker):
            with self.assertRaisesRegex(RuntimeError, 'unsupported DeleteCollection'):
                transport.execute('host', 'key', {'operation': 'activation', 'action': 'delete', 'key': 'org', 'value': {}})
            with self.assertRaises(transport.UnknownOutcome):
                transport.execute('host', 'key', {'operation': 'activation', 'action': 'delete', 'key': 'database', 'value': {}})

    def test_helper_rejects_arbitrary_activation_and_never_echoes_secret(self):
        for request in ({'operation': 'activation', 'action': 'create', 'key': 'database', 'value': {'name': 'evil-secret'}},
                        {'operation': 'activation', 'action': 'delete', 'key': 'org', 'path': '/api/orgs/1'},
                        {'operation': 'activation', 'action': 'query', 'key': 'database', 'query': 'evil-secret'}):
            result = subprocess.run([sys.executable, str(HERE / 'ssh_command_helper.py')],
                                    input=json.dumps(request), text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('evil-secret', result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest
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

    def test_controller_uses_fixed_command_and_frames_no_secret_argv(self):
        with patch.object(transport.subprocess, 'run') as run:
            run.return_value = subprocess.CompletedProcess([], 0, b'{"ok":true,"result":{"database":false}}\n', b'')
            answer = transport.execute('host', 'key', {'operation': 'pg', 'query': 'private_database_exists'})
        self.assertEqual(answer, {'database': False})
        argv = run.call_args.args[0]
        self.assertNotIn('private_database_exists', ' '.join(argv))
        self.assertEqual(argv[-1], transport.REMOTE_COMMAND)
        self.assertIn(b'private_database_exists', run.call_args.kwargs['input'])
        self.assertIsNotNone(run.call_args.kwargs['timeout'])

    def test_unknown_outcome_does_not_retry_or_expose_stderr(self):
        with patch.object(transport.subprocess, 'run', side_effect=subprocess.TimeoutExpired('ssh', 5)) as run:
            with self.assertRaisesRegex(transport.UnknownOutcome, 'unknown'):
                transport.execute('host', 'key', {'operation': 'grafana', 'method': 'POST', 'path': '/api/orgs', 'payload': {'name': 'private'}})
        self.assertEqual(run.call_count, 1)


if __name__ == '__main__':
    unittest.main()

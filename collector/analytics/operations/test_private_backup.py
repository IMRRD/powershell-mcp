import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('private_backup', Path(__file__).with_name('private_backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.offhost = self.root / 'offhost'
        self.offhost.mkdir()
        self.state = self.root / 'state'
        self.schema = self.root / 'schema.sql'
        self.roles = self.root / 'roles.sql'
        self.schema.write_text('schema')
        self.roles.write_text('roles')
        self.args = types.SimpleNamespace(directory=str(self.state), database='private', host='isolated',
            key='key', known_hosts='hosts', remote_dir='backups', schema=str(self.schema), roles=str(self.roles),
            schema_sha256=backup.sha(self.schema), roles_sha256=backup.sha(self.roles),
            pg_dump='pg_dump', sftp='sftp', dump_timeout=10, transfer_timeout=10, min_free_bytes=0)
        self.fail_stage = None

    def commands(self, argv, timeout, *, stdout=None, stdin=None):
        if argv[0] == 'pg_dump':
            stdout.write(b'PGDMP' + b'x' * 4096)
            return
        command = stdin.read().decode().strip().splitlines()[0]
        action, source, target = command.split('"')[0].strip(), command.split('"')[1], command.split('"')[3]
        if self.fail_stage == action:
            raise RuntimeError('injected transfer failure')
        if action == 'put':
            (self.offhost / target).parent.mkdir(parents=True, exist_ok=True)
            (self.offhost / target).write_bytes(Path(source).read_bytes())
        elif action == 'get':
            payload = (self.offhost / source).read_bytes()
            if self.fail_stage == 'corrupt':
                payload += b'corrupt'
            Path(target).write_bytes(payload)
        elif action == 'rename':
            (self.offhost / source).rename(self.offhost / target)
        else:
            raise AssertionError(action)

    def test_publication_and_failure_preserve_previous(self):
        with patch.object(backup, 'run_command', self.commands):
            first = backup.run(self.args)
            self.assertEqual(first['status'], 'success')
            original = self.offhost / first['remote']
            self.assertEqual(backup.sha(original), first['sha256'])
            self.fail_stage = 'get'
            with self.assertRaises(RuntimeError):
                backup.run(self.args)
            self.assertEqual(json.loads((self.state / 'latest-attempt.json').read_text())['status'], 'failed')
            self.assertEqual(backup.sha(original), first['sha256'])
            self.fail_stage = 'corrupt'
            with self.assertRaises(ValueError):
                backup.run(self.args)
            self.assertEqual(backup.sha(original), first['sha256'])

    def test_failed_dump_no_zero_publication(self):
        def fail_dump(argv, timeout, **kwargs):
            raise RuntimeError('dump interrupted')
        with patch.object(backup, 'run_command', fail_dump):
            with self.assertRaises(RuntimeError):
                backup.run(self.args)
        self.assertEqual(list(self.offhost.iterdir()), [])
        self.assertEqual(json.loads((self.state / 'latest-attempt.json').read_text())['status'], 'failed')

    def test_schema_pin_and_capacity(self):
        self.schema.write_text('changed')
        with self.assertRaises(ValueError):
            backup.run(self.args)
        self.schema.write_text('schema')
        self.args.min_free_bytes = 10**30
        with self.assertRaises(OSError):
            backup.run(self.args)


if __name__ == '__main__':
    unittest.main()

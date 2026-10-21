import importlib.util
import json
from pathlib import Path
import tempfile
import types
import subprocess
import sys
import configparser
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

    def test_expired_budget_prevents_dump_and_keeps_failed_receipt(self):
        self.args.total_timeout = 0
        with patch.object(backup, 'run_command') as command:
            with self.assertRaises(TimeoutError):
                backup.run(self.args)
        command.assert_not_called()
        self.assertEqual(json.loads((self.state / 'latest-attempt.json').read_text())['status'], 'failed')

    def test_budget_applies_to_hash_chunks(self):
        with patch.object(backup.time, 'monotonic', side_effect=[0, 2]):
            with self.assertRaises(TimeoutError):
                backup.sha(self.schema, deadline=1)

    def test_service_bound_exceeds_coordinator_and_cleanup(self):
        config = configparser.ConfigParser(interpolation=None)
        config.read(Path(__file__).parent / 'systemd' / 'analytics-private-backup.service')
        start = config['Service']['ExecStart']
        total = int(start.split('--total-timeout ')[1].split()[0])
        service = config['Service']['TimeoutStartSec']
        seconds = int(service.removesuffix('min')) * 60 if service.endswith('min') else int(service.removesuffix('s'))
        self.assertGreaterEqual(seconds, total + backup.CLEANUP_MARGIN_SECONDS)

    def test_subprocess_timeout_reaps_child(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            backup.run_command([sys.executable, '-c', 'import time; time.sleep(10)'], .01)

    def test_directory_sync_failure_after_replace_is_not_success(self):
        self.state.mkdir()
        target = self.state / 'latest-attempt.json'
        with patch.object(backup, 'sync_directory', side_effect=OSError('directory fsync failed')):
            with self.assertRaises(OSError):
                backup.atomic_json(target, {'status': 'success'})
        self.assertEqual(json.loads(target.read_text())['status'], 'success')
        # Caller must fail closed: replacement is visible but persistence is uncertain.

    @unittest.skipIf(backup.os.name == 'nt', 'POSIX directory fsync requires POSIX runner')
    def test_posix_receipt_syncs_parent_directory(self):
        self.state.mkdir()
        with patch.object(backup.os, 'fsync', wraps=backup.os.fsync) as sync:
            backup.atomic_json(self.state / 'latest-attempt.json', {'status': 'unknown'})
        self.assertGreaterEqual(sync.call_count, 2)

    def test_success_receipt_sync_failure_preserves_prior_archive(self):
        with patch.object(backup, 'run_command', self.commands):
            first = backup.run(self.args)
            original = self.offhost / first['remote']
            real = backup.atomic_json
            calls = 0
            def failing_receipt(path, value):
                nonlocal calls
                calls += 1
                if calls == 2:
                    with patch.object(backup, 'sync_directory', side_effect=OSError('uncertain')):
                        return real(path, value)
                return real(path, value)
            with patch.object(backup, 'atomic_json', failing_receipt):
                with self.assertRaises(OSError):
                    backup.run(self.args)
            self.assertEqual(backup.sha(original), first['sha256'])
            self.assertEqual(json.loads((self.state / 'latest-attempt.json').read_text())['status'], 'failed')

    def test_expired_transfer_budget_does_not_launch_sftp(self):
        with patch.object(backup.time, 'monotonic', return_value=10), patch.object(backup, 'run_command') as command:
            with self.assertRaises(TimeoutError):
                backup.transfer(self.args, self.schema, 'backups/new.dump', 1)
        command.assert_not_called()

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

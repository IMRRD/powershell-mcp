import importlib.util
import hashlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent


class InstalledTransportTests(unittest.TestCase):
    def test_reviewed_source_pins_match_frozen_commit_and_refuse_drift(self):
        import sys
        sys.path.insert(0, str(ROOT))
        import install_reviewed_helper as installer
        installer.check_source()
        for name, digest in installer.REVIEWED_BLOBS.items():
            self.assertEqual(hashlib.sha256(installer.reviewed_bytes(name)).hexdigest(), digest)
        original = installer.reviewed_bytes
        with patch.object(installer, 'reviewed_bytes', side_effect=lambda name: b'unreviewed' if name == 'dashboard.json' else original(name)):
            with self.assertRaisesRegex(ValueError, 'reviewed source drift: dashboard.json'):
                installer.check_source()

    def launcher(self):
        import sys
        sys.path.insert(0, str(ROOT))
        from install_reviewed_helper import render_launcher
        module = type('Launcher', (), {})()
        exec(compile(render_launcher(), 'rendered_launcher.py', 'exec'), module.__dict__)
        return module

    def test_pg_namespace_refuses_multiple_and_stopped(self):
        module = self.launcher()
        container = {'State': {'Running': True, 'Pid': 123}, 'Config': {'Labels': {'com.docker.swarm.service.name': 'telemetry_storage_postgres'}}}
        with patch.object(module, '_running_pg_containers', return_value=[container, container]):
            with self.assertRaises(ValueError):
                module.bind_pg_namespace('telemetry_storage_postgres')
        container['State']['Running'] = False
        with patch.object(module, '_running_pg_containers', return_value=[container]):
            with self.assertRaisesRegex(ValueError, 'stopped'):
                module.bind_pg_namespace('telemetry_storage_postgres')

    def test_pg_namespace_refuses_pid_drift_before_setns(self):
        module = self.launcher()
        container = {'State': {'Running': True, 'Pid': 123}, 'Config': {'Labels': {'com.docker.swarm.service.name': 'telemetry_storage_postgres'}}}
        with patch.object(module, '_running_pg_containers', return_value=[container]), patch.object(module, '_process_identity', side_effect=['before', 'after']), patch.object(module.os, 'open', return_value=19), patch.object(module.os, 'close'), patch.object(module.os, 'O_CLOEXEC', 0, create=True):
            with self.assertRaisesRegex(ValueError, 'PID drift'):
                module.bind_pg_namespace('telemetry_storage_postgres')

    def test_pg_namespace_rejects_wrong_service_before_setns(self):
        import sys
        sys.path.insert(0, str(ROOT))
        from install_reviewed_helper import render_launcher
        module = type('Launcher', (), {})()
        exec(compile(render_launcher(), 'rendered_launcher.py', 'exec'), module.__dict__)
        with patch.object(module, '_running_pg_containers', return_value=[{'State': {'Running': True, 'Pid': 123}, 'Config': {'Labels': {'com.docker.swarm.service.name': 'other'}}}]):
            with self.assertRaisesRegex(ValueError, 'service identity'):
                module.bind_pg_namespace('telemetry_storage_postgres')

    def test_controller_sends_only_json_to_fixed_sudo_launcher(self):
        spec = importlib.util.spec_from_file_location('transport', ROOT / 'ssh_command_transport.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        calls = []
        def fake(argv, payload):
            calls.append((argv, payload))
            from subprocess import CompletedProcess
            return CompletedProcess(argv, 0, b'{"ok":true,"result":{"verified":true}}', b'')
        with patch.object(module, '_bounded_process', fake):
            self.assertEqual(module.execute('example', '/key', {'operation': 'attest'}), {'verified': True})
        argv, payload = calls[0]
        self.assertEqual(argv[-1], 'sudo -n -- /opt/analytics-reviewed/bin/helper')
        self.assertEqual(json.loads(payload), {'operation': 'attest'})
        self.assertNotIn(b'exec(', payload)

    def test_rejects_extra_attestation_fields(self):
        import sys
        sys.path.insert(0, str(ROOT))
        from install_reviewed_helper import render_launcher
        module = type('Launcher', (), {})()
        exec(compile(render_launcher(), 'rendered_launcher.py', 'exec'), module.__dict__)
        with self.assertRaises(ValueError):
            module.validate_request({'operation': 'attest', 'backend': 'pg'})
        with self.assertRaises(ValueError):
            module.validate_request({'operation': 'attest', 'code': 'print(1)'})

import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parent


class InstalledTransportTests(unittest.TestCase):
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

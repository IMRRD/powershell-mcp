import configparser
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent


class SystemdContractTests(unittest.TestCase):
    def test_disabled_installable_units_invoke_actual_cli(self):
        service = (HERE / 'systemd' / 'analytics-recurring.service').read_text()
        timer = (HERE / 'systemd' / 'analytics-recurring.timer').read_text()
        self.assertIn('EnvironmentFile=/etc/analytics-recurring/recurrence.conf', service)
        self.assertIn('ExecStart=/usr/bin/python3 /opt/analytics-reviewed/operations/recurring_import.py', service)
        from recurring_import import main
        import ast
        source = ast.parse((HERE / 'recurring_import.py').read_text())
        fields = next(node for node in ast.walk(source) if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == 'field')
        required = ast.literal_eval(fields.iter)
        for field in required:
            self.assertIn('--' + field + ' ', service)
        self.assertIn('User=analytics-import', service)
        self.assertIn('AssertPathExists=/opt/analytics-private-data/telemetry.jsonl', service)
        self.assertIn('Persistent=true', timer)
        self.assertIn('Unit=analytics-recurring.service', timer)
        self.assertNotIn('WantedBy=', service)
        self.assertIn('WantedBy=timers.target', timer)


if __name__ == '__main__':
    unittest.main()

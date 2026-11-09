"""Synthetic admission parity at the disk-replay/importer boundary; no database."""
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest

from import_jsonl import metric_axes, WINRM_REASONS


class TelemetryAdmissionContractTest(unittest.TestCase):
    def test_old_and_reason_bearing_metrics_have_matching_admission_and_call_totals(self):
        old = dict(outcomes={'error': 1}, durations={'lt100': 1}, features={'remote': 1})
        cases = [('winrm_exec', old, True)]
        for reason in sorted(WINRM_REASONS):
            cases.append(('winrm_exec', old | {'winrmReasons': {reason: 1}}, True))
        for reasons in ({'PRIVATE': 1}, {'unknown': 2}, {}, {'unknown': 0}, {'unknown': True}, {'unknown': 1.5}):
            cases.append(('winrm_exec', old | {'winrmReasons': reasons}, False))
        cases.append(('ssh_exec', old | {'winrmReasons': {'unknown': 1}}, False))
        cases.append(('winrm_exec', old | {'errorText': 'PRIVATE'}, False))
        overflow = 9007199254740991
        cases.append(('winrm_exec', dict(outcomes={'error': overflow, 'success': 1},
                     durations={'lt100': overflow, 'lt1000': 1}, features={'remote': overflow, 'logs': 1}), False))
        # The same synthetic fixtures traverse the compiled disk-replay allowlist.
        script = """
import { readFileSync } from 'node:fs';
import { validQueuedEvent } from './dist/telemetry-wire.js';
import { WINRM_REASONS } from './dist/winrm-reason.js';
const id = '12345678-1234-4234-8234-123456789abc';
const cases = JSON.parse(readFileSync(0, 'utf8'));
const accepted = cases.map(([tool, row]) => validQueuedEvent({
  schemaVersion: 2, eventId: id, hostId: id, event: 'tool_metrics',
  version: '0.8.0', os: 'win32', ts: '2026-01-01T00:00:00.000Z', metrics: { [tool]: row }
}, id));
process.stdout.write(JSON.stringify({accepted, reasons: WINRM_REASONS}));
"""
        result = subprocess.run([os.environ.get('ANALYTICS_NODE', 'node'), '--input-type=module', '-e', script],
                                input=json.dumps(cases), text=True, capture_output=True, timeout=15,
                                cwd=Path(__file__).resolve().parents[2])
        self.assertEqual(result.returncode, 0, 'compiled wire contract must run (compile TypeScript first)')
        wire = json.loads(result.stdout)
        self.assertEqual(set(wire['reasons']), WINRM_REASONS)
        self.assertEqual(wire['accepted'], [accepted for tool, row, accepted in cases])
        for tool, row, accepted in cases:
            before = copy.deepcopy(row)
            if accepted:
                self.assertEqual(metric_axes(row, tool), 1)
            else:
                with self.assertRaises(ValueError):
                    metric_axes(row, tool)
            self.assertEqual(row, before, 'admission must not rewrite historical input')

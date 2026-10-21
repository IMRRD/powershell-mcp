import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from recurring_import import run, read_segment
from forced_segment import serve
from unittest.mock import patch
import io


class RecurrenceTests(unittest.TestCase):
    def test_two_complete_cycles_and_replay(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            collector = root / 'collector.jsonl'
            target = root / 'telemetry.jsonl'
            collector.write_bytes(b'{"event":"startup"}\n')
            target.write_bytes(b'')
            ssh = root / 'ssh'
            def local_segment(_ssh, _host, _key, _hosts, offset, prefix):
                output = io.BytesIO()
                request = json.dumps({'offset': offset, 'limit': 4 * 1024 * 1024, 'expected_prefix': prefix}).encode() + b'\n'
                serve(collector, io.BytesIO(request), output)
                header, _, chunk = output.getvalue().partition(b'\n')
                return json.loads(header), chunk
            importer = root / 'importer.py'
            importer.write_text('import os,sys\nfrom pathlib import Path\np=Path(sys.argv[sys.argv.index("--source")+1]); assert os.environ["ANALYTICS_DSN"] == "fixture"; assert p.read_bytes().endswith(b"\\n")\n')
            dsn = root / 'dsn'
            dsn.write_text('fixture')
            from argparse import Namespace
            def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
            args = Namespace(source=str(target), state=str(root / 'identity'), receipt=str(root / 'receipt'),
                             host='collector', key=str(root / 'key'), known_hosts=str(root / 'hosts'),
                             dsn_file=str(dsn), importer=str(importer), classification=str(root / 'class'),
                             collector_hash=sha(HERE / 'collector_segment.py'), transfer_hash=sha(HERE / 'incremental_transfer.py'),
                             importer_hash=sha(importer), ssh=str(ssh), max_segments=8)
            with patch('recurring_import.read_segment', side_effect=local_segment):
                inode = target.stat().st_ino
                self.assertEqual(run(args), 0)
                collector.write_bytes(collector.read_bytes() + b'{"event":"startup","second":true}\n')
                self.assertEqual(run(args), 0)
                self.assertEqual(run(args), 0)
                self.assertEqual(target.read_bytes(), collector.read_bytes())
                self.assertEqual(target.stat().st_ino, inode)
                self.assertEqual(json.loads(Path(args.receipt).read_text())['status'], 'success')
                collector.write_bytes(b'changed\n')
                with self.assertRaises(Exception): run(args)
                receipt = json.loads(Path(args.receipt).read_text())
                self.assertEqual(receipt['status'], 'failed')
                self.assertIn('last_success', receipt)
                self.assertEqual(target.read_bytes(), b'{"event":"startup"}\n{"event":"startup","second":true}\n')

    def test_forced_endpoint_rejects_unbounded_input(self):
        import io
        with self.assertRaises(ValueError):
            serve('/missing', io.BytesIO(b'{"offset":0,"limit":999999999,"expected_prefix":"x"}\n'), io.BytesIO())


if __name__ == '__main__': unittest.main()

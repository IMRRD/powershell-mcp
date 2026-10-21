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
from recurring_import import run, read_segment, bounded_process
from forced_segment import serve
from unittest.mock import patch
import io


class RecurrenceTests(unittest.TestCase):
    def test_bounded_child_stdout_stderr_timeout_and_exit(self):
        for stream in ('stdout', 'stderr'):
            with self.subTest(stream=stream):
                script = f'import sys; sys.{stream}.buffer.write(b"x" * 100000); sys.{stream}.flush()'
                with self.assertRaisesRegex(RuntimeError, 'output limit'):
                    bounded_process([sys.executable, '-c', script], b'', stdout_limit=512, stderr_limit=256, timeout=5)
        with self.assertRaisesRegex(TimeoutError, 'timed out'):
            bounded_process([sys.executable, '-c', 'import time; time.sleep(30)'], b'', stdout_limit=512, stderr_limit=256, timeout=.2)
        result = bounded_process([sys.executable, '-c', 'import sys; print("ok"); sys.stderr.write("warning")'], b'', stdout_limit=512, stderr_limit=256, timeout=5)
        self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b'ok' + os.linesep.encode(), b'warning'))
        result = bounded_process([sys.executable, '-c', 'import sys; sys.exit(7)'], b'', stdout_limit=512, stderr_limit=256, timeout=5)
        self.assertEqual(result.returncode, 7)

    def test_oversize_record_fails_receipt_without_advancing_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            collector = root / 'collector'
            collector.write_bytes(b'x' * (4 * 1024 * 1024) + b'\nnext\n')
            target = root / 'source'
            target.write_bytes(b'')
            from argparse import Namespace
            importer = root / 'importer.py'
            importer.write_text('raise AssertionError("must not import")')
            dsn = root / 'dsn'
            dsn.write_text('fixture')
            sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
            args = Namespace(source=str(target), state=str(root/'identity'), receipt=str(root/'receipt'),
                host='host', key='key', known_hosts='hosts', dsn_file=str(dsn), importer=str(importer),
                classification='classification', collector_hash=sha(HERE/'collector_segment.py'),
                transfer_hash=sha(HERE/'incremental_transfer.py'), importer_hash=sha(importer), ssh='ssh', max_segments=8)
            def segment(*values):
                from collector_segment import extract
                output = root / 'segment'
                metadata = extract(collector, values[4], output, expected_prefix=values[5])
                return metadata, output.read_bytes()
            with patch('recurring_import.read_segment', side_effect=segment):
                with self.assertRaisesRegex(ValueError, 'record exceeds'):
                    run(args)
            self.assertEqual(json.loads(Path(args.receipt).read_text())['status'], 'failed')
            self.assertEqual(target.read_bytes(), b'')
            self.assertFalse(Path(args.state).exists())
            self.assertEqual(collector.read_bytes()[-5:], b'next\n')

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

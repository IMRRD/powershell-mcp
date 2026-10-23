import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from incremental_transfer import append_verified


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = self.root / 'telemetry.jsonl'
        self.chunk = self.root / 'chunk'
        self.target.write_bytes(b'{"a":1}\n')
        self.identity = {'device': 9, 'inode': 42}

    def metadata(self, data, *, offset=None, prefix=None, identity=None):
        offset = self.target.stat().st_size if offset is None else offset
        return {'offset': offset, 'length': len(data),
                'prefix_sha256': prefix or hashlib.sha256(self.target.read_bytes()[:offset]).hexdigest(),
                'chunk_sha256': hashlib.sha256(data).hexdigest(),
                'device': (identity or self.identity)['device'], 'inode': (identity or self.identity)['inode']}

    def apply(self, data, **kwargs):
        self.chunk.write_bytes(data)
        return append_verified(self.target, self.chunk, self.metadata(data, **kwargs), self.root / 'identity.json')

    def test_append_and_replay_without_duplication(self):
        data = b'{"b":2}\n'
        metadata = self.metadata(data)
        self.chunk.write_bytes(data)
        state = self.root / 'identity.json'
        self.assertEqual(append_verified(self.target, self.chunk, metadata, state), 'appended')
        self.assertEqual(append_verified(self.target, self.chunk, metadata, state), 'already_present')
        self.assertEqual(self.target.read_bytes(), b'{"a":1}\n' + data)

    def test_rejects_changed_prefix_without_write(self):
        before = self.target.read_bytes()
        with self.assertRaises(ValueError):
            self.apply(b'{"b":2}\n', prefix='0' * 64)
        self.assertEqual(self.target.read_bytes(), before)

    def test_rejects_gap_and_truncation_without_write(self):
        before = self.target.read_bytes()
        with self.assertRaises(ValueError):
            self.apply(b'next\n', offset=len(before) + 1)
        self.assertEqual(self.target.read_bytes(), before)

    def test_rejects_source_identity_change(self):
        self.apply(b'next\n')
        before = self.target.read_bytes()
        with self.assertRaises(ValueError):
            self.apply(b'other\n', identity={'device': 9, 'inode': 43})
        self.assertEqual(self.target.read_bytes(), before)

    def test_rejects_incomplete_line_and_bad_hash(self):
        before = self.target.read_bytes()
        with self.assertRaises(ValueError):
            self.apply(b'partial')
        metadata = self.metadata(b'next\n')
        metadata['chunk_sha256'] = '0' * 64
        self.chunk.write_bytes(b'next\n')
        with self.assertRaises(ValueError):
            append_verified(self.target, self.chunk, metadata, self.root / 'identity.json')
        self.assertEqual(self.target.read_bytes(), before)

    def test_interrupted_append_can_replay_complete_suffix(self):
        data = b'next\n'
        metadata = self.metadata(data)
        self.chunk.write_bytes(data)
        with self.target.open('ab') as out:
            out.write(data[:2])
        self.assertEqual(append_verified(self.target, self.chunk, metadata, self.root / 'identity.json'), 'recovered')
        self.assertEqual(self.target.read_bytes(), b'{"a":1}\n' + data)


if __name__ == '__main__':
    unittest.main()

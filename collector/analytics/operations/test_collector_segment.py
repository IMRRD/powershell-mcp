import tempfile
import unittest
from pathlib import Path
from collector_segment import extract


class SegmentTests(unittest.TestCase):
    def test_overlimit_complete_record_is_not_eof(self):
        with tempfile.TemporaryDirectory() as d:
            source, output = Path(d) / 'source', Path(d) / 'segment'
            source.write_bytes(b'a' * (4 * 1024 * 1024) + b'\nnext\n')
            with self.assertRaisesRegex(ValueError, 'record exceeds'):
                extract(source, 0, output)
            self.assertFalse(output.exists())

    def test_partial_tail_and_actual_eof(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'source'
            source.write_bytes(b'one\npartial')
            self.assertEqual(extract(source, 0, Path(d) / 'first', 8)['length'], 4)
            with self.assertRaisesRegex(ValueError, 'incomplete trailing record'):
                extract(source, 4, Path(d) / 'tail', 8)
            self.assertEqual(extract(source, source.stat().st_size, Path(d) / 'eof')['length'], 0)

    def test_preceding_record_does_not_hide_overlimit_next_record(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'source'
            source.write_bytes(b'ok\n' + b'x' * (4 * 1024 * 1024) + b'\nnext\n')
            first = Path(d) / 'first'
            self.assertEqual(extract(source, 0, first)['length'], 3)
            with self.assertRaisesRegex(ValueError, 'record exceeds'):
                extract(source, 3, Path(d) / 'second')
            self.assertEqual(first.read_bytes(), b'ok\n')

    def test_bounded_complete_line_and_identity(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / 'source'
            source.write_bytes(b'a\nb\npartial')
            output = Path(d) / 'segment'
            metadata = extract(source, 0, output, 4)
            self.assertEqual(output.read_bytes(), b'a\nb\n')
            self.assertEqual(metadata['offset'], 0)
            self.assertEqual(metadata['length'], 4)
            self.assertEqual(metadata['inode'], source.stat().st_ino)
            with self.assertRaises(ValueError):
                extract(source, 20, output, 4)
            source.write_bytes(b'bad\nb\npartial')
            with self.assertRaises(ValueError):
                extract(source, 2, output, 4, expected_prefix='0' * 64)


if __name__ == '__main__':
    unittest.main()

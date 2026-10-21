import tempfile
import unittest
from pathlib import Path
from collector_segment import extract


class SegmentTests(unittest.TestCase):
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

#!/usr/bin/env python3
"""Read-only bounded complete-line collector snapshot. No payload printed."""
import argparse
import hashlib
import json
import os
from pathlib import Path

MAX_CHUNK = 4 * 1024 * 1024


def extract(source, offset, output, limit=MAX_CHUNK, expected_prefix=None):
    source, output = Path(source), Path(output)
    if not 0 <= offset or not 0 < limit <= MAX_CHUNK:
        raise ValueError('invalid bounds')
    with source.open('rb') as stream:
        before = os.fstat(stream.fileno())
        if offset > before.st_size:
            raise ValueError('collector truncated')
        prefix = hashlib.sha256()
        remaining = offset
        while remaining:
            block = stream.read(min(65536, remaining))
            if not block:
                raise ValueError('collector truncated while reading prefix')
            prefix.update(block)
            remaining -= len(block)
        if expected_prefix and prefix.hexdigest() != expected_prefix:
            raise ValueError('collector historical prefix changed')
        data = stream.read(min(limit, before.st_size - offset))
        complete = data.rfind(b'\n') + 1
        if not complete and data and before.st_size - offset > limit:
            raise ValueError('collector record exceeds segment limit')
        if not complete and data:
            raise ValueError('collector incomplete trailing record')
        data = data[:complete]
        after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or after.st_size < offset + len(data):
            raise ValueError('collector rotated or truncated during read')
    with output.open('xb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    return {'offset': offset, 'length': len(data), 'prefix_sha256': prefix.hexdigest(),
            'chunk_sha256': hashlib.sha256(data).hexdigest(), 'device': before.st_dev, 'inode': before.st_ino}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--offset', required=True, type=int)
    p.add_argument('--output', required=True)
    p.add_argument('--limit', type=int, default=MAX_CHUNK)
    p.add_argument('--expected-prefix')
    a = p.parse_args()
    print(json.dumps(extract(a.source, a.offset, a.output, a.limit, a.expected_prefix), sort_keys=True))

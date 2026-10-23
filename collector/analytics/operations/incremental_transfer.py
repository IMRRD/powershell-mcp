#!/usr/bin/env python3
"""Append a bounded collector segment without replacing the imported source inode.

Run under the same single-owner lock as the importer. The caller supplies a
complete-line snapshot and hashes computed at the collector, never raw logs.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re

SHA = re.compile(r'^[0-9a-f]{64}$')
MAX_CHUNK = 4 * 1024 * 1024


def digest(path, limit):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        while limit:
            block = stream.read(min(65536, limit))
            if not block:
                raise ValueError('short source prefix')
            h.update(block)
            limit -= len(block)
    return h.hexdigest()


def append_verified(target, chunk, metadata, state_path):
    target, chunk, state_path = Path(target), Path(chunk), Path(state_path)
    if set(metadata) != {'offset', 'length', 'prefix_sha256', 'chunk_sha256', 'device', 'inode'}:
        raise ValueError('invalid transfer metadata')
    offset, length = metadata['offset'], metadata['length']
    if any(type(metadata[k]) is not int or metadata[k] < 0 for k in ('offset', 'length', 'device', 'inode')):
        raise ValueError('invalid transfer bounds')
    if not 0 < length <= MAX_CHUNK or any(not isinstance(metadata[k], str) or not SHA.fullmatch(metadata[k]) for k in ('prefix_sha256', 'chunk_sha256')):
        raise ValueError('invalid transfer hashes or length')
    if chunk.stat().st_size != length or digest(chunk, length) != metadata['chunk_sha256']:
        raise ValueError('chunk changed')
    with chunk.open('rb') as stream:
        stream.seek(-1, os.SEEK_END)
        if stream.read(1) != b'\n':
            raise ValueError('incomplete source record')
    identity = {k: metadata[k] for k in ('device', 'inode')}
    if state_path.exists() and json.loads(state_path.read_text()) != identity:
        raise ValueError('collector inode changed; reconcile manually')
    size = target.stat().st_size
    if size < offset or size > offset + length or digest(target, offset) != metadata['prefix_sha256']:
        raise ValueError('target prefix differs or source gap')
    if size > offset:
        with target.open('rb') as current, chunk.open('rb') as incoming:
            current.seek(offset)
            remaining = size - offset
            while remaining:
                n = min(65536, remaining)
                if current.read(n) != incoming.read(n):
                    raise ValueError('interrupted append has different bytes')
                remaining -= n
    if size == offset + length:
        result = 'already_present'
    else:
        with chunk.open('rb') as incoming, target.open('ab') as out:
            incoming.seek(size - offset)
            while block := incoming.read(65536):
                out.write(block)
            out.flush()
            os.fsync(out.fileno())
        result = 'recovered' if size > offset else 'appended'
    if not state_path.exists():
        tmp = state_path.with_name(state_path.name + '.tmp')
        with tmp.open('x') as out:
            json.dump(identity, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, state_path)
    return result


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--chunk', required=True)
    p.add_argument('--metadata', required=True)
    p.add_argument('--identity', required=True)
    a = p.parse_args()
    print(append_verified(a.source, a.chunk, json.loads(Path(a.metadata).read_text()), a.identity))

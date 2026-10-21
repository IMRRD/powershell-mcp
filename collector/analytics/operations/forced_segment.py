#!/usr/bin/env python3
"""Forced-command-only, read-only SSH endpoint on collector.

Install immutable reviewed bytes and configure ANALYTICS_COLLECTOR_SOURCE in the
root-controlled wrapper. Ignore SSH_ORIGINAL_COMMAND entirely.
"""
import json
import os
from pathlib import Path
import sys
import tempfile

from collector_segment import extract, MAX_CHUNK


def serve(source, input_stream, output_stream):
    request = input_stream.readline(1025)
    if len(request) > 1024 or not request.endswith(b'\n') or input_stream.read(1):
        raise ValueError('invalid request size')
    payload = json.loads(request)
    if set(payload) != {'offset', 'limit', 'expected_prefix'} or type(payload['offset']) is not int or type(payload['limit']) is not int or not 0 <= payload['offset'] or not 0 < payload['limit'] <= MAX_CHUNK or not isinstance(payload['expected_prefix'], str) or len(payload['expected_prefix']) != 64:
        raise ValueError('invalid request')
    with tempfile.TemporaryDirectory() as temp:
        segment = Path(temp) / 'segment'
        metadata = extract(source, payload['offset'], segment, payload['limit'], payload['expected_prefix'])
        output_stream.write(json.dumps(metadata, sort_keys=True).encode() + b'\n')
        with segment.open('rb') as stream:
            while block := stream.read(65536):
                output_stream.write(block)
        output_stream.flush()


if __name__ == '__main__':
    try:
        serve(os.environ['ANALYTICS_COLLECTOR_SOURCE'], sys.stdin.buffer, sys.stdout.buffer)
    except Exception as exc:
        print('segment request failed: ' + type(exc).__name__, file=sys.stderr)
        sys.exit(1)

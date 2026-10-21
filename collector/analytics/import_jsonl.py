#!/usr/bin/env python
"""Private, restartable JSONL -> PostgreSQL importer; never emits source contents."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from datetime import datetime

import psycopg

UTC = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')
VERSION = re.compile(r'^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$')
OS = {'win32', 'linux', 'darwin', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'}
TOOLS = {'run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program', 'runtime_capabilities', 'start_execution', 'execution_status', 'read_execution_output', 'cancel_execution', 'read_output_log', 'delete_output_log'}
AXES = {'outcomes': {'success', 'nonzero', 'error', 'timeout', 'cancelled', 'unknown'}, 'durations': {'lt100', 'lt1000', 'lt10000', 'gte10000'}, 'features': {'execution', 'inspection', 'remote', 'transfer', 'lifecycle', 'logs'}}
MAX_COUNT = 9007199254740991


def classes(path):
    c = json.loads(Path(path).read_text())
    if set(c) != {'internalHostIds', 'testHostIds'}:
        raise ValueError('invalid classification')
    a, b = c['internalHostIds'], c['testHostIds']
    if any(not isinstance(x, str) or not x or len(x) > 256 for x in a + b) or len(set(a)) != len(a) or len(set(b)) != len(b) or set(a) & set(b):
        raise ValueError('invalid classification')
    return set(a), set(b)


def timestamp(s):
    if not isinstance(s, str) or not UTC.fullmatch(s):
        return None
    try:
        return s if datetime.fromisoformat(s.replace('Z', '+00:00')).isoformat(timespec='milliseconds').replace('+00:00', 'Z') == s else None
    except ValueError:
        return None


def quality(value):
    return 'missing' if value is None else 'valid' if timestamp(value) else 'invalid'


def valid_count(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_COUNT


def metric_axes(value):
    if not isinstance(value, dict) or set(value) != set(AXES):
        raise ValueError('invalid metric axes')
    totals = []
    for axis, allowed in AXES.items():
        buckets = value[axis]
        if not isinstance(buckets, dict) or not buckets or any(k not in allowed or not valid_count(n) for k, n in buckets.items()):
            raise ValueError('invalid metric axis')
        totals.append(sum(buckets.values()))
    if totals[0] > MAX_COUNT or len(set(totals)) != 1:
        raise ValueError('inconsistent metric totals')
    return totals[0]


def ingest(db, source, classification):
    internal, test = classes(classification)
    source = Path(source).resolve(strict=True)
    stat = source.stat()
    source_key = hashlib.sha256(str(source).encode()).hexdigest()
    inserted = 0
    with db.transaction():
        # Serialize same-source importers without exposing source identities in logs.
        db.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', (source_key,))
        previous = db.execute('SELECT device,inode,position,prefix_hash FROM telemetry_checkpoint WHERE source_key=%s FOR UPDATE', (source_key,)).fetchone()
        position = previous[2] if previous else 0
        if previous and (previous[0] != stat.st_dev or previous[1] != stat.st_ino or stat.st_size < position):
            raise ValueError('source replaced or truncated; reconciliation required')
        with source.open('rb') as f:
            prefix = hashlib.sha256()
            remaining = position
            while remaining:
                block = f.read(min(65536, remaining))
                if not block:
                    raise ValueError('missing historical prefix')
                prefix.update(block)
                remaining -= len(block)
            if previous and prefix.hexdigest() != previous[3]:
                raise ValueError('historical prefix changed')
            while True:
                start = f.tell()
                line = f.readline(32769)
                if not line:
                    break
                if len(line) > 32768:
                    raise ValueError('oversized record')
                if not line.endswith(b'\n'):
                    break  # uncommitted tail; retry after writer completes it
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError('invalid record')
                host = row.get('hostId')
                origin = 'internal' if isinstance(host, str) and host in internal else 'test' if isinstance(host, str) and host in test else 'unknown_origin'
                safe_host = host if isinstance(host, str) and 0 < len(host) <= 256 else None
                event = row.get('event') if row.get('event') in ('startup', 'tool_counts', 'tool_metrics') else 'historical_other'
                event_id = row.get('eventId')
                if event_id is not None and not (isinstance(event_id, str) and str(uuid.UUID(event_id)) == event_id):
                    raise ValueError('invalid event identifier')
                key = 'id:' + event_id if event_id else 'source:' + source_key + ':' + str(start)
                payload_hash = hashlib.sha256(line.rstrip(b'\r\n')).hexdigest()
                received = timestamp(row.get('_receivedAt'))
                version = row.get('version')
                safe = {'schemaVersion': row.get('schemaVersion') if isinstance(row.get('schemaVersion'), int) else None}
                result = db.execute('INSERT INTO telemetry_event(event_key,payload_hash,origin,installation_key,event,event_at,received_at,version_bucket,os_bucket,raw,event_time_quality,receipt_time_quality) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(event_key) DO NOTHING RETURNING event_key', (key, payload_hash, origin, hashlib.sha256(safe_host.encode()).hexdigest() if safe_host else None, event, timestamp(row.get('ts')), received, version if isinstance(version, str) and VERSION.fullmatch(version) else 'other', row.get('os') if row.get('os') in OS else 'other', json.dumps(safe), quality(row.get('ts')), quality(row.get('_receivedAt')))).fetchone()
                if not result:
                    old = db.execute('SELECT payload_hash FROM telemetry_event WHERE event_key=%s', (key,)).fetchone()
                    if old[0] != payload_hash:
                        raise ValueError('event collision')
                else:
                    inserted += 1
                    if event in ('tool_counts', 'tool_metrics'):
                        data = row.get('counts') if event == 'tool_counts' else row.get('metrics')
                        if not isinstance(data, dict):
                            raise ValueError('invalid tool map')
                        for tool, value in data.items():
                            if tool not in TOOLS:
                                raise ValueError('invalid tool')
                            calls = value if event == 'tool_counts' else metric_axes(value)
                            if not valid_count(calls):
                                raise ValueError('invalid calls')
                            db.execute('INSERT INTO telemetry_tool VALUES (%s,%s,%s,%s)', (key, 'counts' if event == 'tool_counts' else 'metrics', tool, calls))
                            if event == 'tool_metrics':
                                for axis, buckets in value.items():
                                    for bucket, count in buckets.items():
                                        db.execute('INSERT INTO telemetry_metric_axis VALUES (%s,%s,%s,%s,%s)', (key, tool, axis, bucket, count))
                prefix.update(line)
                position = f.tell()
        db.execute('INSERT INTO telemetry_checkpoint(source_key,device,inode,position,prefix_hash) VALUES (%s,%s,%s,%s,%s) ON CONFLICT(source_key) DO UPDATE SET device=excluded.device,inode=excluded.inode,position=excluded.position,prefix_hash=excluded.prefix_hash,imported_at=now()', (source_key, stat.st_dev, stat.st_ino, position, prefix.hexdigest()))
    return inserted


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('--source', required=True)
    p.add_argument('--classification', required=True)
    a = p.parse_args()
    with psycopg.connect(os.environ['ANALYTICS_DSN']) as db:
        print('inserted:', ingest(db, a.source, a.classification))

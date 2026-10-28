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
TOOLS = {'run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program', 'runtime_capabilities', 'start_execution', 'execution_status', 'read_execution_output', 'cancel_execution', 'read_output_log', 'delete_output_log', 'start_remote_batch', 'remote_batch_status', 'cancel_remote_batch'}
AXES = {'outcomes': {'success', 'nonzero', 'error', 'timeout', 'cancelled', 'unknown'}, 'durations': {'lt100', 'lt1000', 'lt10000', 'gte10000'}, 'features': {'execution', 'inspection', 'remote', 'transfer', 'lifecycle', 'logs'}}
MAX_COUNT = 9007199254740991
WINRM_REASONS = {'completed', 'remote_script_error', 'authentication_exception', 'access_exception', 'remoting_transport_exception', 'invoke_exception', 'wrapper_result_invalid', 'frame_invalid', 'frame_body_invalid', 'local_host_error', 'local_launch_error', 'timeout', 'cancelled', 'unknown'}


def classes(path):
    if Path(path).stat().st_size > 1024 * 1024:
        raise ValueError('classification too large')
    c = json.loads(Path(path).read_text())
    if set(c) not in ({'internalHostIds', 'testHostIds'}, {'internalHostIds', 'testHostIds', 'enrollments'}):
        raise ValueError('invalid classification')
    a, b = c['internalHostIds'], c['testHostIds']
    if not isinstance(a, list) or not isinstance(b, list) or len(a) + len(b) > 10000:
        raise ValueError('invalid classification')
    if any(not isinstance(x, str) or not x or len(x) > 256 for x in a + b) or len(set(a)) != len(a) or len(set(b)) != len(b) or set(a) & set(b):
        raise ValueError('invalid classification')
    enrollments = c.get('enrollments', [])
    if not isinstance(enrollments, list) or len(a) + len(b) + len(enrollments) > 10000:
        raise ValueError('invalid classification')
    seen = set(a + b)
    for entry in enrollments:
        if not isinstance(entry, dict) or set(entry) != {'hostId', 'cohort', 'fromReceiptUtc'} or not isinstance(entry['hostId'], str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', entry['hostId']) or entry['hostId'] in seen or entry['cohort'] not in ('internal', 'test') or not timestamp(entry['fromReceiptUtc']):
            raise ValueError('invalid enrollment')
        seen.add(entry['hostId'])
    return set(a), set(b), {e['hostId']: e for e in enrollments}


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


def metric_axes(value, tool=None):
    if not isinstance(value, dict) or set(value) not in (set(AXES), set(AXES) | {'winrmReasons'}):
        raise ValueError('invalid metric axes')
    totals = []
    for axis, allowed in AXES.items():
        buckets = value[axis]
        if not isinstance(buckets, dict) or not buckets or any(k not in allowed or not valid_count(n) for k, n in buckets.items()):
            raise ValueError('invalid metric axis')
        totals.append(sum(buckets.values()))
    if totals[0] > MAX_COUNT or len(set(totals)) != 1:
        raise ValueError('inconsistent metric totals')
    if 'winrmReasons' in value:
        buckets = value['winrmReasons']
        if tool != 'winrm_exec' or not isinstance(buckets, dict) or not buckets or any(k not in WINRM_REASONS or not valid_count(n) for k, n in buckets.items()) or sum(buckets.values()) != totals[0]:
            raise ValueError('invalid WinRM reasons')
    return totals[0]


def ingest(db, source, classification):
    internal, test, enrollments = classes(classification)
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
                enrollment = enrollments.get(host) if isinstance(host, str) else None
                if enrollment and timestamp(row.get('_receivedAt')) and row['_receivedAt'] >= enrollment['fromReceiptUtc']:
                    origin = enrollment['cohort']
                if 'cohort' in row and row['cohort'] != 'external_self_declared':
                    raise ValueError('invalid cohort')
                if row.get('cohort') == 'external_self_declared':
                    origin = 'external_self_declared' if origin == 'unknown_origin' else 'cohort_conflict'
                user = row.get('userId')
                if 'userId' in row and (not isinstance(user, str) or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', user)):
                    raise ValueError('invalid user pseudonym')
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
                    if user:
                        db.execute('UPDATE telemetry_event SET user_key=%s WHERE event_key=%s', (hashlib.sha256(('powershell-mcp-user-v1:' + user).encode()).hexdigest(), key))
                    if event in ('tool_counts', 'tool_metrics'):
                        data = row.get('counts') if event == 'tool_counts' else row.get('metrics')
                        if not isinstance(data, dict):
                            raise ValueError('invalid tool map')
                        for tool, value in data.items():
                            if tool not in TOOLS:
                                raise ValueError('invalid tool')
                            calls = value if event == 'tool_counts' else metric_axes(value, tool)
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
    try:
        with psycopg.connect(os.environ['ANALYTICS_DSN']) as db:
            print('inserted:', ingest(db, a.source, a.classification))
    except Exception:
        # Database/source exceptions can embed identifiers or credentials.
        import sys
        print('Import failed; transaction rolled back. Inspect protected inputs and database availability.', file=sys.stderr)
        sys.exit(1)

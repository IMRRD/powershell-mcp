#!/usr/bin/env python3
"""Single-owner, fail-closed analytics recurrence; install disabled pending review.

Run on the PostgreSQL host. SSH is a dedicated forced-command read-only
collector account: stdin is a bounded JSON request, stdout is one JSON header
followed by exactly length binary bytes. No shell command is supplied by caller.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
try:
    import fcntl
except ImportError:  # Fixture runner on Windows; production host uses POSIX flock.
    fcntl = None
    import msvcrt
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from incremental_transfer import append_verified, digest, MAX_CHUNK

HERE = Path(__file__).resolve().parent


def bounded_process(command, payload, *, stdout_limit, stderr_limit, timeout, env=None):
    """Drain both pipes concurrently, killing and reaping on overflow or timeout."""
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, env=env)
    buffers = [bytearray(), bytearray()]
    limits = [stdout_limit, stderr_limit]
    overflow = threading.Event()
    write_error = threading.Event()

    def drain(pipe, index):
        try:
            while block := pipe.read(4096):
                remaining = limits[index] - len(buffers[index])
                buffers[index].extend(block[:max(0, remaining)])
                if len(block) > remaining:
                    overflow.set()
                    child.kill()
                    break
        except OSError:
            overflow.set()
        finally:
            pipe.close()

    def feed():
        try:
            child.stdin.write(payload)
            child.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            write_error.set()

    readers = [threading.Thread(target=drain, args=(pipe, i), daemon=True)
               for i, pipe in enumerate((child.stdout, child.stderr))]
    writer = threading.Thread(target=feed, daemon=True)
    for reader in readers:
        reader.start()
    writer.start()
    deadline = time.monotonic() + timeout
    try:
        try:
            child.wait(timeout=max(0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise TimeoutError('child timed out') from None
        writer.join(timeout=max(0, deadline - time.monotonic()))
        for reader in readers:
            reader.join(timeout=max(0, deadline - time.monotonic()))
        if overflow.is_set():
            raise RuntimeError('child output limit exceeded')
        if writer.is_alive() or write_error.is_set() or any(r.is_alive() for r in readers):
            raise RuntimeError('child I/O incomplete')
        return subprocess.CompletedProcess(command, child.returncode, bytes(buffers[0]), bytes(buffers[1]))
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        writer.join(timeout=1)
        for reader in readers:
            reader.join(timeout=1)
        if not writer.is_alive() and not child.stdin.closed:
            child.stdin.close()


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.receipt-', delete=False) as out:
        json.dump(value, out, sort_keys=True)
        out.flush()
        os.fsync(out.fileno())
        temporary = out.name
    os.replace(temporary, path)


@contextmanager
def single_owner(path):
    with open(path, 'a+b') as lock:
        try:
            if fcntl is None:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, OSError):
            raise RuntimeError('another recurrence is running') from None
        yield


def read_segment(ssh, host, key, known_hosts, offset, prefix):
    command = [ssh, '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
               '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1',
               '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
               '-o', 'IdentitiesOnly=yes', '-o', 'UserKnownHostsFile=' + known_hosts,
               '-i', key, host, 'segment-v1']
    request = json.dumps({'offset': offset, 'limit': MAX_CHUNK, 'expected_prefix': prefix}).encode() + b'\n'
    result = bounded_process(command, request, stdout_limit=MAX_CHUNK + 1024, stderr_limit=4096, timeout=90)
    if result.returncode:
        raise RuntimeError('collector transport failed')
    header, separator, chunk = result.stdout.partition(b'\n')
    if not separator or len(header) > 1024:
        raise ValueError('invalid collector response')
    metadata = json.loads(header)
    if set(metadata) != {'offset', 'length', 'prefix_sha256', 'chunk_sha256', 'device', 'inode'}:
        raise ValueError('invalid collector metadata')
    if type(metadata['length']) is not int or not 0 <= metadata['length'] <= MAX_CHUNK or len(chunk) != metadata['length']:
        raise ValueError('invalid collector response length')
    if metadata['offset'] != offset or metadata['prefix_sha256'] != prefix or hashlib.sha256(chunk).hexdigest() != metadata['chunk_sha256']:
        raise ValueError('collector response mismatch')
    return metadata, chunk


def run(args):
    source = Path(args.source)
    if not source.is_file() or source.is_symlink():
        raise ValueError('installed source missing or symlink')
    state = Path(args.state)
    if source.parent != state.parent:
        raise ValueError('source and state must share protected directory')
    with single_owner(str(state) + '.lock'):
        receipt_path = Path(args.receipt)
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        receipt.setdefault('first_attempt', now())
        receipt.update(last_attempt=now(), status='unknown', last_error=None)
        atomic_json(receipt_path, receipt)
        try:
            for path, expected in ((HERE / 'collector_segment.py', args.collector_hash),
                                   (HERE / 'incremental_transfer.py', args.transfer_hash),
                                   (Path(args.importer), args.importer_hash)):
                if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                    raise ValueError('reviewed code hash mismatch')
            for _ in range(args.max_segments):
                offset = source.stat().st_size
                prefix = digest(source, offset)
                metadata, chunk = read_segment(args.ssh, args.host, args.key, args.known_hosts, offset, prefix)
                if metadata['length'] == 0:
                    if chunk:
                        raise ValueError('invalid empty response')
                    break
                with tempfile.TemporaryDirectory(dir=source.parent) as temp:
                    payload = Path(temp) / 'segment'
                    payload.write_bytes(chunk)
                    append_verified(source, payload, metadata, state)

            else:
                raise RuntimeError('segment budget exhausted; retry next cycle')
            env = dict(os.environ)
            env['ANALYTICS_DSN'] = Path(args.dsn_file).read_text().strip()
            result = bounded_process([sys.executable, args.importer, '--source', str(source),
                                     '--classification', args.classification], env=env,
                                    payload=b'', stdout_limit=65536, stderr_limit=4096, timeout=300)
            if result.returncode:
                raise RuntimeError('reviewed importer failed')
            receipt.update(status='success', last_success=now(), last_error=None)
            atomic_json(receipt_path, receipt)
            return 0
        except Exception as exc:
            receipt.update(status='failed', last_error=type(exc).__name__)
            atomic_json(receipt_path, receipt)
            raise


def main():
    p = argparse.ArgumentParser()
    for field in ('source', 'state', 'receipt', 'host', 'key', 'known-hosts', 'dsn-file', 'importer', 'classification', 'collector-hash', 'transfer-hash', 'importer-hash'):
        p.add_argument('--' + field, required=True)
    p.add_argument('--ssh', default='ssh')
    p.add_argument('--max-segments', type=int, default=8)
    args = p.parse_args()
    if not 1 <= args.max_segments <= 8:
        p.error('invalid segment budget')
    try:
        return run(args)
    except Exception as exc:
        print('analytics recurrence failed: ' + type(exc).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

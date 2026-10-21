#!/usr/bin/env python3
"""Fail-closed private database backup; staged, read-back verified SFTP publication."""
import argparse
from datetime import datetime, timezone
try:
    import fcntl
except ImportError:  # Windows fixture runner; production requires Linux flock.
    fcntl = None
    import msvcrt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

CLEANUP_MARGIN_SECONDS = 120


def remaining(deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError('private backup deadline expired')
    return seconds


def sha(path, deadline=None):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        while True:
            if deadline is not None:
                remaining(deadline)
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def run_command(argv, timeout, *, stdout=None, stdin=None):
    result = subprocess.run(argv, stdin=stdin, stdout=stdout or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode:
        raise RuntimeError('command failed: ' + Path(argv[0]).name)
    return result


def sync_directory(directory):
    """Durably publish the rename on POSIX; Windows fixture runs lack directory fsync."""
    if os.name == 'nt':
        return
    fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.receipt-', delete=False) as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, path)
    sync_directory(path.parent)


def transfer(args, local, remote, deadline):
    # SFTP uses a restricted account rooted at its private backup directory.
    # Retrieval before rename detects truncation/corruption. Unique names retain
    # the last successfully published dump even if this attempt is interrupted.
    staged = remote + '.part'
    base = [args.sftp, '-b', '-', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
            '-oConnectTimeout=10', '-oServerAliveInterval=10', '-oServerAliveCountMax=2',
            '-oIdentitiesOnly=yes', '-oUserKnownHostsFile=' + args.known_hosts,
            '-i', args.key, args.host]
    def batch(lines):
        with subprocess_input(lines) as request:
            run_command(base, min(args.transfer_timeout, remaining(deadline)), stdin=request)
    # subprocess_input is a context manager: no remote shell, no general transport framework.
    batch(['put "' + str(local) + '" "' + staged + '"'])
    with tempfile.TemporaryDirectory(dir=args.directory) as td:
        check = Path(td) / 'readback.dump'
        batch(['get "' + staged + '" "' + str(check) + '"'])
        if check.stat().st_size != local.stat().st_size or sha(check, deadline) != sha(local, deadline):
            raise ValueError('off-host readback hash mismatch')
    batch(['rename "' + staged + '" "' + remote + '"'])
    with tempfile.TemporaryDirectory(dir=args.directory) as td:
        check = Path(td) / 'published.dump'
        batch(['get "' + remote + '" "' + str(check) + '"'])
        if check.stat().st_size != local.stat().st_size or sha(check, deadline) != sha(local, deadline):
            raise ValueError('published readback hash mismatch')


class subprocess_input:
    def __init__(self, lines):
        self.payload = ('\n'.join(lines) + '\n').encode()
    def __enter__(self):
        self.file = tempfile.TemporaryFile()
        self.file.write(self.payload)
        self.file.seek(0)
        return self.file
    def __exit__(self, *_):
        self.file.close()


def run(args):
    directory = Path(args.directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('unsafe state directory')
    with open(directory / '.backup.lock', 'a+b') as lock:
        if fcntl is None:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        receipt_path = directory / 'latest-attempt.json'
        receipt = {'status': 'unknown', 'attempt_utc': datetime.now(timezone.utc).isoformat()}
        atomic_json(receipt_path, receipt)
        try:
            deadline = time.monotonic() + getattr(args, 'total_timeout', 900)
            remaining(deadline)
            for path, expected in ((args.schema, args.schema_sha256), (args.roles, args.roles_sha256)):
                if sha(path, deadline) != expected:
                    raise ValueError('reviewed restore source mismatch')
            if shutil.disk_usage(directory).free < args.min_free_bytes:
                raise OSError('insufficient local capacity')
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            name = 'private-analytics-' + stamp + '-' + os.urandom(4).hex() + '.dump'
            remote = args.remote_dir.rstrip('/') + '/' + name
            if not re.fullmatch(r'[A-Za-z0-9_./-]+', remote) or '..' in Path(remote).parts:
                raise ValueError('unsafe remote path')
            with tempfile.TemporaryDirectory(dir=directory, prefix='.attempt-') as td:
                dump = Path(td) / name
                with open(dump, 'wb') as output:
                    run_command([args.pg_dump, '--format=custom', '--no-owner', '--no-acl',
                                 '--dbname=' + args.database], min(args.dump_timeout, remaining(deadline)), stdout=output)
                    output.flush()
                    os.fsync(output.fileno())
                if dump.stat().st_size < 1024:
                    raise ValueError('empty or implausibly small dump')
                checksum = sha(dump, deadline)
                transfer(args, dump, remote, deadline)
                remaining(deadline)
                receipt.update(status='success', completed_utc=datetime.now(timezone.utc).isoformat(),
                               remote=remote, size=dump.stat().st_size, sha256=checksum,
                               schema_sha256=args.schema_sha256, roles_sha256=args.roles_sha256)
                atomic_json(receipt_path, receipt)
            return receipt
        except Exception as exc:
            receipt.update(status='failed', error=type(exc).__name__)
            atomic_json(receipt_path, receipt)
            raise


def main():
    p = argparse.ArgumentParser()
    for field in ('directory', 'database', 'host', 'key', 'known-hosts', 'remote-dir',
                  'schema', 'schema-sha256', 'roles', 'roles-sha256'):
        p.add_argument('--' + field, required=True)
    p.add_argument('--pg-dump', default='/usr/bin/pg_dump')
    p.add_argument('--sftp', default='/usr/bin/sftp')
    p.add_argument('--total-timeout', type=int, default=900)
    p.add_argument('--dump-timeout', type=int, default=600)
    p.add_argument('--transfer-timeout', type=int, default=300)
    p.add_argument('--min-free-bytes', type=int, default=104857600)
    args = p.parse_args()
    try:
        print(json.dumps(run(args), sort_keys=True))
        return 0
    except Exception as exc:
        print('private analytics backup failed: ' + type(exc).__name__, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())

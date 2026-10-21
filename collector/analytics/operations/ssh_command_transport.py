#!/usr/bin/env python3
"""Controller-side bounded, single-shot SSH command transport."""
import json
from pathlib import Path
import subprocess
import threading
import time

HELPER = Path(__file__).with_name('ssh_command_helper.py')
REMOTE_COMMAND = 'sudo -n -- /opt/analytics-reviewed/bin/helper'
LIMIT = 65536
# Frozen from reviewed source, never supplied by the target.
REVIEWED_BLOBS = {
    'operations/activate_private.py': '889d12a121c20e75a378733c1a58f1eeb2f7d4aee882312931cc31a18cee4d15',
    'operations/prepare-private-activation.py': '20610d9cb07eb4771bb6b483996bd018a6e2b27787ea9e6580502eb1dfa0d684',
    'schema.sql': 'c653108c38e332e699b49f9a785168602a2e48e08c345f10869c5bf7b9d67aba',
    'roles.sql': 'defd6234b8ada49a66c8ae8731928f8ffb6cbc941266efd9c9034c4ccfc3a33f',
    'queries.sql': 'e89ab1db5354ab037d381e90c0f6697a20e7249738c510af381f8a089e0467d5',
    'dashboard.json': 'c7cffdaf81ea1f3b4b9afbac56b453113d6f0ab856d2d91a7da14a1f536c65a9',
}


class UnknownOutcome(RuntimeError):
    pass


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate response field')
        result[key] = value
    return result


def _bounded_process(argv, payload, *, timeout=60):
    """Drain Windows pipes concurrently without retaining unbounded output."""
    try:
        child = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE)
    except OSError:
        raise UnknownOutcome('SSH outcome unknown; reconcile before retry') from None
    output = [bytearray(), bytearray()]
    overflow = threading.Event()
    lock = threading.Lock()
    def drain(pipe, index):
        try:
            while True:
                chunk = pipe.read(4096)
                if not chunk:
                    break
                with lock:
                    remaining = LIMIT - len(output[0]) - len(output[1])
                    output[index].extend(chunk[:max(0, remaining)])
                    if len(chunk) > remaining:
                        overflow.set()
                        if child.poll() is None:
                            child.kill()
                        break
        except OSError:
            overflow.set()
        finally:
            pipe.close()
    readers = [threading.Thread(target=drain, args=(pipe, i), daemon=True)
               for i, pipe in enumerate((child.stdout, child.stderr))]
    write_error = threading.Event()
    def feed():
        try:
            child.stdin.write(payload)
            child.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            write_error.set()
    writer = threading.Thread(target=feed, daemon=True)
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    writer.start()
    try:
        child.wait(timeout=max(0, deadline - time.monotonic()))
        writer.join(timeout=max(0, deadline - time.monotonic()))
        for reader in readers:
            reader.join(timeout=max(0, deadline - time.monotonic()))
        if overflow.is_set() or writer.is_alive() or write_error.is_set() or any(reader.is_alive() for reader in readers):
            raise UnknownOutcome('SSH outcome unknown; reconcile before retry')
        return subprocess.CompletedProcess(argv, child.returncode, bytes(output[0]), bytes(output[1]))
    except (subprocess.TimeoutExpired, OSError):
        raise UnknownOutcome('SSH outcome unknown; reconcile before retry') from None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        writer.join(timeout=1)
        if not writer.is_alive() and not child.stdin.closed:
            child.stdin.close()
        for reader in readers:
            reader.join(timeout=1)


def execute(host, identity_file, request):
    if not isinstance(request, dict) or request.get('operation') not in ('pg', 'grafana', 'activation', 'attest'):
        raise ValueError('invalid operation')
    body = json.dumps(request, separators=(',', ':')).encode()
    if len(body) > 65536:
        raise ValueError('request too large')
    argv = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
            '-i', str(identity_file), host, REMOTE_COMMAND]
    result = _bounded_process(argv, body)
    if result.returncode or len(result.stdout) > 65536 or len(result.stderr) > 65536:
        raise UnknownOutcome('SSH outcome unknown; reconcile before retry')
    try:
        response = json.loads(result.stdout, object_pairs_hook=_unique_pairs)
        if not response['ok'] and response.get('error') == 'unsupported DeleteCollection' and request.get('action') == 'delete' and request.get('key') == 'org':
            raise RuntimeError('Grafana org deletion: unsupported DeleteCollection (HTTP 500)')
        if not response['ok'] or not isinstance(response['result'], dict):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise UnknownOutcome('SSH response invalid; reconcile before retry') from None
    return response['result']

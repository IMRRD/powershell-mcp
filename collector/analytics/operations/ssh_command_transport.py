#!/usr/bin/env python3
"""Controller-side bounded, single-shot SSH command transport."""
import json
from pathlib import Path
import subprocess

HELPER = Path(__file__).with_name('ssh_command_helper.py')
REMOTE_COMMAND = "python3 -c 'import sys; n=int(sys.stdin.buffer.readline()); exec(compile(sys.stdin.buffer.read(n),\"<reviewed-helper>\",\"exec\"))'"


class UnknownOutcome(RuntimeError):
    pass


def execute(host, identity_file, request):
    if not isinstance(request, dict) or request.get('operation') not in ('pg', 'grafana', 'activation'):
        raise ValueError('invalid operation')
    script = HELPER.read_bytes()
    body = json.dumps(request, separators=(',', ':')).encode()
    if len(body) > 65536 or len(script) > 65536:
        raise ValueError('request or helper too large')
    argv = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
            '-i', str(identity_file), host, REMOTE_COMMAND]
    try:
        result = subprocess.run(argv, input=str(len(script)).encode() + b'\n' + script + body,
                                capture_output=True, timeout=60, check=False)
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise UnknownOutcome('SSH outcome unknown; reconcile before retry') from None
    if result.returncode or len(result.stdout) > 65536 or len(result.stderr) > 65536:
        raise UnknownOutcome('SSH outcome unknown; reconcile before retry')
    try:
        response = json.loads(result.stdout)
        if not response['ok'] and response.get('error') == 'unsupported DeleteCollection' and request.get('action') == 'delete' and request.get('key') == 'org':
            raise RuntimeError('Grafana org deletion: unsupported DeleteCollection (HTTP 500)')
        if not response['ok'] or not isinstance(response['result'], dict):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise UnknownOutcome('SSH response invalid; reconcile before retry') from None
    return response['result']

#!/usr/bin/env python3
"""Stage reviewed bytes only; no analytics resources or credentials are installed."""
import argparse
import hashlib
import json
import shlex
from pathlib import Path
import subprocess
import tempfile

from ssh_command_transport import REVIEWED_BLOBS

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SOURCE = {'operations/ssh_command_helper.py': HERE / 'ssh_command_helper.py',
          **{key: ROOT / key for key in REVIEWED_BLOBS}}
REVIEWED_COMMIT = 'cf86def716ba36fc6724f655a52e4bc20e2272ab'
HELPER_DIGEST = '143d39ceb8e2c08339b2d0bc44de760637f8edc7a2c2ed03c87392be7a09acfa'


def reviewed_bytes(relative):
    commit = 'HEAD' if relative == 'operations/ssh_command_helper.py' else REVIEWED_COMMIT
    return subprocess.check_output(['git', 'show', f'{commit}:collector/analytics/{relative}'], cwd=ROOT.parent.parent)


def check_source():
    for key, digest in {'operations/ssh_command_helper.py': HELPER_DIGEST, **REVIEWED_BLOBS}.items():
        if hashlib.sha256(reviewed_bytes(key)).hexdigest() != digest:
            raise ValueError(f'reviewed source drift: {key}')


def render_launcher():
    template = (HERE / 'installed_launcher.py').read_text()
    return (template.replace('__HELPER_SHA256__', hashlib.sha256(reviewed_bytes('operations/ssh_command_helper.py')).hexdigest())
            .replace('__REVIEWED_BLOBS__', repr(REVIEWED_BLOBS)).encode())


def run(argv, *, data=None):
    subprocess.run(argv, input=data, check=True)


def install(host, identity, backend):
    check_source()
    ssh = ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', identity, host]
    scp = ['scp', '-q', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-i', identity]
    # A fixed staging path is safe because only sudo install copies data into the root-owned tree;
    # the installer reads back and hashes the protected copies before reporting success.
    staging = '/home/aegis/.analytics-reviewed-stage-42'
    run(ssh + [f'umask 077; mkdir -p {staging}/operations {staging}/bin'])
    with tempfile.TemporaryDirectory() as temp:
        launcher = Path(temp) / 'helper'
        launcher.write_bytes(render_launcher())
        configuration = Path(temp) / 'config.json'
        configuration.write_text(json.dumps({'backend': backend, 'config_file': '/opt/analytics-reviewed/target.json',
                                             **({'pg_service': 'telemetry_storage_postgres'} if backend == 'pg' else {})}))
        # Placeholder permits read-only attestation, not activation. Operator must separately
        # provision target-local secret paths/approved administrator after review.
        target = Path(temp) / 'target.json'
        target.write_text('{}')
        for relative in SOURCE:
            staged = Path(temp) / relative
            staged.parent.mkdir(parents=True, exist_ok=True)
            staged.write_bytes(reviewed_bytes(relative))
            run(scp + [str(staged), f'{host}:{staging}/{relative}'])
        for name, source in [('bin/helper', launcher), ('config.json', configuration), ('target.json', target)]:
            run(scp + [str(source), f'{host}:{staging}/{name}'])
    # No arbitrary shell or Python from SSH stdin: this is a fixed commissioning command,
    # not the production caller. All runtime files installed root-owned and non-writable.
    commands = ['set -eu', 'install -d -o root -g root -m 755 /opt/analytics-reviewed /opt/analytics-reviewed/bin /opt/analytics-reviewed/operations']
    for relative in (*SOURCE, 'bin/helper', 'config.json', 'target.json'):
        commands.append(f'install -o root -g root -m 600 {staging}/{relative} /opt/analytics-reviewed/{relative}')
    commands += [
        'chmod 700 /opt/analytics-reviewed/bin/helper',
        'if [ ! -e /opt/analytics-reviewed/venv/bin/python ]; then python3 -m venv --copies /opt/analytics-reviewed/venv; fi',
        '/opt/analytics-reviewed/venv/bin/python -m pip install --disable-pip-version-check "psycopg[binary]==3.3.6"',
        "/opt/analytics-reviewed/venv/bin/python -c 'import psycopg; assert psycopg.__version__ == \"3.3.6\"'",
        'chmod -R go-w /opt/analytics-reviewed',
        f'rm -rf {staging}',
    ]
    run(ssh + ['sudo -n -- sh -c ' + shlex.quote('; '.join(commands))])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--identity', required=True)
    parser.add_argument('--backend', choices=('pg', 'grafana'), required=True)
    args = parser.parse_args()
    install(args.host, args.identity, args.backend)

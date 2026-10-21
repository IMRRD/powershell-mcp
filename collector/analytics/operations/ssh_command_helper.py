#!/usr/bin/env python3
"""Ephemeral SSH-stdio helper; no listener, forwarding, or arbitrary SQL/URL."""
import json
import hashlib
import os
from pathlib import Path
import stat
import sys
import urllib.request

MAX_REQUEST = 65536
MAX_RESPONSE = 65536

def _protected(path, *, directory=False):
    """Reject links and writable ancestry; root owns privileged installations."""
    if not path.is_absolute():
        raise ValueError('absolute protected path required')
    for node in (path, *path.parents):
        info = node.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_mode & 0o022:
            raise ValueError('untrusted target path')
        if info.st_uid != 0:
            raise ValueError('untrusted target owner')
    info = path.stat()
    if not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)):
        raise ValueError('invalid target file type')

def verified_activation():
    """Bind all executable dependencies to controller-frozen bytes before import."""
    expected = globals().get('REVIEWED_BLOBS')
    if not isinstance(expected, dict) or set(expected) != {
            'operations/activate_private.py', 'operations/prepare-private-activation.py',
            'schema.sql', 'roles.sql', 'queries.sql', 'dashboard.json'}:
        raise ValueError('reviewed artifact missing')
    root = Path(os.environ['ANALYTICS_HELPER_ROOT'])
    config = Path(os.environ['ANALYTICS_HELPER_CONFIG'])
    _protected(root, directory=True)
    _protected(config)
    config_data = json.loads(config.read_bytes())
    verified = {}
    for relative, digest in expected.items():
        target = root / relative
        _protected(target)
        data = target.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError('reviewed artifact drift')
        verified[relative] = data
    # No cwd/PYTHONPATH lookup for activation; dependencies read from verified root.
    import types
    source = root / 'operations' / 'activate_private.py'
    module = types.ModuleType('reviewed_activate_private')
    module.__file__ = str(source)
    exec(compile(verified['operations/activate_private.py'], str(source), 'exec'), module.__dict__)
    return module.LiveAdapter, module.resources, config_data


def handle(request):
    operation = request.get('operation')
    if operation == 'attest':
        if set(request) != {'operation'}:
            raise ValueError('operation not allowed')
        verified_activation()
        return {'verified': True}
    if operation == 'grafana':
        if set(request) != {'operation', 'method', 'path'} or request['method'] != 'GET' or request['path'] != '/api/health':
            raise ValueError('operation not allowed')
        with urllib.request.urlopen('http://127.0.0.1:13000/api/health', timeout=5) as response:
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise ValueError('response too large')
            return {'health': json.loads(body)}
    if operation == 'pg':
        if set(request) != {'operation', 'query'} or request['query'] != 'private_database_exists':
            raise ValueError('operation not allowed')
        # Local libpq authority only; never accept connection parameters over the wire.
        import psycopg
        with psycopg.connect(os.environ.get('ANALYTICS_LOCAL_PG_DSN', ''), connect_timeout=5,
                             options='-c default_transaction_read_only=on -c statement_timeout=5000') as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)', ('hermes_mcp_analytics_private',))
                return {'database': cursor.fetchone()[0]}
    if operation != 'activation' or not isinstance(request.get('action'), str):
        raise ValueError('operation not allowed')
    action, key = request['action'], request.get('key')
    backend = os.environ.get('ANALYTICS_HELPER_BACKEND')
    allowed = frozenset(('database', 'importer', 'dashboard_role')) if backend == 'pg' else frozenset(('org', 'folder', 'datasource', 'dashboard')) if backend == 'grafana' else frozenset()
    if key not in allowed and not (backend == 'pg' and action == 'revoke_credentials' and key == 'roles'):
        raise ValueError('resource not allowed')
    if action not in ('get', 'identity', 'create', 'delete', 'org_empty', 'credential_active',
                      'revoke_credentials', 'disposable_database_empty', 'cluster_identity'):
        raise ValueError('action not allowed')
    if ((action == 'org_empty' and key != 'org') or
            (action in ('disposable_database_empty', 'cluster_identity') and key != 'database') or
            (action == 'credential_active' and key not in ('importer', 'dashboard_role')) or
            (action == 'revoke_credentials' and key != 'roles')):
        raise ValueError('action/resource mismatch')
    LiveAdapter, resources, config = verified_activation()
    adapter = LiveAdapter(Path(config['pg_admin_dsn_file']).read_text().strip() if backend == 'pg' else '',
                          config.get('grafana_url', 'http://127.0.0.1:13000'),
                          config.get('grafana_token_file', ''), config.get('importer_secret_file', ''),
                          config['dashboard_secret_file'], config['ca_file'], config['db_host'],
                          config.get('grafana_error_log'), backend=backend)
    value = request.get('value')
    if action in ('create', 'delete'):
        if set(request) != {'operation', 'action', 'key', 'value'} or not isinstance(value, dict) or value != resources(config['approved_admin'])[key]:
            raise ValueError('desired resource mismatch')
        getattr(adapter, action)(key, value)
        return {'value': adapter.get(key)}
    if action == 'org_empty':
        if set(request) != {'operation', 'action', 'key', 'value'} or key != 'org' or value != resources(config['approved_admin'])['org']:
            raise ValueError('invalid org check')
        return {'value': adapter.org_empty(adapter.identity('org'), value['admin'])}
    if set(request) != {'operation', 'action', 'key'}:
        raise ValueError('invalid request')
    if action == 'disposable_database_empty':
        if key != 'database':
            raise ValueError('invalid database check')
        return {'value': adapter.disposable_database_empty(resources(config['approved_admin'])['database']['name'])}
    if action == 'cluster_identity':
        if key != 'database':
            raise ValueError('invalid cluster check')
        return {'value': adapter.cluster_identity()}
    if action == 'revoke_credentials':
        adapter.revoke_credentials()
        return {'value': True}
    return {'value': getattr(adapter, action)(key)}


def main():
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError('request too large')
    request = json.loads(raw)
    result = handle(request)
    print(json.dumps({'ok': True, 'result': result}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as exc:
        if str(exc) == 'Grafana org deletion: unsupported DeleteCollection (HTTP 500)':
            print(json.dumps({'ok': False, 'error': 'unsupported DeleteCollection'}))
            sys.exit(0)
        print(json.dumps({'ok': False, 'error': 'remote operation failed'}))
        sys.exit(1)
    except Exception:
        # Never echo exception strings: urllib and libpq may include credential material.
        print(json.dumps({'ok': False, 'error': 'remote operation failed'}))
        sys.exit(1)

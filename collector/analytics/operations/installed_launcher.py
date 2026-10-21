#!/opt/analytics-reviewed/venv/bin/python
"""Root-owned entrypoint: fixed installed code, fixed target, bounded data only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys

ROOT = Path('/opt/analytics-reviewed')
MAX_REQUEST = 65536
# Replaced by install script with the reviewed source digest, never by a request.
HELPER_SHA256 = '__HELPER_SHA256__'
BLOBS = __REVIEWED_BLOBS__


def protected(path, *, directory=False):
    for node in (path, *path.parents):
        info = node.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise ValueError('unprotected installation')
    mode = path.stat().st_mode
    if not (stat.S_ISDIR(mode) if directory else stat.S_ISREG(mode)):
        raise ValueError('invalid installation type')


def validate_request(request):
    if not isinstance(request, dict) or request.get('operation') not in ('attest', 'pg', 'grafana', 'activation'):
        raise ValueError('invalid operation')
    allowed = {
        'attest': {'operation'},
        'pg': {'operation', 'query'},
        'grafana': {'operation', 'method', 'path'},
        'activation': {'operation', 'action', 'key', 'value'},
    }[request['operation']]
    if not set(request) <= allowed or (request['operation'] == 'attest' and set(request) != allowed):
        raise ValueError('unexpected request field')
    return request


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate field')
        result[key] = value
    return result


def run():
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError('request too large')
    request = validate_request(json.loads(raw, object_pairs_hook=unique_pairs))
    protected(ROOT, directory=True)
    protected(ROOT / 'bin', directory=True)
    protected(ROOT / 'bin' / 'helper')
    protected(ROOT / 'venv', directory=True)
    protected(ROOT / 'venv' / 'bin', directory=True)
    protected(ROOT / 'venv' / 'bin' / 'python')
    protected(ROOT / 'operations', directory=True)
    config_path = ROOT / 'config.json'
    protected(config_path)
    config = json.loads(config_path.read_bytes(), object_pairs_hook=unique_pairs)
    if set(config) != {'backend', 'config_file'} or config['backend'] not in ('pg', 'grafana') or config['config_file'] != str(ROOT / 'target.json'):
        raise ValueError('invalid target configuration')
    protected(ROOT / 'target.json')
    if request['operation'] == 'activation' and request['key'] not in ({'database', 'importer', 'dashboard_role', 'roles'} if config['backend'] == 'pg' else {'org', 'folder', 'datasource', 'dashboard'}):
        raise ValueError('wrong backend')
    helper = ROOT / 'operations' / 'ssh_command_helper.py'
    expected = {'operations/ssh_command_helper.py': HELPER_SHA256, **BLOBS}
    for relative, digest in expected.items():
        path = ROOT / relative
        protected(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError('reviewed bytes mismatch')
    os.environ.clear()
    os.environ.update({'ANALYTICS_HELPER_ROOT': str(ROOT), 'ANALYTICS_HELPER_CONFIG': str(ROOT / 'target.json'),
                       'ANALYTICS_HELPER_BACKEND': config['backend'], 'PATH': '/usr/bin:/bin'})
    if request['operation'] == 'pg' and config['backend'] != 'pg':
        raise ValueError('wrong backend')
    if request['operation'] == 'grafana' and config['backend'] != 'grafana':
        raise ValueError('wrong backend')
    spec = importlib.util.spec_from_file_location('installed_reviewed_helper', helper)
    module = importlib.util.module_from_spec(spec)
    module.REVIEWED_BLOBS = BLOBS
    spec.loader.exec_module(module)
    return module.handle(request)


if __name__ == '__main__':
    try:
        print(json.dumps({'ok': True, 'result': run()}, separators=(',', ':')))
    except Exception:
        print(json.dumps({'ok': False, 'error': 'remote operation failed'}))
        sys.exit(1)

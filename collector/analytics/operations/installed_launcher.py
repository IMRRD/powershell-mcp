#!/opt/analytics-reviewed/venv/bin/python
"""Root-owned entrypoint: fixed installed code, fixed target, bounded data only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import ctypes
import subprocess

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


def _running_pg_containers(service):
    ids = subprocess.check_output(['/usr/bin/docker', 'ps', '-q', '--no-trunc',
                                   '--filter', 'label=com.docker.swarm.service.name=' + service],
                                  timeout=5).decode().splitlines()
    if len(ids) != 1 or len(ids[0]) != 64 or any(c not in '0123456789abcdef' for c in ids[0]):
        raise ValueError('expected exactly one service container')
    containers = json.loads(subprocess.check_output(['/usr/bin/docker', 'inspect', ids[0]], timeout=5))
    if len(containers) != 1 or containers[0].get('Id') != ids[0]:
        raise ValueError('container identity drift')
    return containers


def _process_identity(pid):
    # Field 22 (starttime); comm may contain spaces and parentheses.
    data = Path(f'/proc/{pid}/stat').read_text()
    return data[data.rfind(')') + 2:].split()[19]


def bind_pg_namespace(service):
    if service != 'telemetry_storage_postgres':
        raise ValueError('service identity mismatch')
    container, = _running_pg_containers(service)
    if container.get('Config', {}).get('Labels', {}).get('com.docker.swarm.service.name') != service:
        raise ValueError('service identity mismatch')
    state = container.get('State', {})
    pid = state.get('Pid')
    if state.get('Running') is not True or type(pid) is not int or pid <= 1:
        raise ValueError('service stopped')
    start = _process_identity(pid)
    fd = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY | os.O_CLOEXEC)
    try:
        if _process_identity(pid) != start or os.stat(f'/proc/{pid}/ns/net').st_ino != os.fstat(fd).st_ino:
            raise ValueError('container PID drift')
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.setns(fd, 0x40000000) != 0:  # CLONE_NEWNET only
            raise OSError(ctypes.get_errno(), 'setns network failed')
    finally:
        os.close(fd)


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
    if set(config) != ({'backend', 'config_file', 'pg_service'} if config.get('backend') == 'pg' else {'backend', 'config_file'}) or config['backend'] not in ('pg', 'grafana') or config['config_file'] != str(ROOT / 'target.json') or (config['backend'] == 'pg' and config['pg_service'] != 'telemetry_storage_postgres'):
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
    if config['backend'] == 'pg' and request['operation'] != 'attest':
        target = json.loads((ROOT / 'target.json').read_bytes(), object_pairs_hook=unique_pairs)
        dsn_path = Path(target['pg_admin_dsn_file'])
        protected(dsn_path)
        from psycopg.conninfo import conninfo_to_dict
        dsn = dsn_path.read_text().strip()
        connection = conninfo_to_dict(dsn)
        if (connection.get('host') != 'docker-xrv3' or connection.get('hostaddr') != '127.0.0.1'
                or connection.get('port') != '5432' or connection.get('sslmode') != 'verify-full'
                or not connection.get('sslrootcert')):
            raise ValueError('invalid local PG connection authority')
        protected(Path(connection['sslrootcert']))
        bind_pg_namespace(config['pg_service'])
        os.environ['ANALYTICS_LOCAL_PG_DSN'] = dsn
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

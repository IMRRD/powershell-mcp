#!/usr/bin/env python3
"""Private analytics activation. Explicit --apply; no production changes by default.

Receipt is private, fsync'd after each mutation. Never reuse a receipt for another
activation. Secrets are read from private files, never supplied as CLI arguments.
"""
import argparse
import json
import os
from pathlib import Path
import urllib.request
import urllib.error
import base64

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parent.parent
ORDER = ('database', 'importer', 'dashboard_role', 'org', 'folder', 'datasource', 'dashboard')
DELETE_ORDER = ('dashboard', 'datasource', 'folder', 'org', 'database', 'dashboard_role', 'importer')


def resources(admin):
    if not admin or admin in ('Viewer', 'Editor'):
        raise ValueError('explicit approved administrator required')
    return {
        'database': {'name': 'hermes_mcp_analytics_private'},
        'importer': {'name': 'hermes_analytics_importer'},
        'dashboard_role': {'name': 'hermes_analytics_dashboard'},
        'org': {'name': 'Private telemetry analytics', 'admin': admin},
        'folder': {'uid': 'private-telemetry', 'title': 'Private telemetry'},
        'datasource': {'uid': 'private-telemetry-pg', 'database': 'hermes_mcp_analytics_private', 'sslmode': 'verify-full'},
        'dashboard': {'uid': 'private-telemetry-42', 'folderUid': 'private-telemetry'},
    }


def _save(path, receipt):
    tmp = path.with_suffix('.tmp')
    with tmp.open('x', encoding='utf-8') as stream:
        os.chmod(tmp, 0o600)
        json.dump(receipt, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def _empty_owned_org(adapter, receipt):
    org = receipt['owned']['org']
    if adapter.get('org') != org['value'] or adapter.identity('org') != org['identity']:
        raise ValueError('retained org ownership drift')
    if not adapter.org_empty(org['identity'], org['value']['admin']):
        raise ValueError('retained org is not empty and admin-only')


def apply(adapter, path, desired, *, disposable_fixture=None):
    if not path.exists():
        _save(path, {'owned': {}, 'pending': {}, 'desired': desired, 'disposable_fixture': disposable_fixture})
    receipt = json.loads(path.read_text(encoding='utf-8'))
    if receipt['desired'] != desired or receipt.get('disposable_fixture') != disposable_fixture:
        raise ValueError('receipt belongs to another activation')
    receipt.setdefault('pending', {})
    if receipt.get('retained_org'):
        _empty_owned_org(adapter, receipt)
    for key, value in desired.items():
        actual = adapter.get(key)
        if key in receipt['owned']:
            if actual != receipt['owned'][key]['value'] or adapter.identity(key) != receipt['owned'][key]['identity']:
                raise ValueError(f'{key}: owned resource drift')
            if key in ('importer', 'dashboard_role') and not adapter.credential_active(key):
                raise ValueError(f'{key}: credential disabled by rollback; manual recovery required')
            continue
        if key in receipt['pending']:
            raise ValueError(f'{key}: creation outcome unknown; reconcile manually before retry')
        if actual is not None:
            raise ValueError(f'{key}: existing resource is not owned by receipt')
        receipt['pending'][key] = value
        _save(path, receipt)
        adapter.create(key, value)
        if adapter.get(key) != value:
            raise RuntimeError(f'{key}: failed readback')
        if key == 'org':
            receipt.pop('retained_org', None)
        receipt['owned'][key] = {'value': value, 'identity': adapter.identity(key)}
        del receipt['pending'][key]
        _save(path, receipt)
    if receipt.get('retained_org'):
        receipt.pop('retained_org')
        _save(path, receipt)
    return receipt


def rollback(adapter, path, *, disposable_fixture=None):
    if not path.exists():
        return
    receipt = json.loads(path.read_text(encoding='utf-8'))
    for key, value in list(receipt.get('pending', {}).items()):
        actual = adapter.get(key)
        if actual is not None:
            if actual != value:
                raise ValueError(f'{key}: pending creation drift; manual recovery required')
            receipt['owned'][key] = {'value': value, 'identity': adapter.identity(key)}
        del receipt['pending'][key]
        _save(path, receipt)
    for key in DELETE_ORDER:
        if key not in receipt['owned']:
            continue
        value = receipt['owned'][key]['value']
        if adapter.get(key) != value or adapter.identity(key) != receipt['owned'][key]['identity']:
            raise ValueError(f'{key}: ownership drift; manual recovery required')
        if key == 'org' and receipt.get('retained_org'):
            _empty_owned_org(adapter, receipt)
            continue
        if key == 'org':
            _empty_owned_org(adapter, receipt)
            receipt['credentials_revocation_pending'] = True
            _save(path, receipt)
            for role in ('importer', 'dashboard_role'):
                if role in receipt['owned'] and (adapter.get(role) != receipt['owned'][role]['value']
                                                 or adapter.identity(role) != receipt['owned'][role]['identity']):
                    raise ValueError(f'{role}: ownership drift before credential revocation')
            adapter.revoke_credentials()
            receipt.pop('credentials_revocation_pending', None)
            _save(path, receipt)
            receipt['org_delete_pending'] = True
            _save(path, receipt)
            try:
                adapter.delete(key, value)
            except RuntimeError as exc:
                # Grafana 13.1.1 returns 500 unsupported DeleteCollection even
                # for an empty org. No other 500 is safe to classify this way.
                if 'unsupported DeleteCollection' not in str(exc):
                    raise
                _empty_owned_org(adapter, receipt)
                receipt['retained_org'] = {'id': receipt['owned']['org']['identity'],
                                           'name': value['name'], 'admin': value['admin'],
                                           'reason': 'Grafana 13.1.1 unsupported DeleteCollection'}
                receipt.pop('org_delete_pending', None)
                _save(path, receipt)
                continue
        elif key == 'database':
            # Destructive cleanup is opt-in for an isolated rehearsal only.
            if not disposable_fixture:
                raise ValueError('database retained: explicit isolated rehearsal cleanup or data retention decision required')
            if (disposable_fixture.get('kind') != 'isolated-container'
                    or disposable_fixture.get('receipt') != str(path)
                    or receipt.get('disposable_fixture') != disposable_fixture):
                raise ValueError('fixture binding drift; database retained')
            if not adapter.disposable_database_empty(value['name']):
                raise ValueError('database contains data or unknown relations; retention decision required')
            receipt['delete_pending'] = key
            _save(path, receipt)
            adapter.delete(key, value)
        else:
            receipt['delete_pending'] = key
            _save(path, receipt)
            adapter.delete(key, value)
        if adapter.get(key) is not None:
            raise RuntimeError(f'{key}: deletion not verified')
        del receipt['owned'][key]
        receipt.pop('delete_pending', None)
        receipt.pop('org_delete_pending', None)
        _save(path, receipt)
    if receipt.get('retained_org'):
        _empty_owned_org(adapter, receipt)
        raise RuntimeError('rollback incomplete: retained empty private org (Grafana 13.1.1 unsupported DeleteCollection)')


class LiveAdapter:
    """Local approved PostgreSQL administration and Grafana API; private org only."""
    def __init__(self, pg_admin_dsn, grafana_url, token_file, importer_secret, dashboard_secret, ca_file, db_host, grafana_error_log=None, *, backend='both'):
        if backend not in ('both', 'pg', 'grafana'):
            raise ValueError('invalid backend')
        self.admin_dsn = pg_admin_dsn
        self.pg = None
        self.sql = None
        if backend in ('both', 'pg'):
            import psycopg
            from psycopg import sql
            self.pg = psycopg.connect(pg_admin_dsn, autocommit=True)
            self.sql = sql
        self.url = grafana_url.rstrip('/')
        self.token = Path(token_file).read_text().strip() if backend in ('both', 'grafana') else ''
        self.secrets = {key: Path(file).read_text().strip() for key, file in
                        (('importer', importer_secret), ('dashboard_role', dashboard_secret))
                        if backend in ('both', 'pg') or key == 'dashboard_role'}
        self.ca = str(Path(ca_file).resolve())
        self.host = db_host
        if (backend in ('both', 'grafana') and not self.token) or not all(self.secrets.values()):
            raise ValueError('empty protected secret')
        self.org_id = None
        self.grafana_error_log = Path(grafana_error_log) if grafana_error_log else None

    def api(self, method, path, payload=None, org=None):
        credential = ('Basic ' + base64.b64encode(self.token[6:].encode()).decode()) if self.token.startswith('basic:') else ('Bearer ' + self.token)
        headers = {'Authorization': credential, 'Content-Type': 'application/json'}
        if org is not None:
            headers['X-Grafana-Org-Id'] = str(org)
        data = json.dumps(payload).encode() if payload is not None else None
        log_offset = self.grafana_error_log.stat().st_size if (self.grafana_error_log and self.grafana_error_log.exists() and method == 'DELETE' and path.startswith('/api/orgs/')) else None
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            body = exc.read(4096).decode('utf-8', errors='replace')
            if method == 'DELETE' and path.startswith('/api/orgs/') and exc.code == 500:
                specific = 'failed to delete dashboards for org ' + path.rsplit('/', 1)[1] + ': the server does not allow this method on the requested resource'
                if log_offset is not None:
                    with self.grafana_error_log.open('rb') as log:
                        log.seek(log_offset)
                        recent = log.read(65536).decode('utf-8', errors='replace')
                    if any(specific in line and 'status=500' in line and 'method=DELETE' in line and 'path=' + path in line for line in recent.splitlines()):
                        raise RuntimeError('Grafana org deletion: unsupported DeleteCollection (HTTP 500)') from None
            raise RuntimeError(f'Grafana {method} {path}: HTTP {exc.code}') from None

    def _org(self):
        matches = [o for o in self.api('GET', '/api/orgs') if o['name'] == 'Private telemetry analytics']
        return matches[0] if matches else None

    def _db(self, query, args=()):
        with self.pg.cursor() as cur:
            cur.execute(query, args)
            return cur.fetchone() if cur.description else None

    def identity(self, key):
        if key == 'database':
            return self._db('SELECT oid FROM pg_database WHERE datname=%s', ('hermes_mcp_analytics_private',))[0]
        if key in self.secrets:
            return self._db('SELECT oid FROM pg_roles WHERE rolname=%s', (resources('placeholder')[key]['name'],))[0]
        if key == 'org':
            return self._org()['id']
        oid = self._org()['id']
        if key == 'folder':
            return [oid, self.api('GET', '/api/folders/private-telemetry', org=oid)['id']]
        if key == 'datasource':
            return [oid, self.api('GET', '/api/datasources/uid/private-telemetry-pg', org=oid)['id']]
        if key == 'dashboard':
            return [oid, self.api('GET', '/api/dashboards/uid/private-telemetry-42', org=oid)['dashboard']['id']]
        raise KeyError(key)

    def get(self, key):
        names = resources('placeholder')
        if key == 'database':
            found = self._db('SELECT datname FROM pg_database WHERE datname=%s', (names[key]['name'],))
            return names[key] if found else None
        if key in ('importer', 'dashboard_role'):
            found = self._db('SELECT rolname FROM pg_roles WHERE rolname=%s', (names[key]['name'],))
            return names[key] if found else None
        if key == 'org':
            found = self._org()
            return {'name': found['name'], 'admin': self._approved_admin(found['id'])} if found else None
        org = self._org()
        if not org:
            return None
        oid = org['id']
        if key == 'folder':
            obj = self.api('GET', '/api/folders/private-telemetry', org=oid)
            return {'uid': obj['uid'], 'title': obj['title']} if obj else None
        if key == 'datasource':
            obj = self.api('GET', '/api/datasources/uid/private-telemetry-pg', org=oid)
            return {'uid': obj['uid'], 'database': obj['jsonData']['database'], 'sslmode': obj['jsonData']['sslmode']} if obj else None
        if key == 'dashboard':
            obj = self.api('GET', '/api/dashboards/uid/private-telemetry-42', org=oid)
            return {'uid': obj['dashboard']['uid'], 'folderUid': obj['meta']['folderUid']} if obj else None
        raise KeyError(key)

    def _approved_admin(self, oid):
        users = self.api('GET', f'/api/orgs/{oid}/users')
        admins = [u['login'] for u in users if u['role'] == 'Admin']
        if len(admins) != 1 or any(u['role'] != 'Admin' for u in users):
            raise ValueError('org membership drift: non-admin or multiple administrators')
        return admins[0]

    def org_empty(self, oid, admin):
        if self._approved_admin(oid) != admin:
            return False
        # Search includes dashboards outside our known folder; datasource list is
        # org-scoped. Fail closed on any foreign content instead of adopting it.
        return (not self.api('GET', '/api/search?type=dash-db', org=oid)
                and not self.api('GET', '/api/search?type=dash-folder', org=oid)
                and not self.api('GET', '/api/datasources', org=oid))

    def cluster_identity(self):
        return str(self._db('SELECT system_identifier FROM pg_control_system()')[0])

    def disposable_database_empty(self, name):
        # Only the exact disposable schema (or pre-schema empty DB) is eligible.
        # Unknown relations and populated checkpoint tables retain the database.
        import psycopg
        expected = {'telemetry_event', 'telemetry_tool', 'telemetry_metric_axis', 'telemetry_checkpoint'}
        expected_views = {'dashboard_events', 'dashboard_tools', 'dashboard_metric_axes'}
        with psycopg.connect(self.admin_dsn, dbname=name) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT n.nspname, c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','f','S')")
                relations = cur.fetchall()
                tables = {(schema, relation) for schema, relation, kind in relations if kind in ('r', 'p')}
                views = {(schema, relation) for schema, relation, kind in relations if kind == 'v'}
                other = {(schema, relation) for schema, relation, kind in relations if kind not in ('r', 'p', 'v')}
                cur.execute("SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind='i'")
                indexes = set(cur.fetchall())
                expected_indexes = {'telemetry_event_pkey', 'telemetry_event_window', 'telemetry_event_installation', 'telemetry_event_arrival', 'telemetry_tool_pkey', 'telemetry_tool_stream', 'telemetry_metric_axis_pkey', 'telemetry_checkpoint_pkey'}
                cur.execute("SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'")
                functions = set(cur.fetchall())
                expected_functions = {'adoption_utc', 'delivery_health_utc'}
                if (other or tables not in (set(), {('public', t) for t in expected})
                        or views not in (set(), {('public', v) for v in expected_views})
                        or indexes not in (set(), {('public', i) for i in expected_indexes})
                        or functions not in (set(), {('public', f) for f in expected_functions})):
                    return False
                if len({bool(tables), bool(views), bool(indexes), bool(functions)}) != 1:
                    return False
                for table in expected if tables else ():
                    cur.execute(self.sql.SQL('SELECT EXISTS (SELECT 1 FROM {} LIMIT 1)').format(self.sql.Identifier('public', table)))
                    if cur.fetchone()[0]:
                        return False
                return True

    def credential_active(self, key):
        name = resources('placeholder')[key]['name']
        row = self._db('SELECT rolcanlogin FROM pg_roles WHERE rolname=%s', (name,))
        if not row or not row[0]:
            return False
        return bool(self._db('SELECT has_database_privilege(%s, %s, %s)',
                             (name, 'hermes_mcp_analytics_private', 'CONNECT'))[0])

    def revoke_credentials(self):
        for key in ('importer', 'dashboard_role'):
            name = resources('placeholder')[key]['name']
            if self.get(key) is not None:
                self._db(self.sql.SQL('ALTER ROLE {} NOLOGIN').format(self.sql.Identifier(name)))
                if self.get('database') is not None:
                    self._db(self.sql.SQL('REVOKE CONNECT ON DATABASE {} FROM {}').format(
                        self.sql.Identifier('hermes_mcp_analytics_private'), self.sql.Identifier(name)))
                row = self._db('SELECT rolcanlogin FROM pg_roles WHERE rolname=%s', (name,))
                if row[0] or (self.get('database') is not None and
                              self._db('SELECT has_database_privilege(%s,%s,%s)',
                                       (name, 'hermes_mcp_analytics_private', 'CONNECT'))[0]):
                    raise RuntimeError(f'{key}: credential revocation not verified')

    def create(self, key, value):
        if key == 'database':
            self._db(self.sql.SQL('CREATE DATABASE {}').format(self.sql.Identifier(value['name'])))
            with self.pg.cursor() as cur:
                cur.execute(self.sql.SQL('REVOKE CONNECT ON DATABASE {} FROM PUBLIC').format(self.sql.Identifier(value['name'])))
            return
        if key in self.secrets:
            self._db(self.sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(self.sql.Identifier(value['name']), self.sql.Literal(self.secrets[key])))
            self._db(self.sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(self.sql.Identifier('hermes_mcp_analytics_private'), self.sql.Identifier(value['name'])))
            if key == 'dashboard_role':
                self._install_schema()
            return
        if key == 'org':
            created = self.api('POST', '/api/orgs', {'name': value['name']})
            oid = created['orgId']
            # New org defaults are not safe: refuse if anything other than the
            # explicitly approved existing admin would have access.
            users = self.api('GET', f'/api/orgs/{oid}/users')
            for user in users:
                if user['login'] != value['admin']:
                    self.api('DELETE', f"/api/orgs/{oid}/users/{user['userId']}")
            users = self.api('GET', f'/api/orgs/{oid}/users')
            if not any(u['login'] == value['admin'] for u in users):
                raise ValueError('approved admin is not member; halt before datasource creation')
            for user in users:
                self.api('PATCH', f"/api/orgs/{oid}/users/{user['userId']}", {'role': 'Admin'})
            self._approved_admin(oid)
            return
        oid = self._org()['id']
        if key == 'folder':
            self.api('POST', '/api/folders', value, org=oid)
            self.api('POST', '/api/folders/private-telemetry/permissions', {'items': []}, org=oid)
            acl = self.api('GET', '/api/folders/private-telemetry/permissions', org=oid)
            if any(i.get('basicRole') in ('Viewer', 'Editor') for i in acl):
                raise ValueError('folder ACL not private')
            return
        if key == 'datasource':
            password = self.secrets['dashboard_role']
            self.api('POST', '/api/datasources', {'name': 'Private Telemetry PostgreSQL', 'uid': value['uid'], 'type': 'postgres', 'access': 'proxy', 'url': self.host, 'user': 'hermes_analytics_dashboard', 'database': value['database'], 'jsonData': {'database': value['database'], 'sslmode': 'verify-full', 'tlsConfigurationMethod': 'file-content', 'postgresVersion': 1700, 'maxOpenConns': 5, 'maxIdleConns': 2, 'tlsAuthWithCACert': True}, 'secureJsonData': {'password': password, 'tlsCACert': Path(self.ca).read_text()}, 'editable': False}, org=oid)
            result = self.api('GET', f'/api/datasources/uid/{value["uid"]}/health', org=oid)
            if result is None or result.get('status') != 'OK':
                raise ValueError('datasource health did not pass')
            return
        if key == 'dashboard':
            dashboard = json.loads((ROOT / 'dashboard.json').read_text())
            if dashboard.get('uid') != value['uid'] or any(p.get('datasource', {}).get('uid') != 'private-telemetry-pg' for p in dashboard['panels']):
                raise ValueError('dashboard source UID/datasource mismatch')
            self.api('POST', '/api/dashboards/db', {'dashboard': dashboard, 'folderUid': value['folderUid'], 'overwrite': False}, org=oid)
            return
        raise KeyError(key)

    def _install_schema(self):
        import psycopg
        conn = psycopg.connect(self.admin_dsn, dbname='hermes_mcp_analytics_private')
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute((ROOT / 'schema.sql').read_text())
                    cur.execute((ROOT / 'roles.sql').read_text().replace('telemetry_importer', 'hermes_analytics_importer').replace('telemetry_dashboard', 'hermes_analytics_dashboard'))
        finally:
            conn.close()

    def delete(self, key, value):
        if key == 'dashboard':
            self.api('DELETE', f'/api/dashboards/uid/{value["uid"]}', org=self._org()['id'])
        elif key == 'datasource':
            self.api('DELETE', f'/api/datasources/uid/{value["uid"]}', org=self._org()['id'])
        elif key == 'folder':
            self.api('DELETE', f'/api/folders/{value["uid"]}', org=self._org()['id'])
        elif key == 'org':
            self.api('DELETE', f'/api/orgs/{self._org()["id"]}')
        elif key == 'database':
            self._db(self.sql.SQL('DROP DATABASE {} WITH (FORCE)').format(self.sql.Identifier(value['name'])))
        elif key in self.secrets:
            self._db(self.sql.SQL('DROP ROLE {}').format(self.sql.Identifier(value['name'])))
        else:
            raise KeyError(key)


class SSHAdapter:
    """Controller-owned receipt with fixed, target-local PostgreSQL/Grafana operations."""
    def __init__(self, pg_host, grafana_host, identity_file):
        spec = spec_from_file_location('ssh_command_transport', Path(__file__).with_name('ssh_command_transport.py'))
        transport = module_from_spec(spec)
        spec.loader.exec_module(transport)
        self.execute = transport.execute
        self.pg_host = pg_host
        self.grafana_host = grafana_host
        self.identity_file = identity_file

    def _call(self, key, action, value=None):
        host = self.pg_host if key in ('database', 'importer', 'dashboard_role', 'roles') else self.grafana_host
        request = {'operation': 'activation', 'action': action, 'key': key}
        if value is not None:
            request['value'] = value
        result = self.execute(host, self.identity_file, request)
        if set(result) != {'value'}:
            raise ValueError('invalid activation response')
        return result['value']

    def get(self, key):
        return self._call(key, 'get')

    def identity(self, key):
        return self._call(key, 'identity')

    def create(self, key, value):
        self._call(key, 'create', value)

    def delete(self, key, value):
        self._call(key, 'delete', value)

    def org_empty(self, oid, admin):
        if self.identity('org') != oid:
            return False
        return self._call('org', 'org_empty', resources(admin)['org'])

    def cluster_identity(self):
        return self._call('database', 'cluster_identity')

    def disposable_database_empty(self, name):
        if name != resources('placeholder')['database']['name']:
            return False
        return self._call('database', 'disposable_database_empty')

    def credential_active(self, key):
        return self._call(key, 'credential_active')

    def revoke_credentials(self):
        self._call('roles', 'revoke_credentials')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('apply', 'verify', 'rollback'))
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--approved-admin', required=True)
    parser.add_argument('--pg-admin-dsn-file', type=Path)
    parser.add_argument('--grafana-url')
    parser.add_argument('--grafana-token-file', type=Path)
    parser.add_argument('--importer-secret-file', type=Path)
    parser.add_argument('--dashboard-secret-file', type=Path)
    parser.add_argument('--ca-file', type=Path)
    parser.add_argument('--db-host')
    parser.add_argument('--ssh-pg-host', help='Enable controller SSH transport to the PostgreSQL host')
    parser.add_argument('--ssh-grafana-host', help='Enable controller SSH transport to the Grafana host')
    parser.add_argument('--ssh-identity-file', type=Path, help='SSH private key for both fixed hosts')
    parser.add_argument('--grafana-error-log', type=Path,
                        help='Local Grafana server log; required to prove the specific unsupported org DELETE 500')
    parser.add_argument('--disposable-fixture-file', type=Path,
                        help='Fixture provenance bound to receipt and PostgreSQL cluster; never use in production')
    args = parser.parse_args()
    script = ROOT / 'operations' / 'prepare-private-activation.py'
    spec = spec_from_file_location('pinned', script)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    module.build(ROOT)  # reject unreviewed SQL/dashboard bytes before any mutation
    ssh_selected = (args.ssh_pg_host, args.ssh_grafana_host, args.ssh_identity_file)
    if any(ssh_selected) and not all(ssh_selected):
        parser.error('SSH transport requires both hosts and an identity file')
    if not all(ssh_selected) and not all((args.pg_admin_dsn_file, args.grafana_url, args.grafana_token_file,
                                         args.importer_secret_file, args.dashboard_secret_file, args.ca_file,
                                         args.db_host)):
        parser.error('local transport requires PostgreSQL, Grafana, CA and protected secret arguments')
    adapter = (SSHAdapter(*ssh_selected) if all(ssh_selected) else
               LiveAdapter(args.pg_admin_dsn_file.read_text().strip(), args.grafana_url, args.grafana_token_file,
                           args.importer_secret_file, args.dashboard_secret_file, args.ca_file, args.db_host,
                           args.grafana_error_log))
    desired = resources(args.approved_admin)
    fixture = None
    if args.disposable_fixture_file:
        fixture = json.loads(args.disposable_fixture_file.read_text())
        if (fixture.get('kind') != 'isolated-container' or fixture.get('receipt') != str(args.receipt)
                or fixture.get('cluster_id') != adapter.cluster_identity()):
            raise ValueError('fixture provenance mismatch')
    if args.mode == 'apply':
        apply(adapter, args.receipt, desired, disposable_fixture=fixture)
    elif args.mode == 'rollback':
        rollback(adapter, args.receipt, disposable_fixture=fixture)
    else:
        receipt = json.loads(args.receipt.read_text())
        if (receipt['desired'] != desired or receipt.get('pending') or set(receipt['owned']) != set(desired)
                or any(adapter.get(k) != v['value'] or adapter.identity(k) != v['identity'] for k, v in receipt['owned'].items())):
            raise ValueError('activation readback failed')
    print(args.mode + ': verified')


if __name__ == '__main__':
    main()

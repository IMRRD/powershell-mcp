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

from importlib.util import module_from_spec, spec_from_file_location

ROOT = Path(__file__).resolve().parent.parent
ORDER = ('database', 'importer', 'dashboard_role', 'org', 'folder', 'datasource', 'dashboard')


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


def apply(adapter, path, desired):
    if not path.exists():
        _save(path, {'owned': {}, 'desired': desired})
    receipt = json.loads(path.read_text(encoding='utf-8'))
    if receipt['desired'] != desired:
        raise ValueError('receipt belongs to another activation')
    for key, value in desired.items():
        actual = adapter.get(key)
        if key in receipt['owned']:
            if actual != value:
                raise ValueError(f'{key}: owned resource drift')
            continue
        if actual is not None:
            raise ValueError(f'{key}: existing resource is not owned by receipt')
        adapter.create(key, value)
        if adapter.get(key) != value:
            raise RuntimeError(f'{key}: failed readback')
        receipt['owned'][key] = value
        _save(path, receipt)
    return receipt


def rollback(adapter, path):
    if not path.exists():
        return
    receipt = json.loads(path.read_text(encoding='utf-8'))
    for key in reversed(list(receipt['owned'])):
        value = receipt['owned'][key]
        if adapter.get(key) != value:
            raise ValueError(f'{key}: ownership drift; manual recovery required')
        adapter.delete(key, value)
        if adapter.get(key) is not None:
            raise RuntimeError(f'{key}: deletion not verified')
        del receipt['owned'][key]
        _save(path, receipt)


class LiveAdapter:
    """Local approved PostgreSQL administration and Grafana API; private org only."""
    def __init__(self, pg_admin_dsn, grafana_url, token_file, importer_secret, dashboard_secret, ca_file, db_host):
        import psycopg
        from psycopg import sql
        self.pg = psycopg.connect(pg_admin_dsn, autocommit=True)
        self.sql = sql
        self.url = grafana_url.rstrip('/')
        self.token = Path(token_file).read_text().strip()
        self.secrets = {'importer': Path(importer_secret).read_text().strip(), 'dashboard_role': Path(dashboard_secret).read_text().strip()}
        self.ca = str(Path(ca_file).resolve())
        self.host = db_host
        if not self.token or not all(self.secrets.values()):
            raise ValueError('empty protected secret')
        self.org_id = None

    def api(self, method, path, payload=None, org=None):
        headers = {'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'}
        if org is not None:
            headers['X-Grafana-Org-Id'] = str(org)
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                body = response.read()
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise RuntimeError(f'Grafana {method} {path}: HTTP {exc.code}') from None

    def _org(self):
        matches = [o for o in self.api('GET', '/api/orgs') if o['name'] == 'Private telemetry analytics']
        return matches[0] if matches else None

    def _db(self, query, args=()):
        with self.pg.cursor() as cur:
            cur.execute(query, args)
            return cur.fetchone() if cur.description else None

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

    def create(self, key, value):
        if key == 'database':
            self._db(self.sql.SQL('CREATE DATABASE {}').format(self.sql.Identifier(value['name'])))
            with self.pg.cursor() as cur:
                cur.execute(self.sql.SQL('REVOKE CONNECT ON DATABASE {} FROM PUBLIC').format(self.sql.Identifier(value['name'])))
            return
        if key in self.secrets:
            self._db(self.sql.SQL('CREATE ROLE {} LOGIN PASSWORD %s').format(self.sql.Identifier(value['name'])), (self.secrets[key],))
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
            self.api('POST', '/api/folders/private-telemetry/permissions', {'items': [{'basicRole': 'Admin', 'permission': 4}]}, org=oid)
            acl = self.api('GET', '/api/folders/private-telemetry/permissions', org=oid)
            if any(i.get('basicRole') in ('Viewer', 'Editor') for i in acl):
                raise ValueError('folder ACL not private')
            return
        if key == 'datasource':
            password = self.secrets['dashboard_role']
            self.api('POST', '/api/datasources', {'name': 'Private Telemetry PostgreSQL', 'uid': value['uid'], 'type': 'postgres', 'access': 'proxy', 'url': self.host, 'user': 'hermes_analytics_dashboard', 'database': value['database'], 'jsonData': {'database': value['database'], 'sslmode': 'verify-full', 'postgresVersion': 1700, 'maxOpenConns': 5, 'maxIdleConns': 2, 'tlsAuthWithCACert': True}, 'secureJsonData': {'password': password, 'tlsCACert': Path(self.ca).read_text()}, 'editable': False}, org=oid)
            result = self.api('GET', f'/api/datasources/uid/{value["uid"]}/health', org=oid)
            if result is None or result.get('status') != 'OK':
                raise ValueError('datasource health did not pass')
            return
        if key == 'dashboard':
            dashboard = json.loads((ROOT / 'dashboard.json').read_text())
            self.api('POST', '/api/dashboards/db', {'dashboard': dashboard, 'folderUid': value['folderUid'], 'overwrite': False}, org=oid)
            return
        raise KeyError(key)

    def _install_schema(self):
        import psycopg
        conn = psycopg.connect(self.pg.info.dsn + ' dbname=hermes_mcp_analytics_private')
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('apply', 'verify', 'rollback'))
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--approved-admin', required=True)
    parser.add_argument('--pg-admin-dsn-file', type=Path, required=True)
    parser.add_argument('--grafana-url', required=True)
    parser.add_argument('--grafana-token-file', type=Path, required=True)
    parser.add_argument('--importer-secret-file', type=Path, required=True)
    parser.add_argument('--dashboard-secret-file', type=Path, required=True)
    parser.add_argument('--ca-file', type=Path, required=True)
    parser.add_argument('--db-host', required=True)
    args = parser.parse_args()
    script = ROOT / 'operations' / 'prepare-private-activation.py'
    spec = spec_from_file_location('pinned', script)
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    module.build(ROOT)  # reject unreviewed SQL/dashboard bytes before any mutation
    adapter = LiveAdapter(args.pg_admin_dsn_file.read_text().strip(), args.grafana_url, args.grafana_token_file, args.importer_secret_file, args.dashboard_secret_file, args.ca_file, args.db_host)
    desired = resources(args.approved_admin)
    if args.mode == 'apply':
        apply(adapter, args.receipt, desired)
    elif args.mode == 'rollback':
        rollback(adapter, args.receipt)
    else:
        receipt = json.loads(args.receipt.read_text())
        if receipt['desired'] != desired or any(adapter.get(k) != v for k, v in receipt['owned'].items()):
            raise ValueError('activation readback failed')
    print(args.mode + ': verified')


if __name__ == '__main__':
    main()

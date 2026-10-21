#!/usr/bin/env python3
"""Fail-closed, no-write production activation payload builder; never contacts Grafana."""
import argparse
import hashlib
import json
from pathlib import Path

EXPECTED = {
    'schema.sql': 'bbb62ecdb50c1f9bf461784fdbaa49733587933b',
    'roles.sql': '239b8e8718351950e8a22e139315a0c15e3d9ad3',
    'import_jsonl.py': '9d734555790ce54a537c21e29e14522143a6e68d',
    'dashboard.json': 'f556a0986ac6383396e041d9adb307ce2126baca',
    'datasource.yaml': 'c200b89cbe01d277790ff571753544bba5eda962',
}

def blob(path):
    data = path.read_bytes()
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

def build(root):
    checked = {}
    for name, expected in EXPECTED.items():
        path = root / name
        actual = blob(path)
        if actual != expected:
            raise ValueError(f'{name}: unreviewed source blob {actual}')
        checked[name] = {'git_blob': actual, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    dashboard = json.loads((root / 'dashboard.json').read_text(encoding='utf-8'))
    if not isinstance(dashboard, dict) or not dashboard.get('panels'):
        raise ValueError('empty or malformed dashboard')
    return {
        'source_commit': '3cc42f2c96f96e6a0049f4841892c2ab4c291d99',
        'sources': checked,
        'activation': 'BLOCKED_PARENT_REVIEW',
        'database': 'dedicated analytics database ONLY; do not repoint fleet telemetry',
        'grafana': {
            'folder_uid': 'private-telemetry',
            'folder_title': 'Private telemetry',
            'dashboard_uid': dashboard.get('uid'),
            'datasource_uid': 'private-telemetry-pg',
            'order': [
                'Create dedicated DB/roles from pinned schema and grants; verify login/backup/restore/SSL/HBA.',
                'Back up current Grafana folder/datasource/dashboard and capture rollback hashes.',
                'Create empty folder via POST /api/folders (uid private-telemetry); refuse if UID exists with unexpected owner.',
                'Set explicit folder permissions via POST /api/folders/private-telemetry/permissions: only Admin role and approved restricted team/service account; remove Viewer and Editor defaults.',
                'GET folder permissions and require no Viewer/Editor/public access before adding any dashboard or datasource.',
                'Create datasource scoped to private org with verify-full and protected CA; require test API and pg_stat_ssl on real backend.',
                'Import pinned dashboard into restricted folder and render with restricted principal; unauthorized principal must fail.',
                'Enable single-owner importer only after read-only collector snapshot and bounded checkpoint/alerting/backup proof.',
            ],
            'folder_permission_payload_admin_only': {'items': [{'basicRole': 'Admin', 'permission': 4}]},
            'dashboard_import_payload': {'dashboard': dashboard, 'folderUid': 'private-telemetry', 'overwrite': False},
        },
        'prohibitions': ['No live API calls from this builder', 'No production Grafana mutation before ACL readback', 'No public datasource or snapshots', 'No modification of collector history'],
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    print(json.dumps(build(args.root), indent=2))

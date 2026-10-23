#!/usr/bin/env python3
"""Org-1 overview promotion; durable controller receipt and native authenticated SSH API."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('promotion_contract', HERE / 'promote_overview.py')
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)

REMOTE = '''import base64,json,pathlib,urllib.request
secret=pathlib.Path('/opt/analytics-reviewed/grafana-admin.secret').read_text().strip()
auth='Basic '+base64.b64encode(secret[6:].encode()).decode() if secret.startswith('basic:') else 'Bearer '+secret
request=json.loads(REQUEST)
base='http://127.0.0.1:13000'
def api(method,path,payload=None):
 req=urllib.request.Request(base+path,data=json.dumps(payload).encode() if payload is not None else None,method=method,headers={'Authorization':auth,'X-Grafana-Org-Id':'1','Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
assert api('GET','/api/user')['orgId']==1
if request['action']=='inventory':
 listing=api('GET','/api/search?type=dash-db&limit=5000')
 assert len(listing)==9
 result={item['uid']:api('GET','/api/dashboards/uid/'+item['uid'])['dashboard'] for item in listing}
 print(json.dumps(result))
elif request['action']=='read':
 result=api('GET','/api/dashboards/uid/'+request['uid'])
 assert result['meta']['folderUid']=='powershell-mcp'
 print(json.dumps(result['dashboard']))
else:
 current=api('GET','/api/dashboards/uid/powershell-mcp-usage')
 assert current['meta']['folderUid']=='powershell-mcp'
 assert current['dashboard']['version']==request['expected_version']
 result=api('POST','/api/dashboards/db',{'dashboard':request['dashboard'],'folderUid':'powershell-mcp','overwrite':True,'message':'Reviewed org-1 overview promotion'})
 assert result['uid']=='powershell-mcp-usage'
 print(json.dumps(result))
'''

class Org1Grafana:
    def __init__(self, host, identity):
        self.host, self.identity = host, identity
    def _call(self, request):
        # The script and request travel on stdin; neither token nor dashboard is in argv.
        source = 'REQUEST=' + repr(json.dumps(request)) + '\n' + REMOTE
        completed = subprocess.run(['ssh', '-T', '-i', str(self.identity), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', self.host, 'sudo -n python3 -'], input=source, text=True, capture_output=True, timeout=60)
        if completed.returncode:
            raise RuntimeError('remote Grafana outcome unknown; inspect receipt and reconcile')
        return json.loads(completed.stdout)
    def read(self, uid):
        return self._call({'action': 'read', 'uid': uid})
    def inventory(self):
        return self._call({'action': 'inventory'})
    def write(self, dashboard, expected_version):
        self._call({'action': 'write', 'dashboard': dashboard, 'expected_version': expected_version})

def persist(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.overview-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.chmod(name, 0o600)
            json.dump(record, stream, sort_keys=True)
            stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
        if os.name != 'nt':
            directory = os.open(path.parent, os.O_RDONLY)
            try: os.fsync(directory)
            finally: os.close(directory)
    finally:
        if os.path.exists(name): os.unlink(name)

def run(adapter, preview, receipt_path, action):
    if action not in ('apply', 'rollback'): raise ValueError('invalid action')
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt['preview_digest'] != contract.digest(preview): raise ValueError('preview drift')
    else:
        if action != 'apply': raise ValueError('no receipt')
        live = adapter.read(contract.LIVE_UID)
        inventory = adapter.inventory()
        if inventory[contract.LIVE_UID] != live: raise ValueError('inventory drift')
        others = {uid: contract.digest(value) for uid, value in inventory.items() if uid not in (contract.LIVE_UID, contract.PREVIEW_UID)}
        candidate = copy.deepcopy(preview)
        candidate['uid'] = contract.LIVE_UID
        candidate['version'] = live['version'] + 1
        candidate['id'] = live.get('id')
        receipt = {'state': 'pending-apply', 'before': live, 'baseline_digest': contract.digest(live), 'preview_digest': contract.digest(preview), 'candidate_digest': contract.digest(candidate), 'other_dashboard_digests': others}
        persist(receipt_path, receipt)
    current = adapter.read(contract.LIVE_UID)
    actual_others = {uid: contract.digest(value) for uid, value in adapter.inventory().items() if uid not in (contract.LIVE_UID, contract.PREVIEW_UID)}
    if actual_others != receipt['other_dashboard_digests']: raise ValueError('non-target dashboard drift')
    state = receipt['state']
    if state == 'pending-apply':
        if contract.digest(current) == receipt['candidate_digest']:
            receipt['state'] = 'applied'; persist(receipt_path, receipt)
        elif contract.digest(current) == receipt['baseline_digest']:
            candidate = copy.deepcopy(preview)
            candidate.update(uid=contract.LIVE_UID, id=current.get('id'), version=current['version'])
            adapter.write(candidate, current['version'])
            current = adapter.read(contract.LIVE_UID)
            if contract.digest(current) != receipt['candidate_digest']: raise ValueError('promotion outcome unknown; reconcile before retry')
            receipt['state'] = 'applied'; persist(receipt_path, receipt)
        else: raise ValueError('promotion drift or unknown outcome; do not retry write')
    elif state == 'pending-rollback':
        if contract.digest(current) == receipt['rollback_digest']:
            receipt['state'] = 'rolled-back'; persist(receipt_path, receipt)
        elif contract.digest(current) != receipt['candidate_digest']:
            raise ValueError('rollback drift or unknown outcome; do not retry write')
    elif state == 'applied' and contract.digest(current) != receipt['candidate_digest']:
        raise ValueError('candidate drift')
    elif state == 'rolled-back':
        if contract.digest(current) != receipt['rollback_digest']: raise ValueError('rollback drift')
        return receipt
    if action == 'rollback' and receipt['state'] != 'rolled-back':
        if receipt['state'] == 'applied':
            before = copy.deepcopy(receipt['before']); before['version'] = current['version'] + 1
            receipt['rollback_digest'] = contract.digest(before)
            receipt['state'] = 'pending-rollback'; persist(receipt_path, receipt)
        elif receipt['state'] != 'pending-rollback': raise ValueError('invalid rollback state')
        if contract.digest(current) != receipt['rollback_digest']:
            prior = copy.deepcopy(receipt['before']); prior['version'] = current['version']
            adapter.write(prior, current['version'])
            current = adapter.read(contract.LIVE_UID)
            if contract.digest(current) != receipt['rollback_digest']: raise ValueError('rollback outcome unknown')
        receipt['state'] = 'rolled-back'; persist(receipt_path, receipt)
    if {uid: contract.digest(value) for uid, value in adapter.inventory().items() if uid not in (contract.LIVE_UID, contract.PREVIEW_UID)} != receipt['other_dashboard_digests']:
        raise ValueError('non-target dashboard drift after mutation')
    return receipt

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('inspect', 'apply', 'rollback'))
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--preview', type=Path, default=HERE.parent / 'overview-preview.json')
    parser.add_argument('--host', default='aegis@golem')
    parser.add_argument('--identity', type=Path, required=True)
    args = parser.parse_args()
    adapter = Org1Grafana(args.host, args.identity)
    preview = json.loads(args.preview.read_text())
    installed_preview = adapter.read(contract.PREVIEW_UID)
    comparable = lambda dashboard: {k: v for k, v in dashboard.items() if k not in ('id', 'version')}
    if comparable(installed_preview) != comparable(preview):
        raise ValueError('org-1 rendered preview differs from reviewed candidate')
    if args.action == 'inspect':
        inventory = adapter.inventory()
        assert set(inventory) >= {contract.LIVE_UID, contract.PREVIEW_UID}
        assert len(inventory) == 9
        print(json.dumps({'org': 1, 'live_version': inventory[contract.LIVE_UID]['version'], 'live_digest': contract.digest(inventory[contract.LIVE_UID]), 'preview_digest': contract.digest(preview), 'other_dashboard_digests': {uid: contract.digest(value) for uid, value in inventory.items() if uid not in (contract.LIVE_UID, contract.PREVIEW_UID)}, 'receipt': str(args.receipt)}))
        raise SystemExit(0)
    result = run(adapter, preview, args.receipt, args.action)
    print(json.dumps({'state': result['state'], 'receipt': str(args.receipt), 'candidate_digest': result['candidate_digest']}))

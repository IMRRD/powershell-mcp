#!/usr/bin/env bash
# Entire fixture is isolated; no host ports, production mounts, or shared volumes.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
name="pa49-$(openssl rand -hex 4)"
root=$(mktemp -d "$HOME/${name}.XXXXXXXX")
chmod 755 "$root"
cleanup() {
  if [ "$?" != 0 ]; then sudo -n docker logs "$name-grafana" 2>&1 | grep -E 'DELETE /api/orgs|failed to delete org|logger=org|status=500' | tail -8 || :; fi
  sudo -n docker rm -f "$name-run" "$name-grafana" "$name-pg" >/dev/null 2>&1 || :
  sudo -n docker network rm "$name" >/dev/null 2>&1 || :
  sudo -n rm -rf -- "$root"
}
trap cleanup EXIT
sudo -n docker network create --internal "$name" >/dev/null
openssl rand -hex 24 > "$root/pg.secret"
openssl rand -hex 24 > "$root/grafana.secret"
openssl rand -hex 24 > "$root/importer.secret"
openssl rand -hex 24 > "$root/dashboard.secret"
cp "$root/pg.secret" "$root/pg.container.secret"
cp "$root/grafana.secret" "$root/grafana.container.secret"
sudo -n chown 999:999 "$root/pg.container.secret"
sudo -n chown 472:472 "$root/grafana.container.secret"
# Synthetic CA with matching DNS SAN for verify-full.
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$root/ca.key" -out "$root/ca.crt" -subj /CN=fixture-ca -days 1 >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$root/server.key" -out "$root/server.csr" -subj /CN="$name-pg" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s-pg\n' "$name" > "$root/san.ext"
openssl x509 -req -in "$root/server.csr" -CA "$root/ca.crt" -CAkey "$root/ca.key" -CAcreateserial -out "$root/server.crt" -days 1 -extfile "$root/san.ext" >/dev/null 2>&1
chmod 644 "$root/server.crt" "$root/ca.crt"
sudo -n chown 999:999 "$root/server.key"
chmod 600 "$root/server.key"
printf 'local all postgres trust\nhostssl all all all scram-sha-256\n' > "$root/pg_hba.conf"
chmod 644 "$root/pg_hba.conf"
sudo -n docker run -d --name "$name-pg" --network "$name" -v "$root:/fixture:ro" -e POSTGRES_PASSWORD_FILE=/fixture/pg.container.secret postgres:17.11-bookworm -c ssl=on -c ssl_cert_file=/fixture/server.crt -c ssl_key_file=/fixture/server.key -c ssl_ca_file=/fixture/ca.crt -c hba_file=/fixture/pg_hba.conf >/dev/null
mkdir "$root/grafana-logs"
sudo -n chown 472:472 "$root/grafana-logs"
sudo -n docker run -d --name "$name-grafana" --network "$name" -v "$root:/fixture" -e GF_LOG_MODE=file -e GF_PATHS_LOGS=/fixture/grafana-logs -e GF_SECURITY_ADMIN_PASSWORD__FILE=/fixture/grafana.container.secret -e GF_SECURITY_ALLOW_EMBEDDING=false -e GF_AUTH_ANONYMOUS_ENABLED=false grafana/grafana:13.1.1 >/dev/null
printf 'host=%s-pg port=5432 user=postgres dbname=postgres password=%s sslmode=verify-full sslrootcert=/fixture/ca.crt\n' "$name" "$(<"$root/pg.secret")" > "$root/admin.dsn"
printf 'basic:admin:%s\n' "$(<"$root/grafana.secret")" > "$root/grafana.token"
mkdir "$root/wheels"
sudo -n docker run --rm -v "$root:/fixture" python:3.12-slim-bookworm pip download -q -d /fixture/wheels 'psycopg[binary]==3.3.6'
cat > "$root/run.sh" <<'RUN'
#!/bin/sh
set -eu
pip -q install --no-index --find-links /fixture/wheels 'psycopg[binary]==3.3.6'
for n in $(seq 1 60); do
  if python -c 'import psycopg;psycopg.connect(open("/fixture/admin.dsn").read()).close()' 2>/dev/null && python -c 'import urllib.request,os; urllib.request.urlopen("http://"+os.environ["FIXTURE_NAME"]+"-grafana:3000/api/health",timeout=2)' 2>/dev/null; then break; fi
  sleep 2
done
python -c 'import psycopg;psycopg.connect(open("/fixture/admin.dsn").read()).close()'
python - <<'PY'
import json,psycopg
with psycopg.connect(open('/fixture/admin.dsn').read()) as c:
 with c.cursor() as q:
  q.execute('SELECT system_identifier FROM pg_control_system()')
  cluster=str(q.fetchone()[0])
with open('/fixture/provenance.json','w') as f:
 json.dump({'kind':'isolated-container','receipt':'/fixture/receipt.json','cluster_id':cluster},f)
PY
set -- --grafana-error-log /fixture/grafana-logs/grafana.log --disposable-fixture-file /fixture/provenance.json --receipt /fixture/receipt.json --approved-admin admin --pg-admin-dsn-file /fixture/admin.dsn --grafana-url "http://${FIXTURE_NAME}-grafana:3000" --grafana-token-file /fixture/grafana.token --importer-secret-file /fixture/importer.secret --dashboard-secret-file /fixture/dashboard.secret --ca-file /fixture/ca.crt --db-host "${FIXTURE_NAME}-pg:5432"
python /src/operations/activate_private.py apply "$@"
python /src/operations/activate_private.py verify "$@"
python /src/operations/activate_private.py apply "$@"
python - <<'PY'
import base64,json,os,urllib.request,urllib.error
host='http://'+os.environ['FIXTURE_NAME']+'-grafana:3000'
admin=open('/fixture/grafana.token').read().strip().removeprefix('basic:')
def request(path,user,password,method='GET',data=None,org=None):
 headers={'Authorization':'Basic '+base64.b64encode((user+':'+password).encode()).decode(),'Content-Type':'application/json'}
 if org: headers['X-Grafana-Org-Id']=str(org)
 req=urllib.request.Request(host+path,json.dumps(data).encode() if data is not None else None,headers,method=method)
 try:
  with urllib.request.urlopen(req) as response: return response.status,json.load(response)
 except urllib.error.HTTPError as error: return error.code,None
code,orgs=request('/api/orgs','admin',admin.split(':',1)[1]); assert code==200
oid=next(o['id'] for o in orgs if o['name']=='Private telemetry analytics')
code,ds=request('/api/datasources/uid/private-telemetry-pg','admin',admin.split(':',1)[1],org=oid); assert code==200
password=open('/fixture/importer.secret').read().strip()
code,_=request('/api/admin/users','admin',admin.split(':',1)[1],'POST',{'name':'outsider','email':'outsider@fixture.invalid','login':'outsider','password':password}); assert code==200,code
query={'from':'now-1h','to':'now','queries':[{'refId':'A','datasource':{'uid':ds['uid']},'rawSql':'SELECT 1 AS time, 1 AS value','format':'table'}]}
code,result=request('/api/ds/query','admin',admin.split(':',1)[1],'POST',query,oid); assert code==200 and result['results']['A'].get('frames'),(code,result)
code,_=request('/api/ds/query','outsider',password,'POST',query,oid); assert code in (401,403),code
print('isolated cross-org query: admin 200, outsider denied',code)
PY
# Refuse destructive cleanup while any known or unknown relation holds data.
python - <<'PY'
import psycopg
with psycopg.connect(open('/fixture/admin.dsn').read(),dbname='hermes_mcp_analytics_private') as db:
 with db.cursor() as q:
  q.execute("INSERT INTO telemetry_checkpoint(source_key,device,inode,position,prefix_hash) VALUES ('fixture',1,1,1,'fixture')")
PY
if python /src/operations/activate_private.py rollback "$@" > /fixture/blocked.out 2>&1; then echo 'populated checkpoint rollback unexpectedly completed' >&2; exit 1; fi
grep -q 'retention decision required' /fixture/blocked.out
python - <<'PY'
import psycopg
with psycopg.connect(open('/fixture/admin.dsn').read(),dbname='hermes_mcp_analytics_private') as db:
 with db.cursor() as q:
  q.execute('DELETE FROM telemetry_checkpoint')
  q.execute('CREATE TABLE unexpected_data (id integer)')
  q.execute('INSERT INTO unexpected_data VALUES (1)')
PY
if python /src/operations/activate_private.py rollback "$@" > /fixture/blocked.out 2>&1; then echo 'foreign table rollback unexpectedly completed' >&2; exit 1; fi
grep -q 'retention decision required' /fixture/blocked.out
python - <<'PY'
import psycopg
with psycopg.connect(open('/fixture/admin.dsn').read(),dbname='hermes_mcp_analytics_private') as db:
 with db.cursor() as q:q.execute('DROP TABLE unexpected_data')
PY
for attempt in 1 2; do
  if python /src/operations/activate_private.py rollback "$@" > /fixture/rollback.out 2>&1; then echo 'rollback unexpectedly completed' >&2; exit 1; fi
  grep -q 'rollback incomplete: retained empty private org' /fixture/rollback.out || { cat /fixture/rollback.out >&2; exit 1; }
done
python - <<'PY'
import json,psycopg,urllib.request,base64,os,urllib.error
r=json.load(open('/fixture/receipt.json'))
assert set(r['owned'])=={'org'} and not r['pending'] and r['retained_org']['reason']=='Grafana 13.1.1 unsupported DeleteCollection',r
with psycopg.connect(open('/fixture/admin.dsn').read()) as c:
 with c.cursor() as q:
  q.execute("SELECT count(*) FROM pg_database WHERE datname='hermes_mcp_analytics_private'"); assert q.fetchone()[0]==0
  q.execute("SELECT count(*) FROM pg_roles WHERE rolname IN ('hermes_analytics_importer','hermes_analytics_dashboard')"); assert q.fetchone()[0]==0
token=open('/fixture/grafana.token').read().strip().removeprefix('basic:')
req=urllib.request.Request('http://'+os.environ['FIXTURE_NAME']+'-grafana:3000/api/orgs',headers={'Authorization':'Basic '+base64.b64encode(token.encode()).decode()})
with urllib.request.urlopen(req) as response: orgs=json.load(response)
oid=r['retained_org']['id']
assert any(org['id']==oid and org['name']=='Private telemetry analytics' for org in orgs)
for path in ('/api/search?type=dash-db','/api/search?type=dash-folder','/api/datasources'):
 req=urllib.request.Request('http://'+os.environ['FIXTURE_NAME']+'-grafana:3000'+path,headers={'Authorization':'Basic '+base64.b64encode(token.encode()).decode(),'X-Grafana-Org-Id':str(oid)})
 with urllib.request.urlopen(req) as response: assert json.load(response)==[],path
req=urllib.request.Request('http://'+os.environ['FIXTURE_NAME']+'-grafana:3000/api/orgs/'+str(oid)+'/users',headers={'Authorization':'Basic '+base64.b64encode(token.encode()).decode()})
with urllib.request.urlopen(req) as response: users=json.load(response)
assert len(users)==1 and users[0]['login']=='admin' and users[0]['role']=='Admin',users
print('isolated rollback: zero DB and roles; retained empty admin-only org, receipt-owned residual; repeat stable')
PY
python /src/operations/activate_private.py apply "$@"
python /src/operations/activate_private.py verify "$@"
for attempt in 1 2; do
  if python /src/operations/activate_private.py rollback "$@" > /fixture/rollback.out 2>&1; then echo 'rollback unexpectedly completed' >&2; exit 1; fi
  grep -q 'rollback incomplete: retained empty private org' /fixture/rollback.out || { cat /fixture/rollback.out >&2; exit 1; }
done
# Separate receipt/fixture is required for the fresh database-create crash path.
cp /fixture/receipt.json /fixture/retained-receipt.json
rm /fixture/receipt.json
python - "$@" <<'PY'
import json,os,subprocess,sys
args=sys.argv[1:]
child='''import importlib.util,os,signal,sys
spec=importlib.util.spec_from_file_location("activation","/src/operations/activate_private.py")
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
save=module._save
def interrupt(path,receipt):
 if "database" in receipt["owned"] and "database" not in receipt["pending"]:
  os.kill(os.getpid(),signal.SIGKILL)
 return save(path,receipt)
module._save=interrupt
sys.argv=["activate_private.py","apply"]+sys.argv[1:]
module.main()
'''
result=subprocess.run([sys.executable,'-c',child,*args],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
assert result.returncode==-9,(result.returncode,result.stderr.decode()[:300])
receipt=json.load(open('/fixture/receipt.json'))
assert 'database' in receipt['pending'] and 'database' not in receipt['owned']
print('isolated crash: child SIGKILL after DB mutation, before receipt save')
PY
python /src/operations/activate_private.py rollback "$@"
python - <<'PY'
import json,psycopg
receipt=json.load(open('/fixture/receipt.json'))
assert not receipt['owned'] and not receipt['pending']
with psycopg.connect(open('/fixture/admin.dsn').read()) as db:
 with db.cursor() as cursor:
  cursor.execute("SELECT count(*) FROM pg_database WHERE datname='hermes_mcp_analytics_private'")
  assert cursor.fetchone()[0]==0
print('isolated fresh-process crash recovery: DB absent, receipt empty')
PY
# Missing event relation cannot conceal retained checkpoint data.
cp /fixture/retained-receipt.json /fixture/receipt.json
python /src/operations/activate_private.py apply "$@"
python - <<'PY'
import psycopg
with psycopg.connect(open('/fixture/admin.dsn').read(),dbname='hermes_mcp_analytics_private') as db:
 with db.cursor() as q:
  q.execute("INSERT INTO telemetry_checkpoint(source_key,device,inode,position,prefix_hash) VALUES ('fixture',1,1,1,'fixture')")
  q.execute('DROP TABLE telemetry_event CASCADE')
PY
if python /src/operations/activate_private.py rollback "$@" > /fixture/blocked.out 2>&1; then echo 'missing event table rollback unexpectedly completed' >&2; exit 1; fi
grep -q 'retention decision required' /fixture/blocked.out
python - <<'PY'
import psycopg
with psycopg.connect(open('/fixture/admin.dsn').read()) as db:
 with db.cursor() as q:
  q.execute("SELECT count(*) FROM pg_database WHERE datname='hermes_mcp_analytics_private'")
  assert q.fetchone()[0]==1
print('isolated negative cases: checkpoint, unknown table, absent event with data all retained')
PY
RUN
chmod 755 "$root/run.sh"
sudo -n docker run --name "$name-run" --network "$name" -e "FIXTURE_NAME=$name" -v "$root:/fixture" -v "$PWD:/src:ro" python:3.12-slim-bookworm sh /fixture/run.sh

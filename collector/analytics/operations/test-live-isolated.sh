#!/usr/bin/env bash
# Entire fixture is isolated; no host ports, production mounts, or shared volumes.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
name="pa49-$(openssl rand -hex 4)"
root=$(mktemp -d "$HOME/${name}.XXXXXXXX")
chmod 755 "$root"
cleanup() {
  if [ "$?" != 0 ]; then sudo -n docker logs "$name-pg" 2>&1 | tail -25; sudo -n docker logs "$name-grafana" 2>&1 | tail -12; fi
  sudo -n docker rm -f "$name-run" "$name-grafana" "$name-pg" >/dev/null 2>&1 || :
  sudo -n docker network rm "$name" >/dev/null 2>&1 || :
  rm -rf "$root"
}
trap cleanup EXIT
sudo -n docker network create --internal "$name" >/dev/null
openssl rand -hex 24 > "$root/pg.secret"
openssl rand -hex 24 > "$root/grafana.secret"
openssl rand -hex 24 > "$root/importer.secret"
openssl rand -hex 24 > "$root/dashboard.secret"
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
sudo -n docker run -d --name "$name-pg" --network "$name" -v "$root:/fixture:ro" -e POSTGRES_PASSWORD="$(<"$root/pg.secret")" postgres:17.11-bookworm -c ssl=on -c ssl_cert_file=/fixture/server.crt -c ssl_key_file=/fixture/server.key -c ssl_ca_file=/fixture/ca.crt -c hba_file=/fixture/pg_hba.conf >/dev/null
sudo -n docker run -d --name "$name-grafana" --network "$name" -e GF_SECURITY_ADMIN_PASSWORD="$(<"$root/grafana.secret")" -e GF_SECURITY_ALLOW_EMBEDDING=false -e GF_AUTH_ANONYMOUS_ENABLED=false grafana/grafana:13.1.1 >/dev/null
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
set -- --receipt /fixture/receipt.json --approved-admin admin --pg-admin-dsn-file /fixture/admin.dsn --grafana-url "http://${FIXTURE_NAME}-grafana:3000" --grafana-token-file /fixture/grafana.token --importer-secret-file /fixture/importer.secret --dashboard-secret-file /fixture/dashboard.secret --ca-file /fixture/ca.crt --db-host "${FIXTURE_NAME}-pg:5432"
python /src/operations/activate_private.py apply "$@"
python /src/operations/activate_private.py verify "$@"
python /src/operations/activate_private.py apply "$@"
python /src/operations/activate_private.py rollback "$@"
python - <<'PY'
import json,psycopg,urllib.request,base64
r=json.load(open('/fixture/receipt.json'))
assert not r['owned'] and not r['pending'],r
with psycopg.connect(open('/fixture/admin.dsn').read()) as c:
 with c.cursor() as q:
  q.execute("SELECT count(*) FROM pg_database WHERE datname='hermes_mcp_analytics_private'"); assert q.fetchone()[0]==0
  q.execute("SELECT count(*) FROM pg_roles WHERE rolname IN ('hermes_analytics_importer','hermes_analytics_dashboard')"); assert q.fetchone()[0]==0
print('isolated rollback: zero DB and roles; receipt empty')
PY
RUN
chmod 755 "$root/run.sh"
sudo -n docker run --name "$name-run" --network "$name" -e "FIXTURE_NAME=$name" -v "$root:/fixture" -v "$PWD:/src:ro" python:3.12-slim-bookworm sh /fixture/run.sh

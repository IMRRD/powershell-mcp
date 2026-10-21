#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(mktemp -d "$HOME/analytics-rehearsal.XXXXXXXX")
nonce=$(basename "$root" | cut -d. -f2 | tr 'A-Z' 'a-z')
db="hermes_mcp_analytics_rehearsal_${nonce}"
restore="${db}_restore"
imp="analytics_${nonce}_importer"
dash="analytics_${nonce}_dashboard"
container=$(sudo -n docker ps --filter name=telemetry_storage_postgres --format '{{.ID}}' | head -n 1)
[ -n "$container" ]
psql_admin() { sudo -n docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U telemetry_admin "$@"; }
cleanup() {
  if [ "${remote_uploaded:-0}" = 1 ]; then
    printf 'rm %s\nbye\n' "$remote" | sudo -n sftp -q -b - -i /opt/ialogics/telemetry-postgres/backup_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/aegis/.ssh/known_hosts aegis@192.168.110.107 || echo 'remote cleanup failed; investigate owned filename' >&2
  fi
  if [ "${KEEP_REHEARSAL:-0}" != 1 ]; then
    psql_admin -d telemetry -c "DROP DATABASE IF EXISTS $restore WITH (FORCE)" >/dev/null || :
    psql_admin -d telemetry -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null || :
    psql_admin -d telemetry -c "DROP ROLE IF EXISTS $dash" >/dev/null || :
    psql_admin -d telemetry -c "DROP ROLE IF EXISTS $imp" >/dev/null || :
    rm -rf -- "$root"
  else printf 'retained=%s db=%s restore=%s\n' "$root" "$db" "$restore"; fi
}
trap cleanup EXIT
printf 'identity=%s container=%s\n' "$db" "$container"
psql_admin -d telemetry -Atqc "SELECT current_user,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user" 
for entry in 'schema.sql bbb62ecdb50c1f9bf461784fdbaa49733587933b' 'roles.sql 239b8e8718351950e8a22e139315a0c15e3d9ad3' 'import_jsonl.py 9d734555790ce54a537c21e29e14522143a6e68d'; do
  read -r file expected <<< "$entry"
  [ -f "$HOME/analytics-stage/$file" ] && [ ! -L "$HOME/analytics-stage/$file" ]
  [ "$(git hash-object "$HOME/analytics-stage/$file")" = "$expected" ] || { echo "source mismatch: $file" >&2; exit 1; }
  cp -- "$HOME/analytics-stage/$file" "$root/$file"
  [ "$(git hash-object "$root/$file")" = "$expected" ]
  printf 'source=%s git-blob=%s\n' "$file" "$expected"
done
python3 - "$root" "$imp" "$dash" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1])/'roles.sql'; t=p.read_text(); t=t.replace('telemetry_importer',sys.argv[2]).replace('telemetry_dashboard',sys.argv[3]); (p.parent/'rehearsal_roles.sql').write_text(t)
PY
openssl rand -hex 32 > "$root/importer.secret"
openssl rand -hex 32 > "$root/dashboard.secret"
# Secrets flow through private files and psql stdin, never process arguments.
{ printf "CREATE ROLE %s LOGIN PASSWORD '%s';\n" "$imp" "$(<"$root/importer.secret")"; } | psql_admin -d telemetry >/dev/null
{ printf "CREATE ROLE %s LOGIN PASSWORD '%s';\n" "$dash" "$(<"$root/dashboard.secret")"; } | psql_admin -d telemetry >/dev/null
psql_admin -d telemetry -c "CREATE DATABASE $db OWNER telemetry_admin" >/dev/null
cat "$root/schema.sql" | psql_admin -d "$db" >/dev/null
cat "$root/rehearsal_roles.sql" | psql_admin -d "$db" >/dev/null
# Synthetic-only fixture; no collector history is accessed.
printf '%s\n' '{"event":"startup","hostId":"synthetic-1","version":"0.7.0","os":"linux","ts":"2026-01-01T00:00:00.000Z","_receivedAt":"2026-01-01T00:00:01.000Z","eventId":"11111111-1111-4111-8111-111111111111","schemaVersion":1}' '{"event":"tool_counts","hostId":"synthetic-1","version":"0.7.0","os":"linux","ts":"2026-01-01T00:00:02.000Z","_receivedAt":"2026-01-01T00:00:03.000Z","eventId":"22222222-2222-4222-8222-222222222222","schemaVersion":1,"counts":{"ssh_exec":3}}' > "$root/fixture.jsonl"
printf '%s\n' '{"internalHostIds":[],"testHostIds":[]}' > "$root/classes.json"
# Join only the existing container network namespace; no HBA edits or live DB mutation.
# Password resides in a private file, not argv, Git, or standard output.
cat > "$root/run_import.py" <<'PY'
import os,pathlib,runpy,sys,psycopg
root=pathlib.Path('/rehearsal')
password=(root/'importer.secret').read_text().strip()
os.environ['ANALYTICS_DSN']='host=docker-xrv3 hostaddr=127.0.0.1 port=5432 dbname='+os.environ['REHEARSAL_DB']+' user='+os.environ['REHEARSAL_IMPORTER']+' password='+password+' sslmode=verify-full sslrootcert=/trust/root.crt'
with psycopg.connect(os.environ['ANALYTICS_DSN']) as conn:
    with conn.cursor() as cur:
        cur.execute('SELECT ssl,version,cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()')
        ssl,version,cipher=cur.fetchone()
        assert ssl and version and cipher, 'importer backend is not TLS'
print('importer actual-login verify-full TLS')
sys.argv=['import_jsonl.py','--source',str(root/'fixture.jsonl'),'--classification',str(root/'classes.json')]
runpy.run_path(str(root/'import_jsonl.py'),run_name='__main__')
PY
ca=/opt/ialogics/telemetry-postgres/data/tls/root.crt
sudo -n test -r "$ca" || { echo 'trusted CA unavailable' >&2; exit 1; }
sudo -n docker run --rm --network "container:$container" -v "$root:/rehearsal:ro" -v "$ca:/trust/root.crt:ro" -e "REHEARSAL_DB=$db" -e "REHEARSAL_IMPORTER=$imp" python:3.12-slim-bookworm sh -c 'pip -q install "psycopg[binary]==3.3.6" && python /rehearsal/run_import.py'
cat > "$root/check_dashboard.py" <<'PY'
import os,pathlib,psycopg
root=pathlib.Path('/rehearsal')
conn=psycopg.connect(host='docker-xrv3',hostaddr='127.0.0.1',port=5432,dbname=os.environ['REHEARSAL_DB'],user=os.environ['REHEARSAL_DASHBOARD'],password=(root/'dashboard.secret').read_text().strip(),sslmode='verify-full',sslrootcert='/trust/root.crt')
with conn:
    with conn.cursor() as cur:
        cur.execute('SELECT ssl,version,cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()')
        ssl,version,cipher=cur.fetchone()
        assert ssl and version and cipher, 'dashboard backend is not TLS'
        cur.execute('SELECT count(*) FROM dashboard_events')
        assert cur.fetchone()[0]==2
        for sql in ('SELECT count(*) FROM telemetry_event','INSERT INTO telemetry_checkpoint VALUES (\'deny\',0,0,0,\'x\')'):
            try:
                with conn.transaction(): cur.execute(sql)
            except psycopg.errors.InsufficientPrivilege: pass
            else: raise AssertionError('dashboard raw privilege unexpectedly granted')
print('dashboard actual-login verify-full TLS; views allowed; raw read/write denied')
PY
sudo -n docker run --rm --network "container:$container" -v "$root:/rehearsal:ro" -v "$ca:/trust/root.crt:ro" -e "REHEARSAL_DB=$db" -e "REHEARSAL_DASHBOARD=$dash" python:3.12-slim-bookworm sh -c 'pip -q install "psycopg[binary]==3.3.6" && python /rehearsal/check_dashboard.py'
psql_admin -d "$db" -Atqc 'SELECT count(*), (SELECT coalesce(sum(calls),0) FROM telemetry_tool), (SELECT count(*) FROM telemetry_checkpoint) FROM telemetry_event' > "$root/before.txt"
sudo -n docker exec "$container" pg_dump -U telemetry_admin -Fc -d "$db" > "$root/analytics.dump"
sha256sum "$root/analytics.dump"
remote="analytics-rehearsal-${nonce}.dump"
local_copy="$root/roundtrip.dump"
printf 'put %s %s\nget %s %s\nbye\n' "$root/analytics.dump" "$remote" "$remote" "$local_copy" > "$root/transfer.batch"
sudo -n sftp -q -b "$root/transfer.batch" -i /opt/ialogics/telemetry-postgres/backup_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/aegis/.ssh/known_hosts aegis@192.168.110.107
remote_uploaded=1
sudo -n cmp "$root/analytics.dump" "$local_copy"
sudo -n sha256sum "$local_copy"
printf 'rm %s\nbye\n' "$remote" > "$root/remote-cleanup.batch"
sudo -n sftp -q -b "$root/remote-cleanup.batch" -i /opt/ialogics/telemetry-postgres/backup_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/aegis/.ssh/known_hosts aegis@192.168.110.107
remote_uploaded=0
psql_admin -d telemetry -c "CREATE DATABASE $restore OWNER telemetry_admin" >/dev/null
sudo -n cat "$local_copy" | sudo -n docker exec -i "$container" pg_restore -U telemetry_admin -d "$restore" --no-owner --no-acl 2> "$root/restore.log"
psql_admin -d "$restore" -Atqc 'SELECT count(*), (SELECT coalesce(sum(calls),0) FROM telemetry_tool), (SELECT count(*) FROM telemetry_checkpoint) FROM telemetry_event' > "$root/after.txt"
cmp "$root/before.txt" "$root/after.txt"
printf 'aggregate=%s\n' "$(cat "$root/after.txt")"
for query in 'SELECT count(*) FROM telemetry_event' 'INSERT INTO telemetry_checkpoint VALUES ('\''deny'\'',0,0,0,'\''x'\'')'; do
 if printf 'SET ROLE %s; %s;\n' "$dash" "$query" | psql_admin -d "$db" > "$root/denial.log" 2>&1; then echo 'dashboard raw privilege failure' >&2; exit 1; fi
 grep -q 'permission denied' "$root/denial.log" || { echo 'unexpected dashboard failure' >&2; exit 1; }
done
printf 'SET ROLE %s; SELECT count(*) FROM dashboard_events; SELECT count(*) FROM adoption_utc('\''2025-01-01'\'', '\''2027-01-01'\'');\n' "$dash" | psql_admin -d "$db" -At
printf 'role-denials=2 offhost-restore=matched remote=%s\n' "$remote"

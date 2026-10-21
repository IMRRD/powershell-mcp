#!/usr/bin/env python
"""Private, fail-closed weekly digest. The installed service is disabled pending review."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import sys

UTC = dt.timezone.utc
ORIGINS = ('internal', 'test', 'unknown_origin')
SAFE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')


def closed_week(now):
    now = now.astimezone(UTC)
    end = (now - dt.timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return end - dt.timedelta(days=7), end


def aggregates(connection, start, end):
    # Only dashboard grants: no raw event tables, identifiers, or payloads.
    with connection.cursor() as cur:
        cur.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        cur.execute('SELECT origin, observed_installations, active_installations, startup_only_installations FROM adoption_utc(%s,%s)', (start, end))
        adoption = cur.fetchall()
        cur.execute('SELECT origin, event, count(*) FROM dashboard_events WHERE event_at >= %s AND event_at < %s GROUP BY origin,event', (start, end))
        events = cur.fetchall()
        cur.execute('SELECT origin, stream, tool, sum(calls) FROM dashboard_tools WHERE event_at >= %s AND event_at < %s GROUP BY origin,stream,tool', (start, end))
        tools = cur.fetchall()
        cur.execute('SELECT origin,tool,axis,bucket,sum(calls) FROM dashboard_metric_axes WHERE event_at >= %s AND event_at < %s GROUP BY origin,tool,axis,bucket', (start, end))
        axes = cur.fetchall()
        cur.execute('SELECT event_time_quality, receipt_time_quality, count(*) FROM dashboard_events WHERE received_at >= %s AND received_at < %s GROUP BY event_time_quality,receipt_time_quality', (start, end))
        quality = cur.fetchall()
        # Receipt coverage is tested across the entire closed week, not just at current time.
        cur.execute("SELECT date_trunc('hour', received_at), count(*) FROM dashboard_events WHERE received_at >= %s AND received_at < %s GROUP BY 1 ORDER BY 1", (start, end))
        receipts = cur.fetchall()
        cur.execute("SELECT last_import FROM delivery_health_utc(%s,%s,interval '2 hours')", (end, start))
        imported = cur.fetchone()[0]
    return dict(adoption=adoption, events=events, tools=tools, axes=axes, quality=quality, receipts=receipts, imported=imported)


def render(data, start, end, now):
    if not data['imported'] or now - data['imported'] > dt.timedelta(hours=2):
        raise ValueError('missing or stale importer checkpoint')
    if not data['receipts']:
        raise ValueError('missing weekly receipts')
    hours = {row[0] for row in data['receipts']}
    if any(start + dt.timedelta(hours=i) not in hours for i in range(168)):
        raise ValueError('partial weekly receipt coverage')
    if any(a != 'valid' or b != 'valid' for a, b, n in data['quality'] if n):
        raise ValueError('timestamp quality is partial (all-history)')
    lines = [f'Private telemetry digest [{start.isoformat()}, {end.isoformat()}) UTC',
             'Installation IDs are proxies, not people. Unknown origin is not external users.',
             'Receipts cover each hour; this does not prove upstream delivery of every event.',
             'Counts and metrics are overlapping streams, never added into unique calls.']
    # Fail closed on any small cell: release no numeric marginals or complementary
    # totals, including installation proxies and overlapping metric axes.
    small = any(0 < n < 10 for key in ('adoption', 'events', 'tools', 'axes')
                for row in data[key] for n in (row[1:] if key == 'adoption' else row[-1:]))
    seen = set()
    for origin, observed, active, startup in data['adoption']:
        if origin not in ORIGINS or origin in seen:
            raise ValueError('unexpected adoption origin')
        seen.add(origin)
    for origin, event, n in data['events']:
        if origin not in ORIGINS or event not in ('startup', 'tool_counts', 'tool_metrics'):
            raise ValueError('unexpected event dimension')
    for origin, stream, tool, n in data['tools']:
        if origin not in ORIGINS or stream not in ('counts', 'metrics') or not SAFE.fullmatch(tool):
            raise ValueError('unexpected tool dimension')
    for origin, tool, axis, bucket, n in data['axes']:
        if origin not in ORIGINS or not SAFE.fullmatch(tool) or axis not in ('outcomes', 'durations', 'features') or not SAFE.fullmatch(bucket):
            raise ValueError('unexpected metric dimension')
    if small:
        lines.append('Detailed adoption, event, tool and axis counts withheld: small cells or complementary disclosure risk; no zero is implied.')
    else:
        for origin, observed, active, startup in data['adoption']:
            lines.append(f'{origin}: observed installations={observed}; active={active}; startup-only={startup}')
        for origin, event, n in data['events']:
            lines.append(f'event {origin}/{event}: {n}')
        for origin, stream, tool, n in data['tools']:
            lines.append(f'{stream} {origin}/{tool}: {n}')
        for origin, tool, axis, bucket, n in data['axes']:
            lines.append(f'metric {origin}/{tool}/{axis}/{bucket}: {n}')
    lines.append(f'Import checkpoint: {data["imported"].isoformat()}; weekly hourly receipt coverage: 168/168')
    lines.append('Retention/capacity: no automated age deletion; verify protected JSONL, database/WAL/index growth and restore-tested backups before archive decisions.')
    return '\n'.join(lines) + '\n'


def submit(message, recipient, config):
    # Credentials are supplied only through the protected environment, never CLI, logs or receipt.
    with smtplib.SMTP(config['host'], int(config['port']), timeout=15) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(config['username'], os.environ['DIGEST_SMTP_PASSWORD'])
        smtp.send_message(message, from_addr=config['sender'], to_addrs=[recipient])


def main(argv=None, clock=None, connect=None, deliver=submit):
    from email.message import EmailMessage
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--preview', action='store_true')
    args = parser.parse_args(argv)
    config = json.loads(Path(args.config).read_text(encoding='utf8'))
    now = clock or dt.datetime.now(UTC)
    start, end = closed_week(now)
    if now < end + dt.timedelta(hours=2):
        raise ValueError('allow two hours for final import')
    if connect is None:
        import psycopg
        connect = lambda: psycopg.connect(os.environ['ANALYTICS_DSN'], connect_timeout=10, options='-c statement_timeout=15000 -c default_transaction_read_only=on')
    with connect() as conn:
        body = render(aggregates(conn, start, end), start, end, now)
    if args.preview:
        return body
    if not config.get('enabled', False):
        raise ValueError('production delivery disabled pending review')
    recipient = config.get('recipient')
    approved = config.get('approved_recipients')
    address = re.compile(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z')
    if not isinstance(approved, list) or not approved or not all(isinstance(a, str) and address.fullmatch(a) for a in approved):
        raise ValueError('approved private recipient required')
    if not isinstance(recipient, str) or not address.fullmatch(recipient) or recipient not in approved:
        raise ValueError('approved private recipient required')
    sender = config.get('sender')
    if not isinstance(sender, str) or not address.fullmatch(sender):
        raise ValueError('invalid sender header')
    if not all(config.get(k) for k in ('host', 'port', 'username')):
        raise ValueError('mail transport configuration incomplete')
    msg = EmailMessage()
    msg['From'] = sender
    msg['To'] = recipient
    msg['Subject'] = f'Private telemetry weekly digest {start.date()} to {end.date()} UTC'
    msg.set_content(body)
    msg.as_bytes()  # Finish and validate serialization before recording any intent.
    state = Path(args.state_dir)
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    digest_key = hashlib.sha256((start.isoformat() + '/' + end.isoformat() + '/' + recipient).encode()).hexdigest()
    claim = state / (digest_key + '.attempted')
    # Exclusive durable pre-send intent. Unknown SMTP acceptance is never retried automatically.
    fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('submission attempted; inspect transport and recipient before any manual reconciliation\n')
        f.flush()
        os.fsync(f.fileno())
    deliver(msg, recipient, config)
    return 'submission accepted by transport; external delivery not proven\n'


if __name__ == '__main__':
    try:
        print(main(), end='')
    except Exception:
        print('Weekly digest failed or delivery state uncertain; no automatic resend. Inspect private state and health.', file=sys.stderr)
        sys.exit(1)

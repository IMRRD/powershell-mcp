#!/usr/bin/env python
"""Private, fail-closed weekly digest. The installed service is disabled pending review."""
import argparse
import datetime as dt
from decimal import Decimal
import hashlib
import html
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import sys

UTC = dt.timezone.utc
ORIGINS = ('internal', 'test', 'unknown_origin')
RECIPIENT = 'isak@ialogics.com'
# Same finite dimensions as the client/importer contract; never echo arbitrary SQL labels.
TOOLS = {'run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program', 'runtime_capabilities', 'start_execution', 'execution_status', 'read_execution_output', 'cancel_execution', 'read_output_log', 'delete_output_log'}
AXES = {'outcomes': {'success', 'nonzero', 'error', 'timeout', 'cancelled', 'unknown'}, 'durations': {'lt100', 'lt1000', 'lt10000', 'gte10000'}, 'features': {'execution', 'inspection', 'remote', 'transfer', 'lifecycle', 'logs'}}
DURATION_LABELS = {'lt100': 'under 100 ms', 'lt1000': '100–999 ms', 'lt10000': '1–9.999 seconds', 'gte10000': '10 seconds or more'}
ADDRESS = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z")


def private_counts(config):
    approval = config.get('private_small_counts')
    if approval is None:
        return False
    audience = {k: config.get(k) for k in ('sender', 'recipient', 'approved_recipients')}
    if (not isinstance(approval, dict) or approval != audience or
            audience['recipient'] != RECIPIENT or audience['approved_recipients'] != [RECIPIENT] or
            not isinstance(audience['sender'], str) or not ADDRESS.fullmatch(audience['sender'])):
        raise ValueError('private small-count audience approval mismatch')
    return True


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
        # Unwindowable receipts cannot be assigned to this or any other week.
        cur.execute("SELECT count(*) FROM dashboard_events WHERE received_at IS NULL OR receipt_time_quality IS DISTINCT FROM 'valid'")
        unknown_receipt_count = cur.fetchone()[0]
        # Receipt coverage is tested across the entire closed week, not just at current time.
        cur.execute("SELECT date_trunc('hour', received_at, 'UTC'), count(*) FROM dashboard_events WHERE received_at >= %s AND received_at < %s GROUP BY 1 ORDER BY 1", (start, end))
        receipts = cur.fetchall()
        cur.execute("SELECT last_import FROM delivery_health_utc(%s,%s,interval '2 hours')", (end, start))
        imported = cur.fetchone()[0]
    return dict(adoption=adoption, events=events, tools=tools, axes=axes, quality=quality, unknown_receipt_count=unknown_receipt_count, receipts=receipts, imported=imported)


def render(data, start, end, now, config=None):
    return report(data, start, end, now, config)[0]


def render_html(data, start, end, now, config=None):
    return report(data, start, end, now, config)[1]


def report(data, start, end, now, config=None):
    exact = private_counts(config or {})
    if data['unknown_receipt_count'] is None or data['unknown_receipt_count'] > 0:
        raise ValueError('unassignable receipt time exists (all-history); weekly activity cannot be certified')
    if not data['imported'] or not dt.timedelta(0) <= now - data['imported'] <= dt.timedelta(hours=2):
        raise ValueError('missing or stale importer checkpoint')
    if not data['receipts']:
        raise ValueError('missing weekly receipts')
    hours = {hour for hour, count in data['receipts'] if count > 0 and start <= hour < end}
    if any(start + dt.timedelta(hours=i) not in hours for i in range(168)):
        raise ValueError('partial weekly receipt coverage')
    if not data['quality'] or any(a != 'valid' or b != 'valid' for a, b, n in data['quality'] if n):
        raise ValueError('timestamp quality is partial (selected receipt week)')
    title = f'Private telemetry digest: {start:%d %b %Y} to {end:%d %b %Y} UTC (end exclusive)'
    lines = [title]
    blocks = ['<!doctype html><html><body style="font-family:Arial,sans-serif;color:#17253b;max-width:900px">',
              '<h1>' + html.escape(title) + '</h1>']
    def note(value):
        lines.append(value)
        blocks.append('<p>' + html.escape(value) + '</p>')
    def table(title, headers, rows, bar_column=None):
        note(title)
        lines.append(' | '.join(headers))
        blocks.append('<table cellpadding="7" cellspacing="0" style="border-collapse:collapse;width:100%"><tr>' +
                      ''.join('<th style="text-align:left;background:#e9eef6">'+html.escape(h)+'</th>' for h in headers) + '</tr>')
        maximum = max((int(row[bar_column]) for row in rows), default=0) if bar_column is not None else 0
        for row in rows:
            lines.append(' | '.join(str(v) for v in row))
            blocks.append('<tr>')
            for i, v in enumerate(row):
                cell = html.escape(str(v))
                if i == bar_column and maximum:
                    width = round(int(v) / maximum * 100)
                    cell += f'<div style="background:#3465a4;height:6px;width:{width}%"></div>'
                blocks.append('<td style="border-bottom:1px solid #d9e0eb">'+cell+'</td>')
            blocks.append('</tr>')
        blocks.append('</table>')
    # Fail closed on any small cell: release no numeric marginals or complementary
    # totals, including installation proxies and overlapping metric axes.
    for key in ('adoption', 'events', 'tools', 'axes'):
        for row in data[key]:
            for n in (row[1:] if key == 'adoption' else row[-1:]):
                if isinstance(n, bool) or not isinstance(n, (int, Decimal)) or n < 0 or n != int(n):
                    raise ValueError('invalid aggregate count')
    small = not exact and any(0 < n < 10 for key in ('adoption', 'events', 'tools', 'axes')
                for row in data[key] for n in (row[1:] if key == 'adoption' else row[-1:]))
    seen = set()
    for origin, observed, active, startup in data['adoption']:
        if origin not in ORIGINS or origin in seen:
            raise ValueError('unexpected adoption origin')
        seen.add(origin)
        if active > observed or startup > observed or active + startup > observed:
            raise ValueError('inconsistent installation aggregates')
    for key, prefix in (('events', 2), ('tools', 3)):
        dimensions = [tuple(row[:prefix]) for row in data[key]]
        if len(dimensions) != len(set(dimensions)):
            raise ValueError('duplicate aggregate dimension')
    for origin, event, n in data['events']:
        if origin not in ORIGINS or event not in ('startup', 'tool_counts', 'tool_metrics', 'historical_other'):
            raise ValueError('unexpected event dimension')
    for origin, stream, tool, n in data['tools']:
        if origin not in ORIGINS or stream not in ('counts', 'metrics') or tool not in TOOLS:
            raise ValueError('unexpected tool dimension')
    for origin, tool, axis, bucket, n in data['axes']:
        if origin not in ORIGINS or tool not in TOOLS or axis not in AXES or bucket not in AXES[axis]:
            raise ValueError('unexpected metric dimension')
    metrics = {(o,t): n for o,s,t,n in data['tools'] if s == 'metrics'}
    distributions = {}
    for o,t,a,b,n in data['axes']:
        buckets = distributions.setdefault((o,t,a), {})
        if b in buckets: raise ValueError('duplicate metric bucket')
        buckets[b] = n
    for (o,t,a), buckets in distributions.items():
        if (o,t) not in metrics or sum(buckets.values()) != metrics[o,t]:
            raise ValueError('incomplete metric marginal')
    if small:
        note('Detailed adoption, event, tool and axis counts withheld: small cells or complementary disclosure risk; no zero is implied.')
    else:
        for stream, label in (('counts', 'Legacy count stream'), ('metrics', 'Metric stream')):
            rows = sorted([(o,t,n) for o,s,t,n in data['tools'] if s == stream], key=lambda r: (-r[2],r[0],r[1]))
            table(f'{label}: {sum(r[2] for r in rows)} recorded calls', ['Origin', 'Tool', 'Calls'], rows, 2)
            if not rows: note('No tool activity recorded in this stream; absent instrumentation is not proof of zero use.')
        reliability = []
        for o,t in sorted({(o,t) for o,s,t,n in data['tools']}):
            outcomes = distributions.get((o,t,'outcomes'))
            durations = distributions.get((o,t,'durations'))
            total = sum(outcomes.values()) if outcomes else 0
            failures = sum(outcomes.get(b,0) for b in ('nonzero','error','timeout')) if outcomes else None
            rate = f'{failures/total:.1%}' if total else 'unavailable'
            reliability.append((o,t, str(failures) + '/' + str(total) + ' ('+rate+')' if total else 'Outcomes unavailable',
                                str(outcomes.get('cancelled',0)) if outcomes else 'unavailable',
                                str(outcomes.get('unknown',0)) if outcomes else 'unavailable',
                                str(durations.get('gte10000',0)) if durations else 'unavailable'))
        table('Reliability: metric stream only', ['Origin','Tool','Failures / recorded outcomes','Cancelled','Unknown','10 seconds or more'], reliability)
        note('Failures include nonzero, error and timeout; cancelled and unknown are separate. Outcomes unavailable means reliability cannot be inferred, including weeks before instrumentation. Slow buckets are observations, not averages or a diagnosed root cause.')
        priorities = []
        for o,t in metrics:
            outcomes = distributions.get((o,t,'outcomes'), {})
            durations = distributions.get((o,t,'durations'), {})
            failures = sum(outcomes.get(b,0) for b in ('nonzero','error','timeout'))
            slow = durations.get('gte10000',0)
            if failures or slow: priorities.append((o,t,failures,slow))
        if priorities:
            table('Investigate observed failures and slow operations', ['Origin','Tool','Recorded failures','10 seconds or more'],
                  sorted(priorities, key=lambda r: (-r[2],-r[3],r[0],r[1])))
        else:
            note('No investigation priority established from available failure and slow-bucket evidence.')
        table('Installation proxies', ['Origin','Observed','Active','Startup only'], sorted(data['adoption']))
        table('Recorded events', ['Origin','Event','Batches / events'], sorted(data['events']))
        axes = [(o,t,a,DURATION_LABELS[b] if a == 'durations' else b,n) for o,t,a,b,n in sorted(data['axes'])]
        table('Recorded metric distributions (separate marginals)', ['Origin','Tool','Axis','Bucket','Calls'], axes)
    note('Installation IDs are proxies, not people. Unknown origin is not external users.')
    note('Counts and metrics are overlapping streams, never added into unique calls. Axis distributions are separate marginals.')
    note('Receipts cover each hour; this does not prove upstream delivery of every event.')
    note(f'Import checkpoint: {data["imported"].isoformat()}; weekly hourly receipt coverage: 168/168')
    note('Exact small aggregate counts approved for this private audience.' if exact else 'Default small-cell and complementary-count suppression applies.')
    note('Retention/capacity: no automated age deletion; verify protected JSONL, database/WAL/index growth and restore-tested backups before archive decisions.')
    blocks.append('</body></html>')
    return '\n'.join(lines) + '\n', '\n'.join(blocks)


def validate_transport(config):
    if config['host'] != 'mail.ialogics.co.uk' or int(config['port']) != 587:
        raise ValueError('production SMTP route must be Palladium mail.ialogics.co.uk:587')


def submit(message, recipient, config):
    # Credentials are supplied only through the protected environment, never CLI, logs or receipt.
    validate_transport(config)
    with smtplib.SMTP(config['host'], int(config['port']), timeout=15) as smtp:
        smtp.starttls(context=ssl.create_default_context())
        smtp.login(config['username'], os.environ['DIGEST_SMTP_PASSWORD'])
        smtp.send_message(message, from_addr=config['sender'], to_addrs=[recipient])


def intent_name(start, end, recipient):
    # Preserve the original one-shot key exactly, including +00:00 formatting.
    return hashlib.sha256((start.isoformat() + '/' + end.isoformat() + '/' + recipient).encode()).hexdigest() + '.attempted'


def sync_directory(path):
    # Production units run on Linux. Windows isolated tests exercise exclusive creation
    # and file fsync; Windows cannot provide this directory-fsync durability claim.
    if os.name == 'nt':
        return
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def scheduled_state(config, state, start, end, now):
    if not end + dt.timedelta(hours=3) <= now < end + dt.timedelta(hours=5):
        raise ValueError('outside Monday 03:00–05:00 UTC schedule; no catch-up send')
    # Commission against an existing durable intent. A missing/empty replacement
    # state directory must never silently grant permission to submit again.
    try:
        anchor_end = dt.datetime.strptime(config['schedule_prior_week_end'], '%Y-%m-%d').replace(tzinfo=UTC)
    except (KeyError, TypeError, ValueError):
        raise ValueError('schedule requires prior durable intent week') from None
    if anchor_end.weekday() != 0 or anchor_end > start:
        raise ValueError('invalid schedule prior intent week')
    anchor = state / intent_name(anchor_end-dt.timedelta(days=7), anchor_end, config.get('recipient'))
    if not state.is_dir() or not anchor.is_file() or anchor.is_symlink() or anchor.stat().st_size == 0:
        raise ValueError('scheduled state missing original durable intent')


def main(argv=None, clock=None, connect=None, deliver=submit):
    from email.message import EmailMessage
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--state-dir', required=True)
    parser.add_argument('--preview', action='store_true')
    parser.add_argument('--preview-html', action='store_true')
    parser.add_argument('--scheduled', action='store_true')
    args = parser.parse_args(argv)
    config = json.loads(Path(args.config).read_text(encoding='utf8'))
    now = clock or dt.datetime.now(UTC)
    start, end = closed_week(now)
    private_counts(config)  # Audience validation applies to previews too.
    state = Path(args.state_dir)
    if args.scheduled:
        scheduled_state(config, state, start, end, now)
    if now < end + dt.timedelta(hours=2):
        raise ValueError('allow two hours for final import')
    if connect is None:
        import psycopg
        connect = lambda: psycopg.connect(os.environ['ANALYTICS_DSN'], connect_timeout=10, options='-c statement_timeout=15000 -c default_transaction_read_only=on')
    with connect() as conn:
        body, html_body = report(aggregates(conn, start, end), start, end, now, config)
    if args.preview or args.preview_html:
        return html_body if args.preview_html else body
    if config.get('enabled') is not True:
        raise ValueError('production delivery disabled pending review')
    recipient = config.get('recipient')
    approved = config.get('approved_recipients')
    address = ADDRESS
    if not isinstance(approved, list) or not approved or not all(isinstance(a, str) and address.fullmatch(a) for a in approved):
        raise ValueError('approved private recipient required')
    if not isinstance(recipient, str) or not address.fullmatch(recipient) or recipient not in approved:
        raise ValueError('approved private recipient required')
    if recipient != RECIPIENT or approved != [RECIPIENT]:
        raise ValueError('approved private audience must contain only isak@ialogics.com')
    sender = config.get('sender')
    if not isinstance(sender, str) or not address.fullmatch(sender):
        raise ValueError('invalid sender header')
    if not all(config.get(k) for k in ('host', 'port', 'username')):
        raise ValueError('mail transport configuration incomplete')
    validate_transport(config)
    msg = EmailMessage()
    msg['From'] = sender
    msg['To'] = recipient
    msg['Subject'] = f'Private telemetry weekly digest {start.date()} to {end.date()} UTC'
    from email.utils import format_datetime
    msg['Date'] = format_datetime(now)
    msg['Message-ID'] = '<' + intent_name(start,end,recipient).removesuffix('.attempted') + '@telemetry.ialogics.com>'
    msg.set_content(body)
    msg.add_alternative(html_body, subtype='html')
    msg.as_bytes()  # Finish and validate serialization before recording any intent.
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    sync_directory(state.parent)
    claim = state / intent_name(start, end, recipient)
    # Exclusive durable pre-send intent. Unknown SMTP acceptance is never retried automatically.
    fd = os.open(claim, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write('submission attempted; inspect transport and recipient before any manual reconciliation\n')
        f.flush()
        os.fsync(f.fileno())
    sync_directory(state)
    deliver(msg, recipient, config)
    # SMTP acceptance remains separate from recipient-confirmed delivery. Failure
    # persisting this receipt leaves the pre-send claim intact and forbids retry.
    accepted = claim.with_suffix('.accepted')
    fd = os.open(accepted, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump({'status': 'smtp_accepted', 'at': now.isoformat(), 'scheduled': args.scheduled}, f)
        f.flush()
        os.fsync(f.fileno())
    sync_directory(state)
    return 'submission accepted by transport; external delivery not proven\n'


if __name__ == '__main__':
    try:
        print(main(), end='')
    except Exception:
        print('Weekly digest failed or delivery state uncertain; no automatic resend. Inspect private state and health.', file=sys.stderr)
        sys.exit(1)

#!/usr/bin/env python
"""Private, fail-closed weekly digest. The installed service is disabled pending review."""
import argparse
import datetime as dt
from decimal import Decimal
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import smtplib
import ssl
import sys

UTC = dt.timezone.utc
ORIGINS = ('internal', 'test', 'unknown_origin', 'external_self_declared', 'cohort_conflict')
RECIPIENT = 'isak@ialogics.com'
# Same finite dimensions as the client/importer contract; never echo arbitrary SQL labels.
TOOLS = {'run_powershell', 'list_services', 'get_service', 'control_service', 'system_info', 'ssh_exec', 'winrm_exec', 'sftp_upload', 'sftp_download', 'run_program', 'runtime_capabilities', 'start_execution', 'execution_status', 'read_execution_output', 'cancel_execution', 'read_output_log', 'delete_output_log', 'start_remote_batch', 'remote_batch_status', 'cancel_remote_batch'}
AXES = {'outcomes': {'success', 'nonzero', 'error', 'timeout', 'cancelled', 'unknown'}, 'durations': {'lt100', 'lt1000', 'lt10000', 'gte10000'}, 'features': {'execution', 'inspection', 'remote', 'transfer', 'lifecycle', 'logs'}}
WINRM_REASONS = {'completed', 'remote_script_error', 'authentication_exception', 'access_exception', 'remoting_transport_exception', 'invoke_exception', 'wrapper_result_invalid', 'frame_invalid', 'frame_body_invalid', 'local_host_error', 'local_launch_error', 'timeout', 'cancelled', 'unknown', 'uninstrumented'}
DURATION_LABELS = {'lt100': 'under 100 ms', 'lt1000': '100–999 ms', 'lt10000': '1–9.999 seconds', 'gte10000': '10 seconds or more'}
ADDRESS = re.compile(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z")
# Hard limits on each disjoint partition below. Exhaustion is a
# privacy refusal, including for an approved private audience.
COMPOSITE_MAX_CELLS = 1024
COMPOSITE_MAX_BITS = 128
COMPOSITE_MAX_STATES = 8192
COMPOSITE_MAX_WORK = 262144


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
        cur.execute('SELECT * FROM user_proxy_utc(%s,%s)', (start, end))
        users = cur.fetchall()
        cur.execute('SELECT origin, reason, calls FROM winrm_diagnostics_utc(%s,%s)', (start, end))
        winrm_reasons = cur.fetchall()
        cohort_sql = 'SELECT origin,version_bucket,event,count(*) FROM dashboard_events WHERE event_at >= %s AND event_at < %s GROUP BY origin,version_bucket,event'
        cur.execute(cohort_sql, (start, end))
        cohorts = cur.fetchall()
        prior_start = start - dt.timedelta(days=7)
        cur.execute(cohort_sql, (prior_start, start))
        previous = dict(start=prior_start, end=start, cohorts=cur.fetchall())
        cur.execute('SELECT origin,stream,tool,sum(calls) FROM dashboard_tools WHERE event_at >= %s AND event_at < %s GROUP BY origin,stream,tool', (prior_start, start))
        previous['tools'] = cur.fetchall()
        cur.execute('SELECT origin,tool,axis,bucket,sum(calls) FROM dashboard_metric_axes WHERE event_at >= %s AND event_at < %s GROUP BY origin,tool,axis,bucket', (prior_start, start))
        previous['axes'] = cur.fetchall()
        cur.execute('SELECT event_time_quality,receipt_time_quality,count(*) FROM dashboard_events WHERE received_at >= %s AND received_at < %s GROUP BY event_time_quality,receipt_time_quality', (prior_start, start))
        previous['quality'] = cur.fetchall()
        cur.execute("SELECT date_trunc('hour',received_at,'UTC'),count(*) FROM dashboard_events WHERE received_at >= %s AND received_at < %s GROUP BY 1 ORDER BY 1", (prior_start, start))
        previous['receipts'] = cur.fetchall()
        # Capability discovery keeps the old schema readable without aborting
        # this snapshot on UndefinedFunction. A present but ungranted/withheld
        # function never permits reconstructing its cohorts from marginals.
        cur.execute("SELECT p IS NOT NULL, coalesce(has_function_privilege(p,'EXECUTE'),false) FROM (SELECT to_regprocedure('tool_version_outcomes_utc(timestamptz,timestamptz)') AS p) f")
        installed, executable = cur.fetchone()
        joint = {}
        if installed:
            joint['version_outcomes'] = []
            previous['version_outcomes'] = []
            if executable:
                sql = 'SELECT origin,version_bucket,stream,tool,axis,bucket,calls FROM tool_version_outcomes_utc(%s,%s)'
                cur.execute(sql, (start, end))
                joint['version_outcomes'] = cur.fetchall()
                cur.execute(sql, (prior_start, start))
                previous['version_outcomes'] = cur.fetchall()
    return dict(adoption=adoption, users=users, events=events, tools=tools, axes=axes, winrm_reasons=winrm_reasons, quality=quality, unknown_receipt_count=unknown_receipt_count, receipts=receipts, imported=imported, cohorts=cohorts, previous=previous, **joint)


def render(data, start, end, now, config=None):
    return report(data, start, end, now, config)[0]


def render_html(data, start, end, now, config=None):
    return report(data, start, end, now, config)[1]


def small_composite_change(before, after):
    """Refuse unsafe unions or partitions whose safety exceeds the search budget."""
    if max(len(before), len(after)) > COMPOSITE_MAX_CELLS:
        return True
    keys = before.keys() | after.keys()
    if len(keys) > COMPOSITE_MAX_CELLS:
        return True
    changes = [int(after.get(k, 0) - before.get(k, 0)) for k in keys]
    if any(abs(n).bit_length() > COMPOSITE_MAX_BITS for n in changes):
        return True
    changes = sorted((n for n in changes if n), key=lambda n: (abs(n), n), reverse=True)
    if any(0 < abs(n) < 10 for n in changes):
        return True
    if (not changes or min(changes) > 0 or max(changes) < 0 or math.gcd(*changes) >= 10):
        return False
    # Use signed changes, not endpoint subsets: each union's change is the sum
    # of its cells' changes. Zero changes do not add states. Discard partial sums
    # that the remaining cells cannot bring into [-9, 9]. This includes the
    # complement of every union without materializing all endpoint surfaces.
    lower = sum(n for n in changes if n < 0)
    upper = sum(n for n in changes if n > 0)
    reachable = {0}
    work = 0
    for change in changes:
        work += len(reachable)
        if work > COMPOSITE_MAX_WORK:
            return True
        lower -= min(change, 0)
        upper -= max(change, 0)
        candidates = reachable | {n + change for n in reachable}
        if any(0 < abs(n) < 10 for n in candidates):
            return True
        reachable = {n for n in candidates if n + lower <= 9 and n + upper >= -9}
        if len(reachable) > COMPOSITE_MAX_STATES:
            return True
    return False


def version_outcome_cells(period):
    """Validate the restricted joint, including its rollup to existing marginals."""
    totals, outcomes, seen = {}, {}, set()
    for row in period.get('version_outcomes', []):
        if not isinstance(row, (tuple, list)) or len(row) != 7:
            raise ValueError('invalid joint version/tool/outcome row')
        o,v,s,t,a,b,n = row
        if (not all(isinstance(x,str) for x in (o,v,s,t,a,b)) or
                o not in ORIGINS or not (v == 'other' or re.fullmatch(r'(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})',v)) or
                s not in ('counts','metrics') or t not in TOOLS or
                not ((a,b) == ('calls','total') or (s == 'metrics' and a == 'outcomes' and b in AXES['outcomes']))):
            raise ValueError('invalid joint version/tool/outcome dimension')
        key = (o,v,s,t,a,b)
        if key in seen:
            raise ValueError('duplicate joint version/tool/outcome cell')
        seen.add(key)
        if (isinstance(n,bool) or not isinstance(n,(int,Decimal)) or
                (isinstance(n,Decimal) and not n.is_finite()) or n < 0 or n != int(n)):
            raise ValueError('invalid joint version/tool/outcome count')
        if a == 'calls': totals[o,v,s,t] = n
        else: outcomes[o,v,t,b] = n
    for o,v,t in {k[:3] for k in outcomes}:
        covered = sum(n for (co,cv,ct,b),n in outcomes.items() if (co,cv,ct) == (o,v,t))
        if (o,v,'metrics',t) not in totals or covered > totals[o,v,'metrics',t]:
            raise ValueError('inconsistent joint outcome coverage')
    if seen:
        calls, axes = {}, {}
        for (o,v,s,t),n in totals.items(): calls[o,s,t] = calls.get((o,s,t),0)+n
        for (o,v,t,b),n in outcomes.items(): axes[o,t,'outcomes',b] = axes.get((o,t,'outcomes',b),0)+n
        expected_calls = {(o,s,t):n for o,s,t,n in period.get('tools',[]) if n}
        expected_axes = {(o,t,a,b):n for o,t,a,b,n in period.get('axes',[]) if a=='outcomes' and n}
        if ({k:n for k,n in calls.items() if n} != expected_calls or
                {k:n for k,n in axes.items() if n} != expected_axes):
            raise ValueError('inconsistent joint aggregate rollup')
    return totals, outcomes


def completed_week_trends(data, start, end, now):
    """Compare actual joint cohorts when installed; retain old-schema admission."""
    result = dict(notes=[], coverage=[], calls=[], rates=[], unsafe=False)
    notes = result['notes']
    previous = data.get('previous')
    if previous is None:
        notes.append('Comparison unavailable: equivalent completed UTC weeks require prior-week version/instrumentation coverage.')
        return result
    prior_start = start - dt.timedelta(days=7)
    if ((start, end) != closed_week(now) or previous.get('start') != prior_start or
            previous.get('end') != start):
        notes.append('Comparison refused: windows must be adjacent complete Monday-to-Monday UTC weeks.')
        return result
    notes.append(f'Completed-week comparison: {prior_start:%d %b %Y} to {start:%d %b %Y} versus {start:%d %b %Y} to {end:%d %b %Y} UTC; each window start inclusive and end exclusive; same repeatable-read snapshot.')
    notes.append('Rates and changes are descriptive, not evidence of improvement or a deployed fix. Calls within batches may be dependent; workload and late arrivals can revise event-time totals. Receipt coverage does not prove complete upstream delivery.')
    hours = {h for h, n in previous.get('receipts', []) if n > 0}
    quality = previous.get('quality', [])
    if (any(prior_start + dt.timedelta(hours=i) not in hours for i in range(168)) or
            not quality or any(a != 'valid' or b != 'valid' for a, b, n in quality if n)):
        notes.append('Comparison refused: prior-week receipt coverage or timestamp quality is incomplete.')
        return result
    cohorts, totals, axes = [], [], []
    for period in (previous, data):
        c, t, a = {}, {}, {}
        for o, v, event, n in period.get('cohorts', []):
            if (o not in ORIGINS or not isinstance(v, str) or
                    not (v == 'other' or re.fullmatch(r'(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})', v)) or
                    event not in ('startup', 'tool_counts', 'tool_metrics', 'historical_other') or (o,v,event) in c):
                raise ValueError('invalid version/instrumentation cohort')
            c[o,v,event] = n
        for o, s, tool, n in period.get('tools', []):
            if o not in ORIGINS or s not in ('counts', 'metrics') or tool not in TOOLS or (o,s,tool) in t:
                raise ValueError('invalid comparison tool dimension')
            t[o,s,tool] = n
        for o, tool, axis, bucket, n in period.get('axes', []):
            if o not in ORIGINS or tool not in TOOLS or axis not in AXES or bucket not in AXES[axis] or (o,tool,axis,bucket) in a:
                raise ValueError('invalid comparison metric dimension')
            a[o,tool,axis,bucket] = n
        for n in (*c.values(), *t.values(), *a.values()):
            if (isinstance(n, bool) or not isinstance(n, (int, Decimal)) or
                    (isinstance(n, Decimal) and not n.is_finite()) or n < 0 or n != int(n)):
                raise ValueError('invalid comparison count')
        for o, tool, axis in {k[:3] for k in a}:
            covered = sum(n for (co,ct,ca,b),n in a.items() if (co,ct,ca) == (o,tool,axis))
            partial_joint = axis == 'outcomes' and 'version_outcomes' in period
            if ((o,'metrics',tool) not in t or covered > t[o,'metrics',tool] or
                    (covered != t[o,'metrics',tool] and not partial_joint)):
                raise ValueError('incomplete comparison metric marginal')
        cohorts.append(c); totals.append(t); axes.append(a)
    # Guard each published partition, its composite cells/complements, and their
    # changes between windows. Withhold current detail as well:
    # suppressing a delta alone still releases it via the two endpoint counts.
    surfaces = []
    partition_windows = []
    for period, c, t, a in zip((previous, data), cohorts, totals, axes):
        # All rendered batch cells are disjoint, across origins, versions and
        # event types. Local version/event tables are unions of these cells.
        partitions = {('events',): c.copy()}
        for (o,s,tool),n in t.items():
            partitions.setdefault(('stream',s),{})[o,tool] = n
        # Refine the metric stream by ONE axis at a time across all tools and
        # origins. Tool totals and their complements are unions in each refined
        # partition. Never add overlapping streams or independent axes.
        for (o,tool,axis,b),n in a.items():
            partitions.setdefault(('axis',axis),{})[o,tool,b] = n
        instrumented = {k[:3] for k in a}
        for (o,s,tool),n in t.items():
            if s != 'metrics': continue
            for axis in AXES:
                if (o,tool,axis) not in instrumented:
                    # Missing instrumentation is a whole tool-call cell, not
                    # an observed zero bucket; its total is still published.
                    partitions.setdefault(('axis',axis),{})[o,tool,None] = n
                elif axis == 'outcomes':
                    covered = sum(v for (co,ct,ca,b),v in a.items() if (co,ct,ca) == (o,tool,axis))
                    partitions.setdefault(('axis',axis),{})[o,tool,None] = n-covered
        # Refine only calls and outcomes by the actual event version. Other
        # axes remain independent marginals; no duration/feature joint is made.
        if 'version_outcomes' in period:
            jt, ja = version_outcome_cells(period)
            for (o,v,s,tool),n in jt.items():
                partitions.setdefault(('joint-stream',s),{})[o,v,tool] = n
                if s == 'metrics':
                    covered = sum(x for (co,cv,ct,b),x in ja.items() if (co,cv,ct) == (o,v,tool))
                    partitions.setdefault(('joint-outcomes',),{})[o,v,tool,None] = n-covered
            for (o,v,tool,b),n in ja.items():
                partitions.setdefault(('joint-outcomes',),{})[o,v,tool,b] = n
        surface = {}
        for partition, cells in partitions.items():
            total = sum(cells.values())
            surface[partition, 'total'] = total
            for cell,n in cells.items():
                surface[partition, 'cell', cell] = n
                surface[partition, 'complement', cell] = total-n
        for (o,s,tool),n in t.items():
            if s == 'metrics':
                covered = sum(v for (co,ct,ca,b),v in a.items() if (co,ct,ca) == (o,tool,'outcomes'))
                surface[('coverage',o,tool), 'missing'] = n-covered
        surfaces.append(surface)
        partition_windows.append(partitions)
    before, after = partition_windows
    if (any(0 < n < 10 for surface in surfaces for n in surface.values()) or
            any(0 < abs(surfaces[1].get(k,0)-surfaces[0].get(k,0)) < 10
                for k in surfaces[0].keys() | surfaces[1].keys()) or
            any(small_composite_change(before.get(p, {}), after.get(p, {}))
                for p in before.keys() | after.keys())):
        result['unsafe'] = True
        notes.append('Comparison and numeric details withheld: small cells or cross-window complementary disclosure risk. Private small-count permission does not override trend suppression.')
        return result
    for o, event in sorted({(o,e) for c in cohorts for o,v,e in c if e in ('tool_counts','tool_metrics')}):
        mixes = [{v:n for (co,v,e),n in c.items() if (co,e) == (o,event)} for c in cohorts]
        denoms = [sum(m.values()) for m in mixes]
        if not all(denoms):
            notes.append(f'Version/instrumentation mix unavailable for {o} ({event}): batches missing in one week.')
        else:
            changed = any(mixes[0].get(v,0)*denoms[1] != mixes[1].get(v,0)*denoms[0] for v in mixes[0].keys() | mixes[1].keys())
            notes.append(f'Version/instrumentation mix {"changed" if changed else "stable at event-batch level"} for {o} ({event}); batch shares do not establish per-tool call shares.')
    for o, v, event in sorted(cohorts[0].keys() | cohorts[1].keys()):
        cells = []
        for c in cohorts:
            count = c.get((o,v,event))
            denominator = sum(n for (co,cv,ce),n in c.items() if (co,ce) == (o,event))
            cells.append(f'{count}/{denominator} batches ({count/denominator:.1%})' if count is not None and denominator else 'not recorded')
        result['coverage'].append((o,v,event,*cells))
    if 'version_outcomes' in data or 'version_outcomes' in previous:
        joint_week_comparisons(previous, data, result)
        return result
    notes.append('Joint version/tool/outcome function not installed; only the established single-version same-stream comparison is available.')
    for o,s,tool in sorted(totals[0].keys() | totals[1].keys()):
        event = 'tool_metrics' if s == 'metrics' else 'tool_counts'
        versions = [{v for (co,v,e),n in c.items() if co == o and e == event and n > 0} for c in cohorts]
        label = f'{tool} ({o}, {s})'
        if any(not vs or 'other' in vs for vs in versions):
            notes.append(f'Call/rate comparison refused for {label}: missing or unknown version/instrumentation coverage.')
            continue
        if any(len(vs) != 1 for vs in versions) or versions[0] != versions[1]:
            notes.append(f'Call/rate comparison refused for {label}: version mix or version changed; event-batch shares cannot establish per-tool call cohorts. A restricted version/tool/outcome aggregate is required.')
            continue
        counts = [t.get((o,s,tool)) for t in totals]
        if any(n is None or n <= 0 for n in counts):
            notes.append(f'Call/rate comparison refused for {label}: zero or missing same-stream denominator; absence is not zero activity.')
            continue
        version = next(iter(versions[0]))
        old, new = counts
        result['calls'].append((o,s,tool,version,old,new,f'{new-old:+} ({(new-old)/old:+.1%})'))
        if s != 'metrics': continue
        outcomes = [{b:n for (co,ct,ca,b),n in a.items() if (co,ct,ca) == (o,tool,'outcomes')} for a in axes]
        notes.append(f'Outcome instrumentation coverage for {label}: {sum(outcomes[0].values())}/{old} previous and {sum(outcomes[1].values())}/{new} current metric calls; coverage of all executed calls is unknown.')
        if any(not b for b in outcomes):
            notes.append(f'Error/timeout comparison refused for {label}: missing outcome instrumentation; duration or legacy counts cannot supply outcomes.')
            continue
        if min(counts) < 100:
            notes.append(f'Small sample for {label}: fewer than 100 recorded outcomes in at least one week; no statistical improvement claim.')
        for bucket in ('error', 'timeout'):
            a, b = [out.get(bucket, 0) for out in outcomes]
            result['rates'].append((o,tool,version,bucket,f'{a}/{old} ({a/old:.1%})',f'{b}/{new} ({b/new:.1%})',f'{100*(b/new-a/old):+.1f} pp'))
    if not result['coverage']:
        notes.append('Comparison unavailable: version/instrumentation batches are missing in both weeks.')
    notes.append('Per-version WinRM reason/outcome comparison is unavailable from the existing independent marginals; no joint data is inferred.')
    return result


def joint_week_comparisons(previous, data, result):
    notes = result['notes']
    periods = (previous, data)
    if any(not p.get('version_outcomes') and p.get('tools') for p in periods):
        notes.append('Call/rate comparison refused: joint version/tool/outcome aggregate unavailable or withheld; no marginal reconstruction is permitted.')
        return
    joints = [version_outcome_cells(p) for p in periods]
    notes.append('Call cohorts use the same event-version/tool join in each week, with separate counts and metrics streams. Changed fleet batch shares do not change these version-specific denominators.')
    for o,v,s,tool in sorted(joints[0][0].keys() | joints[1][0].keys()):
        label = f'{tool} ({o}, {s}, version {v})'
        if v == 'other':
            notes.append(f'Call/rate comparison refused for {label}: unknown version bucket.')
            continue
        counts = [t.get((o,v,s,tool)) for t,a in joints]
        if any(n is None or n <= 0 for n in counts):
            notes.append(f'Call/rate comparison refused for {label}: zero or missing same-stream version-specific denominator; absence is not zero activity.')
            continue
        old, new = counts
        result['calls'].append((o,s,tool,v,old,new,f'{new-old:+} ({(new-old)/old:+.1%})'))
        if s != 'metrics': continue
        outcomes = [{b:n for (co,cv,ct,b),n in a.items() if (co,cv,ct) == (o,v,tool)} for t,a in joints]
        coverage = [sum(b.values()) for b in outcomes]
        notes.append(f'Outcome instrumentation coverage for {label}: {coverage[0]}/{old} previous and {coverage[1]}/{new} current metric calls; coverage of all executed calls is unknown.')
        if coverage != counts or any(not b for b in outcomes):
            notes.append(f'Error/timeout comparison refused for {label}: partial or missing outcome instrumentation; a complete version-specific denominator is required.')
            continue
        if min(counts) < 100:
            notes.append(f'Small sample for {label}: fewer than 100 recorded outcomes in at least one week; no statistical improvement claim.')
        for bucket in ('error','timeout'):
            a,b = [out.get(bucket,0) for out in outcomes]
            result['rates'].append((o,tool,v,bucket,f'{a}/{old} ({a/old:.1%})',f'{b}/{new} ({b/new:.1%})',f'{100*(b/new-a/old):+.1f} pp'))
    notes.append('Per-version WinRM reason/outcome comparison remains unavailable; independent reason marginals do not supply joint error-reason rates.')


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
    policy_small = any(0 < n < 10 for key in ('adoption', 'events', 'tools', 'axes')
                for row in data[key] for n in (row[1:] if key == 'adoption' else row[-1:]))
    seen = set()
    for origin, observed, active, startup in data['adoption']:
        if origin not in ORIGINS or origin in seen:
            raise ValueError('unexpected adoption origin')
        seen.add(origin)
        if active > observed or startup > observed or active + startup > observed:
            raise ValueError('inconsistent installation aggregates')
        # Active and startup-only are disjoint subsets. Published proxies also
        # disclose their complements, including installations in neither subset.
        if any(0 < n < 10 for n in
                             (observed - active, observed - startup, observed - active - startup)):
            policy_small = True
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
        covered = sum(buckets.values())
        partial_joint = a == 'outcomes' and 'version_outcomes' in data
        if ((o,t) not in metrics or covered > metrics[o,t] or
                (covered != metrics[o,t] and not partial_joint)):
            raise ValueError('incomplete metric marginal')
        if partial_joint and covered != metrics[o,t]:
            if 0 < metrics[o,t]-covered < 10: policy_small = True
    reasons = {}
    for row in data.get('winrm_reasons', []):
        if not isinstance(row, (tuple, list)) or len(row) != 3:
            raise ValueError('invalid WinRM diagnostic row')
        o, reason, n = row
        if isinstance(n, Decimal) and not n.is_finite():
            raise ValueError('invalid WinRM diagnostic count')
        if isinstance(n, bool) or not isinstance(n, (int, Decimal)) or n <= 0 or n != int(n):
            raise ValueError('invalid WinRM diagnostic count')
        if not isinstance(o, str) or not isinstance(reason, str) or o not in ORIGINS or reason not in WINRM_REASONS:
            raise ValueError('invalid WinRM diagnostic dimension')
        buckets = reasons.setdefault(o, {})
        if reason in buckets:
            raise ValueError('duplicate WinRM diagnostic dimension')
        buckets[reason] = n
    reason_unsafe = policy_small
    if reasons and set(reasons) != {o for o, t in metrics if t == 'winrm_exec'}:
        raise ValueError('incomplete WinRM diagnostic marginal')
    for o, buckets in reasons.items():
        total = metrics[o, 'winrm_exec']
        if sum(buckets.values()) != total:
            raise ValueError('incomplete WinRM diagnostic marginal')
        # Same protections as the restricted SQL function, even with private
        # small-count permission. These mappings guard disclosure, not joint rates.
        if any(0 < n < 10 for count in buckets.values() for n in (count, total - count)):
            reason_unsafe = True
        known = {}
        for reason, n in buckets.items():
            if reason in ('unknown', 'uninstrumented'): continue
            outcome = 'success' if reason == 'completed' else reason if reason in ('timeout', 'cancelled') else 'error'
            known[outcome] = known.get(outcome, 0) + n
        outcomes = distributions.get((o, 'winrm_exec', 'outcomes'))
        if outcomes is None:
            reason_unsafe = True
        elif any(n < 0 or 0 < n < 10 for n in
                 (outcomes.get(b, 0) - known.get(b, 0) for b in set(outcomes) | set(known))):
            reason_unsafe = True
    trends = completed_week_trends(data, start, end, now)
    # Retain observed partial cells in the detail distribution, but never rank
    # them or supply reliability rates as though instrumentation were complete.
    distributions = {k:b for k,b in distributions.items()
                     if k[2] != 'outcomes' or sum(b.values()) == metrics[k[:2]]}
    small = (policy_small and not exact) or trends['unsafe']
    reason_unsafe = reason_unsafe or trends['unsafe']
    note('Weekly findings')
    if small:
        note('Usage and reliability findings withheld by default privacy policy; no zero activity or improvement is implied.')
    else:
        for o, observed, active, startup in sorted(data['adoption']):
            note(f'{o}: {observed} observed, {active} active, {startup} startup-only installations, not people.')
        evidence = [(o, t, b, sum(b.values())) for (o, t, a), b in distributions.items() if a == 'outcomes']
        errors = [(o, t, b.get('error', 0), n) for o, t, b, n in evidence if b.get('error', 0)]
        actions = []
        if errors:
            volume = sorted(errors, key=lambda r: (-r[2], r[0], r[1]))[0]
            rate = sorted(errors, key=lambda r: (-r[2]/r[3], r[0], r[1]))[0]
            for label, (o, t, n, total) in (('Largest error volume', volume), ('Highest error rate', rate)):
                note(f'{label}: {t} ({o}), {n}/{total} recorded outcomes ({n/total:.1%}).')
            actions.append(f'Action: review {volume[1]} ({volume[0]}) for its recorded error volume; these outcomes do not establish a product defect or cause.')
            if rate[:2] != volume[:2]:
                actions.append(f'Action: review {rate[1]} ({rate[0]}) separately for its recorded error proportion and workload.')
        elif evidence:
            note('No recorded errors in the available outcome marginals; this does not establish reliability for missing instrumentation.')
        else:
            note('Outcomes unavailable; reliability cannot be inferred from legacy counts or duration buckets.')
        missing = sum((o, t, 'outcomes') not in distributions for o, t in metrics)
        note(f'Outcome coverage: {len(evidence)}/{len(metrics)} metric tool/origin groups have a complete outcome marginal; coverage of all executed calls is unknown.')
        if missing or not evidence:
            actions.append('Action: review outcome instrumentation coverage before drawing a reliability conclusion.')
        timeouts = sorted([(o, t, b['timeout'], n) for o, t, b, n in evidence if b.get('timeout')], key=lambda r: (-r[2], r[0], r[1]))
        if timeouts:
            o, t, n, total = timeouts[0]
            actions.append(f'Action: review {t} ({o}) timeout observations: {n}/{total} recorded outcomes; remote termination is unproven.')
        for action in actions[:3]: note(action)
        if any(n < 100 for o, t, b, n in evidence):
            note('Small sample: fewer than 100 recorded outcomes in at least one tool/origin group; rates are descriptive, not evidence of improvement.')
    if small and not trends['unsafe']:
        note('Comparison withheld by default privacy policy; no change is inferred.')
    else:
        for value in trends['notes']: note(value)
    if not small:
        if trends['coverage']:
            table('Version/instrumentation coverage (event batches, not calls)', ['Origin','Version','Event','Previous week','Current week'], trends['coverage'])
        if trends['calls']:
            table('Same-stream call comparison', ['Origin','Stream','Tool','Version','Previous calls','Current calls','Change'], trends['calls'])
        if trends['rates']:
            table('Error and timeout comparison (complete outcome marginals only)', ['Origin','Tool','Version','Outcome','Previous week','Current week','Change'], trends['rates'])
    note('Release/deployment status unavailable from these aggregates; no fix or rollout is inferred. Reporting health passed the checkpoint and hourly receipt gates; complete upstream delivery remains unproven.')
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
                                str(outcomes.get('error',0)) if outcomes else 'unavailable',
                                str(outcomes.get('nonzero',0)) if outcomes else 'unavailable',
                                str(outcomes.get('timeout',0)) if outcomes else 'unavailable',
                                str(outcomes.get('cancelled',0)) if outcomes else 'unavailable',
                                str(outcomes.get('unknown',0)) if outcomes else 'unavailable',
                                str(durations.get('gte10000',0)) if durations else 'unavailable'))
        table('Reliability: metric stream only', ['Origin','Tool','Failures / recorded outcomes','Error','Nonzero','Timeout','Cancelled','Unknown','10 seconds or more'], reliability)
        note('Failures include nonzero, error and timeout; cancelled and unknown are separate. Outcomes unavailable means reliability cannot be inferred, including weeks before instrumentation. Slow buckets are observations, not averages or a diagnosed root cause.')
        priorities = []
        for o,t in metrics:
            outcomes = distributions.get((o,t,'outcomes'))
            durations = distributions.get((o,t,'durations'))
            failures = sum(outcomes.get(b,0) for b in ('nonzero','error','timeout')) if outcomes is not None else None
            slow = durations.get('gte10000',0) if durations is not None else None
            if failures or slow: priorities.append((o,t,failures,slow))
        if priorities:
            # Rank only rows with comparable evidence; absent axes never become
            # zeros or participate as zeros in a combined ranking.
            for missing, label, columns in (
                    (None, 'ranked by recorded failures, then slow operations', (2, 3)),
                    (3, 'ranked by recorded failures; duration axis unavailable', (2,)),
                    (2, 'ranked by slow operations; outcomes axis unavailable', (3,))):
                rows = [r for r in priorities if (2 if r[2] is None else 3 if r[3] is None else None) == missing]
                if rows:
                    ranked = sorted(rows, key=lambda r: tuple(-r[c] for c in columns) + (r[0], r[1]))
                    table('Investigate observed failures and slow operations — ' + label,
                          ['Origin','Tool','Recorded failures','10 seconds or more'],
                          [tuple('unavailable' if v is None else v for v in r) for r in ranked])
        else:
            note('No investigation priority established from available failure and slow-bucket evidence.')
        table('Installation proxies', ['Origin','Observed','Active','Startup only'], sorted(data['adoption']))
        table('Recorded events', ['Origin','Event','Batches / events'], sorted(data['events']))
        axes = [(o,t,a,DURATION_LABELS[b] if a == 'durations' else b,n) for o,t,a,b,n in sorted(data['axes'])]
        table('Recorded metric distributions (separate marginals)', ['Origin','Tool','Axis','Bucket','Calls'], axes)
    if reasons and not reason_unsafe and not small:
        table('WinRM diagnostics (separate reason marginal)', ['Origin', 'Reason', 'Calls'],
              [(o, r, n) for o, buckets in sorted(reasons.items()) for r, n in sorted(buckets.items())])
        for o, buckets in sorted(reasons.items()):
            total = metrics[o, 'winrm_exec']
            covered = total - buckets.get('uninstrumented', 0)
            note(f'Reason coverage: {o}: {covered}/{total} metric WinRM calls ({covered/total:.1%}); includes instrumented unknown.')
        note('unknown is an instrumented reason without specific evidence; uninstrumented means no reason axis. Reasons describe observed boundaries, not a root cause. Reasons and outcomes are independent marginals; no error-specific reason rate is inferred.')
    elif any(t == 'winrm_exec' for o, s, t, n in data['tools']):
        note('WinRM diagnostics unavailable or withheld; no zero or cause is implied. Private small-count permission does not override diagnostic suppression.')
    elif 'winrm_reasons' in data:
        note('WinRM diagnostics unavailable; no reason coverage is inferred.')
    users = data.get('users', [])
    for origin, observed, covered, unknown, proxies in users:
        if origin not in ORIGINS or any(isinstance(n, bool) or not isinstance(n, int) or n < 0 for n in (observed,covered,unknown,proxies)) or covered + unknown != observed or proxies > covered:
            raise ValueError('invalid user coverage aggregate')
    user_small = any(0 < n < 10 for o,obs,cov,unk,p in users for n in (obs,cov,unk,p,cov-p))
    if users and not user_small and not small:
        table('Optional user pseudonym proxies and installation coverage', ['Origin','Observed installations','Covered installations','Unknown user installations','User proxies'], users)
    else:
        note('Optional user counts unavailable (privacy suppression or no coverage); missing identity is unknown, never a new person.')
    note('Installation IDs are proxies, not people. Unknown origin is not external users. External cohort is self-declared; cohort conflicts are explicit. Cohorts may overlap across events; do not add distinct counts.')
    note('User proxies are voluntary random pseudonyms, not anonymous or verified humans. Resets, mixed opt-in and clones limit coverage; no automatic cross-device linkage.')
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

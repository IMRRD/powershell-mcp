import datetime as dt
import importlib.util
from pathlib import Path
import json
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('weekly_digest', Path(__file__).with_name('weekly_digest.py'))
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
UTC = dt.timezone.utc
NOW = dt.datetime(2026, 10, 21, 12, tzinfo=UTC)
START, END = w.closed_week(NOW)


def fixture():
    return dict(adoption=[('unknown_origin', 12, 12, 0)], events=[('unknown_origin', 'startup', 12)],
                tools=[('unknown_origin', 'counts', 'ssh_exec', 13), ('unknown_origin', 'metrics', 'ssh_exec', 13)],
                axes=[('unknown_origin', 'ssh_exec', 'outcomes', 'success', 13)],
                quality=[('valid', 'valid', 2)], unknown_receipt_count=0,
                receipts=[(START + dt.timedelta(hours=i), 1) for i in range(168)],
                imported=NOW - dt.timedelta(minutes=15))


def reason_fixture():
    return fixture() | dict(
        tools=[('unknown_origin', 'counts', 'winrm_exec', 60), ('unknown_origin', 'metrics', 'winrm_exec', 60)],
        axes=[('unknown_origin', 'winrm_exec', a, b, n) for a, b, n in
              [('outcomes', 'error', 60), ('durations', 'lt100', 60), ('features', 'remote', 60)]],
        winrm_reasons=[('unknown_origin', b, 20) for b in ('invoke_exception', 'unknown', 'uninstrumented')])


def trend_fixture():
    def period(total, batches):
        return dict(cohorts=[('unknown_origin', '0.8.0', 'tool_metrics', batches),
                             ('unknown_origin', '0.7.9', 'tool_counts', 20)],
                    tools=[('unknown_origin', 'metrics', 'ssh_exec', total),
                           ('unknown_origin', 'counts', 'ssh_exec', 1000)],
                    axes=[('unknown_origin', 'ssh_exec', 'outcomes', b, n) for b, n in
                          [('success', total-40-total//10), ('error', 40), ('timeout', total//10)]],
                    quality=[('valid', 'valid', 168)])
    previous = period(200, 20) | dict(start=START-dt.timedelta(days=7), end=START,
                                    receipts=[(START-dt.timedelta(days=7)+dt.timedelta(hours=i), 1) for i in range(168)])
    return fixture() | period(400, 40) | dict(previous=previous,
                    adoption=[('unknown_origin', 20, 20, 0)],
                    events=[('unknown_origin', 'tool_metrics', 40), ('unknown_origin', 'tool_counts', 20)])


class Cursor:
    def __init__(self, rows):
        self.rows = iter(rows)
        self.sql = []
        self.params = []
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def execute(self, sql, params=None):
        self.sql.append(sql)
        self.params.append(params)
        if sql.startswith('SET TRANSACTION'):
            return
        self.current = iter(next(self.rows))
    def fetchall(self): return list(self.current)
    def fetchone(self): return next(self.current)


class Conn:
    def __init__(self, rows): self.cur = Cursor(rows)
    def cursor(self): return self.cur
    def __enter__(self): return self
    def __exit__(self, *a): pass


def result_rows(f):
    return [f['adoption'], f['events'], f['tools'], f['axes'], f['quality'],
            [(f['unknown_receipt_count'],)], f['receipts'], [(f['imported'],)], f.get('users', []), f.get('winrm_reasons', [])] + [
            f.get('cohorts', []), f.get('previous', {}).get('cohorts', []),
            f.get('previous', {}).get('tools', []), f.get('previous', {}).get('axes', []),
            f.get('previous', {}).get('quality', []), f.get('previous', {}).get('receipts', []),
            [(True,True) if 'version_outcomes' in f else (False,False)]] + ([
            f['version_outcomes'], f.get('previous',{}).get('version_outcomes',[])] if 'version_outcomes' in f else [])

class DigestTests(unittest.TestCase):
    def test_non_equivalent_or_incomplete_previous_windows_refuse_trends_only(self):
        import copy
        for mode in ('wrong_start','wrong_end','missing_hour','invalid_quality','missing_quality','missing_cohorts'):
            f = copy.deepcopy(trend_fixture())
            if mode == 'wrong_start': f['previous']['start'] += dt.timedelta(hours=1)
            elif mode == 'wrong_end': f['previous']['end'] -= dt.timedelta(hours=1)
            elif mode == 'missing_hour': f['previous']['receipts'].pop(17)
            elif mode == 'invalid_quality': f['previous']['quality'] = [('invalid','valid',20)]
            elif mode == 'missing_quality': f['previous']['quality'] = []
            else: f['previous']['cohorts'] = []
            for body in w.report(f, START, END, NOW):
                self.assertIn('refused', body)
                self.assertNotIn('Error and timeout comparison', body)
                self.assertIn('Metric stream: 400 recorded calls', body)
        f = trend_fixture()
        for start,end in ((START+dt.timedelta(hours=1),END), (END,START), (START,START)):
            f['receipts'] = [(start+dt.timedelta(hours=i),1) for i in range(168)]
            with self.assertRaises(ValueError): w.report(f,start,end,NOW)

    def test_missing_axes_zero_denominators_and_low_samples_have_precise_refusals(self):
        import copy
        for mode in ('missing_outcomes', 'zero_denominator', 'missing_denominator', 'unknown_version', 'low_sample'):
            f = copy.deepcopy(trend_fixture())
            if mode == 'missing_outcomes':
                f['previous']['axes'] = [('unknown_origin','ssh_exec','durations','lt100',200)]
            elif mode == 'zero_denominator':
                f['previous']['tools'][0] = ('unknown_origin','metrics','ssh_exec',0)
                f['previous']['axes'] = []
            elif mode == 'missing_denominator':
                f['previous']['tools'] = f['previous']['tools'][1:]
                f['previous']['axes'] = []
            elif mode == 'unknown_version':
                f['previous']['cohorts'][0] = ('unknown_origin','other','tool_metrics',20)
            else:
                f['previous']['tools'][0] = ('unknown_origin','metrics','ssh_exec',80)
                f['previous']['axes'] = [('unknown_origin','ssh_exec','outcomes',b,n) for b,n in [('success',40),('error',20),('timeout',20)]]
            for body in self.mime_bodies(f):
                if mode == 'low_sample':
                    self.assertIn('Small sample for ssh_exec', body)
                    self.assertIn('20/80 (25.0%)', body)
                else:
                    self.assertNotIn('Error and timeout comparison', body)
                    expected = ('missing outcome instrumentation' if mode == 'missing_outcomes' else
                                'missing or unknown version/instrumentation coverage' if mode == 'unknown_version' else
                                'zero or missing same-stream denominator')
                    self.assertIn(expected, body)
                    self.assertNotIn('0/0', body)

    def test_incomplete_prior_instrumentation_marginal_refuses_without_submission(self):
        f = trend_fixture()
        f['previous']['axes'][0] = ('unknown_origin','ssh_exec','outcomes','success',100)
        with self.assertRaisesRegex(ValueError, 'incomplete comparison metric marginal'):
            self.mime_bodies(f)

    def test_version_mix_changes_compare_batches_but_refuse_joint_call_claims(self):
        import copy
        for shifted in (False, True):
            f = copy.deepcopy(trend_fixture())
            f['previous']['cohorts'].append(('unknown_origin','0.8.1','tool_metrics',20))
            f['cohorts'] = [('unknown_origin','0.8.0','tool_metrics',20 if shifted else 40),
                            ('unknown_origin','0.8.1','tool_metrics',60 if shifted else 40),
                            ('unknown_origin','0.7.9','tool_counts',20)]
            f['events'][0] = ('unknown_origin','tool_metrics',80)
            for body in self.mime_bodies(f):
                self.assertIn('Version/instrumentation mix ' + ('changed' if shifted else 'stable at event-batch level'), body)
                self.assertIn('20/40 batches (50.0%)', body)
                self.assertIn('20/80 batches (25.0%)' if shifted else '40/80 batches (50.0%)', body)
                self.assertIn('version mix or version changed', body)
                self.assertIn('restricted version/tool/outcome aggregate is required', body)
                self.assertNotIn('Error and timeout comparison', body)
                # An independently compatible legacy stream still has a real comparison.
                self.assertIn('Same-stream call comparison', body)

    def test_trend_small_cells_and_cross_window_complements_hide_both_numeric_surfaces(self):
        import copy
        audience = dict(sender='fixture@example.invalid', recipient=w.RECIPIENT, approved_recipients=[w.RECIPIENT])
        private = audience | dict(enabled=True, host='mail.ialogics.co.uk', port=587, username='fixture', private_small_counts=audience.copy())
        for mode in ('previous_small_axis', 'version_complement', 'cross_window_total', 'cross_window_axis', 'cross_window_complement'):
            f = copy.deepcopy(trend_fixture())
            if mode == 'previous_small_axis':
                f['previous']['axes'] = [('unknown_origin','ssh_exec','outcomes',b,n) for b,n in [('success',179),('error',1),('timeout',20)]]
            elif mode == 'version_complement':
                f['previous']['cohorts'].append(('unknown_origin','0.7.8','tool_metrics',1))
            elif mode == 'cross_window_total':
                f['tools'][0] = ('unknown_origin','metrics','ssh_exec',201)
                f['axes'] = [('unknown_origin','ssh_exec','outcomes',b,n) for b,n in [('success',141),('error',40),('timeout',20)]]
            elif mode == 'cross_window_axis':
                f['axes'] = [('unknown_origin','ssh_exec','outcomes',b,n) for b,n in [('success',319),('error',41),('timeout',40)]]
            else:
                # Every supplied cell and cell delta is at least ten. The
                # non-error complement moves from 160 to 161 and must withhold.
                f['axes'] = [('unknown_origin','ssh_exec','outcomes',b,n) for b,n in [('success',120),('error',239),('timeout',41)]]
            for cfg in (None, private):
                with self.subTest(mode=mode, private=bool(cfg)):
                    for body in self.mime_bodies(f, cfg):
                        self.assertIn('Comparison and numeric details withheld: small cells or cross-window complementary disclosure risk', body)
                        for forbidden in ('ssh_exec', '0.8.0', '0.7.9', '40/200', '40/400', 'Outcome instrumentation coverage', '<table', 'recorded calls', 'observed,'):
                            self.assertNotIn(forbidden, body)

    def mime_bodies(self, data, cfg=None):
        from email import policy
        from email.parser import BytesParser
        messages = []
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp)/'config.json'
            config.write_text(json.dumps(cfg or dict(enabled=True, sender='fixture@example.invalid',
                recipient=w.RECIPIENT, approved_recipients=[w.RECIPIENT], host='mail.ialogics.co.uk', port=587, username='fixture')))
            w.main(['--config', str(config), '--state-dir', str(Path(tmp)/'state')], NOW,
                   lambda: Conn(result_rows(data)), lambda m, *a: messages.append(m.as_bytes()))
        msg = BytesParser(policy=policy.default).parsebytes(messages[0])
        self.assertEqual(msg.get_content_type(), 'multipart/alternative')
        return [p.get_content() for p in msg.iter_parts()]

    def test_composite_partition_changes_withhold_current_details_for_both_audiences(self):
        audience = dict(sender='fixture@example.invalid', recipient=w.RECIPIENT, approved_recipients=[w.RECIPIENT])
        private = audience | dict(enabled=True, host='mail.ialogics.co.uk', port=587,
                                  username='fixture', private_small_counts=audience.copy())
        # Each source cell, direct change and one-cell complement change is safe.
        # A union of cells nevertheless changes by one (or nine). Include the
        # sibling failure remainder, other metric axes, tool and batch tables.
        cases = [
            ('outcomes', [100,20,40,40], [79,42,140,139]),
            ('outcomes', [79,42,140,139], [100,20,40,40]),
            ('outcomes', [100,20,40,40], [87,42,132,139]),
            ('outcomes', [100,20,40,40,20,20], [79,42,140,117,31,31]),
            ('durations', [100,20,40,40], [79,42,140,139]),
            ('features', [100,20,40,40], [79,42,140,139]),
            ('tools', [100,20,40,40], [79,42,140,139]),
            ('streams', [100,20,40,40], [79,42,140,139]),
            ('versions', [100,20,40,40], [79,42,140,139]),
        ]
        for partition, old, new in cases:
            f = trend_fixture()
            for period, cells in zip((f['previous'], f), (old, new)):
                if partition == 'versions':
                    period['cohorts'] = [('unknown_origin', f'0.8.{i}', 'tool_metrics', n) for i,n in enumerate(cells)]
                elif partition in ('tools', 'streams'):
                    period['tools'] = [('unknown_origin', 'counts', t, n) for t,n in
                                       zip(('ssh_exec','winrm_exec','sftp_upload','sftp_download'), cells)]
                    if partition == 'streams':
                        period['tools'] = [(o,'counts','ssh_exec',n) for o,n in
                                           zip(('internal','test','unknown_origin','external_self_declared'), cells)]
                        period['cohorts'] = [(o,'0.8.0','tool_counts',20) for o,s,t,n in period['tools']]
                    period['axes'] = []
                else:
                    buckets = (('success','nonzero','error','timeout','cancelled','unknown') if partition == 'outcomes'
                               else ('lt100','lt1000','lt10000','gte10000') if partition == 'durations'
                               else ('execution','inspection','remote','transfer'))
                    period['tools'][0] = ('unknown_origin', 'metrics', 'ssh_exec', sum(cells))
                    period['axes'] = [('unknown_origin','ssh_exec',partition,b,n) for b,n in zip(buckets,cells)]
            self.assertTrue(all(n >= 10 for n in old + new))
            self.assertTrue(all(abs(b-a) >= 10 for a,b in zip(old,new)))
            self.assertTrue(all(abs((sum(new)-b)-(sum(old)-a)) >= 10 for a,b in zip(old,new)))
            for cfg in (None, private):
                for mime, body in zip(('text/plain','text/html'), self.mime_bodies(f, cfg)):
                    with self.subTest(partition=partition, new=new, private=bool(cfg), mime=mime):
                        self.assertIn('Comparison and numeric details withheld', body)
                        for forbidden in ('ssh_exec', '0.8.0', '<table', 'recorded calls',
                                          'Largest error', 'Outcome instrumentation coverage'):
                            self.assertNotIn(forbidden, body)

    def test_composite_partition_zero_and_threshold_changes_keep_useful_comparisons(self):
        for new in ([78,42,140,140], [88,42,131,139]):
            f = trend_fixture()
            for period, cells in ((f['previous'], [100,20,40,40]), (f, new)):
                period['axes'] = [('unknown_origin','ssh_exec','outcomes',b,n) for b,n in
                                  zip(('success','nonzero','error','timeout'), cells)]
            for body in self.mime_bodies(f):
                with self.subTest(new=new):
                    self.assertIn('Error and timeout comparison', body)
                    self.assertIn('40/200 (20.0%)', body)
                    self.assertIn(f'{new[2]}/400', body)
                    self.assertIn('Reliability: metric stream only', body)
                    self.assertNotIn('Comparison and numeric details withheld', body)

    def joint_axis_fixture(self, axis, second=42, origins=False, missing=False):
        f = trend_fixture()
        groups = [('unknown_origin','ssh_exec'), ('internal' if origins else 'unknown_origin','sftp_upload')]
        buckets = {'outcomes': ('error','success'), 'durations': ('gte10000','lt100'),
                   'features': ('remote','execution')}[axis]
        for period, counts in ((f['previous'], (100,20)), (f, (79,second))):
            period['cohorts'] = [(o,'0.8.0','tool_metrics',20) for o in sorted({o for o,t in groups})]
            period['tools'] = [(o,'metrics',t,1000) for o,t in groups]
            period['axes'] = [(o,t,axis,b,n) for (o,t),count in zip(groups,counts)
                              for b,n in zip(buckets,(count,1000-count)) if not (missing and t == 'sftp_upload')]
        if missing:
            # Error delta -21 + the uninstrumented tool's total delta +22 = 1.
            f['tools'][1] = (*f['tools'][1][:3],1022)
        return f

    def test_joint_axis_partitions_span_tools_origins_and_missing_instrumentation(self):
        audience = dict(sender='fixture@example.invalid', recipient=w.RECIPIENT, approved_recipients=[w.RECIPIENT])
        private = audience | dict(enabled=True, host='mail.ialogics.co.uk', port=587,
                                  username='fixture', private_small_counts=audience.copy())
        for axis in ('outcomes','durations','features'):
            for origins,missing in ((False,False),(True,False),(False,True)):
                f = self.joint_axis_fixture(axis, origins=origins, missing=missing)
                for cfg in (None,private):
                    for mime,body in zip(('plain','html'),self.mime_bodies(f,cfg)):
                        with self.subTest(axis=axis,origins=origins,missing=missing,private=bool(cfg),mime=mime):
                            self.assertIn('Comparison and numeric details withheld', body)
                            for forbidden in ('ssh_exec','sftp_upload','<table','Largest error','Outcome instrumentation coverage'):
                                self.assertNotIn(forbidden, body)

    def test_joint_event_batch_partition_spans_origins_versions_and_event_types(self):
        f = trend_fixture()
        for period,counts in ((f['previous'],(100,20)),(f,(79,42))):
            period['cohorts'] = [('unknown_origin','0.8.0','tool_metrics',counts[0]),
                                 ('internal','0.8.1','startup',counts[1])]
        for mime,body in zip(('plain','html'),self.mime_bodies(f)):
            with self.subTest(mime=mime):
                self.assertIn('Comparison and numeric details withheld', body)
                self.assertNotIn('<table',body)

    def test_joint_axis_zero_and_ten_changes_keep_both_audiences_useful(self):
        audience = dict(sender='fixture@example.invalid', recipient=w.RECIPIENT, approved_recipients=[w.RECIPIENT])
        private = audience | dict(enabled=True, host='mail.ialogics.co.uk', port=587,
                                  username='fixture', private_small_counts=audience.copy())
        for second in (41,51):
            for origins in (False,True):
                for cfg in (None,private):
                    for body in self.mime_bodies(self.joint_axis_fixture('outcomes',second,origins),cfg):
                        with self.subTest(second=second,origins=origins,private=bool(cfg)):
                            self.assertIn('Error and timeout comparison',body)
                            self.assertIn('100/1000 (10.0%)',body)
                            self.assertIn(f'{second}/1000',body)
                            self.assertIn('Reliability: metric stream only',body)
                            self.assertNotIn('Comparison and numeric details withheld',body)

    def test_overlapping_streams_and_independent_axes_remain_separate(self):
        f = self.joint_axis_fixture('outcomes',41)
        # These safe partitions have deltas -21 and +22. Combining overlapping
        # streams or independent axes would invent an unsafe delta of one.
        for period,current in ((f['previous'],False),(f,True)):
            period['tools'].append(('unknown_origin','counts','ssh_exec',1022 if current else 1000))
            period['cohorts'].append(('unknown_origin','0.8.0','tool_counts',20))
            period['axes'].extend(('unknown_origin','ssh_exec','durations',b,n) for b,n in
                                  [('gte10000',122 if current else 100),('lt100',878 if current else 900)])
        for body in self.mime_bodies(f):
            self.assertIn('Error and timeout comparison',body)
            self.assertIn('Legacy count stream: 1022 recorded calls',body)
            self.assertNotIn('Comparison and numeric details withheld',body)

    def test_composite_search_exhaustion_withholds_instead_of_admitting(self):
        from unittest.mock import patch
        before,after = dict(a=1000,b=1000),dict(a=1100,b=911)
        self.assertFalse(w.small_composite_change(before,after))  # possible changes: 0, 100, -89, 11
        for limit,value in (('COMPOSITE_MAX_CELLS',1),('COMPOSITE_MAX_STATES',1),
                            ('COMPOSITE_MAX_WORK',1),('COMPOSITE_MAX_BITS',6)):
            with self.subTest(limit=limit), patch.object(w,limit,value,create=True):
                # Three mixed-sign cells retain multiple reachable sums after
                # pruning; the two-cell example needs only one live state.
                self.assertTrue(w.small_composite_change(before | dict(c=1000),after | dict(c=911)))
        f = self.joint_axis_fixture('outcomes',41)
        with patch.object(w,'COMPOSITE_MAX_CELLS',1,create=True):
            for body in self.mime_bodies(f):
                self.assertIn('Comparison and numeric details withheld',body)
                self.assertNotIn('<table',body)

    def test_stable_version_streams_compare_calls_error_and_timeout_in_both_mime_parts(self):
        for body in self.mime_bodies(trend_fixture()):
            summary = body.split('Legacy count stream', 1)[0]
            for value in ('Completed-week comparison', '05 Oct 2026', '12 Oct 2026', '19 Oct 2026',
                          'Version/instrumentation coverage', '0.8.0', '0.7.9',
                          'Same-stream call comparison', 'Error and timeout comparison',
                          '40/200 (20.0%)', '40/400 (10.0%)', '-10.0 pp',
                          '20/200 (10.0%)', '+0.0 pp', '400/400', '200/200',
                          'descriptive', 'late arrivals', 'same repeatable-read snapshot'):
                self.assertIn(value, summary)
            self.assertNotIn('Comparison unavailable:', summary)
            self.assertNotIn('reason rate', summary)

    def test_adjacent_complete_weeks_share_restricted_snapshot(self):
        previous = dict(cohorts=[('unknown_origin', '0.8.0', 'tool_metrics', 20)],
                        tools=[('unknown_origin', 'metrics', 'ssh_exec', 200)],
                        axes=[('unknown_origin', 'ssh_exec', 'outcomes', 'success', 200)],
                        quality=[('valid', 'valid', 168)],
                        receipts=[(START-dt.timedelta(days=7)+dt.timedelta(hours=i), 1) for i in range(168)])
        f = fixture() | {'cohorts': previous['cohorts'], 'previous': previous}
        conn = Conn(result_rows(f))
        data = w.aggregates(conn, START, END)
        self.assertEqual(data.get('previous'), previous | {'start': START-dt.timedelta(days=7), 'end': START})
        self.assertEqual(data.get('cohorts'), f['cohorts'])
        self.assertEqual(sum('SET TRANSACTION' in s for s in conn.cur.sql), 1)
        for sql, params in zip(conn.cur.sql[11:-1], conn.cur.params[11:-1]):
            self.assertEqual(params, (START, END) if 'version_bucket' in sql and params == (START, END)
                             else (START-dt.timedelta(days=7), START))
            self.assertIn('>= %s', sql)
            self.assertIn('< %s', sql)
            self.assertNotIn('telemetry_', sql)
        self.assertIn('to_regprocedure', conn.cur.sql[-1])

    def test_first_screen_summary_distinguishes_error_volume_from_rate(self):
        f = fixture() | dict(
            adoption=[('internal', 30, 20, 10), ('external_self_declared', 10, 10, 0)],
            tools=[('internal', 'metrics', 'run_powershell', 100), ('internal', 'metrics', 'winrm_exec', 20)],
            axes=[('internal', t, 'outcomes', b, n) for t, b, n in
                  [('run_powershell', 'error', 30), ('run_powershell', 'success', 70), ('winrm_exec', 'error', 20)]])
        for body in w.report(f, START, END, NOW):
            summary = body.split('Legacy count stream', 1)[0]
            for value in ('Weekly findings', '30 observed', '20 active', '10 startup-only', 'installations, not people',
                          'external_self_declared', 'Largest error volume: run_powershell',
                          'Highest error rate: winrm_exec', '20/20', '100.0%',
                          'Comparison unavailable', 'equivalent completed UTC weeks', 'version/instrumentation',
                          'Action: review', 'Release/deployment status unavailable'):
                self.assertIn(value, summary)
            self.assertLess(body.index('Weekly findings'), body.index('Legacy count stream'))
            self.assertIn('Nonzero', body)
            self.assertIn('Timeout', body)
        for f in (fixture() | {'axes': []}, fixture() | {'tools': [], 'axes': []}):
            for body in w.report(f, START, END, NOW):
                summary = body.split('Legacy count stream', 1)[0]
                self.assertIn('Outcomes unavailable', summary)
                self.assertNotIn('Largest error volume:', summary)
                self.assertNotIn('Highest error rate:', summary)

    def test_safe_reasons_and_coverage_render_as_separate_marginal(self):
        for body in w.report(reason_fixture(), START, END, NOW):
            for value in ('invoke_exception', 'unknown', 'uninstrumented', '40/60', '66.7%', 'not a root cause'):
                self.assertIn(value, body)
            self.assertIn('Metric stream: 60 recorded calls', body)
            self.assertNotIn('120 recorded calls', body)

    def test_invalid_reason_aggregates_refuse_without_echoing_fields(self):
        from decimal import Decimal
        invalid = [
            [('PRIVATE', 'unknown', 60)], [('unknown_origin', 'PRIVATE', 60)],
            [('unknown_origin', ['unknown'], 60)], [('unknown_origin', None, 60)],
            [('unknown_origin', 'unknown', 60, 'PRIVATE')],
            [('unknown_origin', 'unknown', 30)] * 2,
            [('unknown_origin', 'unknown', 59)],
        ] + [[('unknown_origin', 'unknown', n)] for n in
             (True, 0, -1, 1.5, Decimal('NaN'), Decimal('Infinity'), '60')]
        for rows in invalid:
            with self.subTest(rows=rows):
                with self.assertRaises(ValueError):
                    w.report(reason_fixture() | {'winrm_reasons': rows}, START, END, NOW)

    def test_empty_reasons_are_unavailable_and_never_inferred_zero(self):
        for rows in (None, []):
            f = reason_fixture()
            f.pop('winrm_reasons')
            if rows is not None: f['winrm_reasons'] = rows
            for body in w.report(f, START, END, NOW):
                self.assertIn('WinRM diagnostics unavailable or withheld', body)
                self.assertNotIn('Reason coverage:', body)

    def test_reason_suppression_and_outcome_complements_ignore_private_optin(self):
        audience = dict(sender='sender@example.invalid', recipient=w.RECIPIENT, approved_recipients=[w.RECIPIENT])
        for reasons, outcomes in (
            ([('invoke_exception', 59), ('unknown', 1)], [('error', 60)]),
            ([('invoke_exception', 59), ('uninstrumented', 1)], [('error', 60)]),
            ([('invoke_exception', 20), ('unknown', 40)], [('error', 21), ('success', 39)]),
        ):
            f = reason_fixture() | {
                'winrm_reasons': [('unknown_origin', r, n) for r, n in reasons],
                'axes': [('unknown_origin', 'winrm_exec', 'outcomes', r, n) for r, n in outcomes]}
            for config in ({}, audience | {'private_small_counts': audience}):
                for body in w.report(f, START, END, NOW, config):
                    self.assertIn('WinRM diagnostics unavailable or withheld', body)
                    self.assertNotIn('invoke_exception', body)
                    self.assertNotIn('Reason coverage:', body)


    def test_restricted_reasons_use_same_snapshot_and_window(self):
        f = fixture() | {'winrm_reasons': [('unknown_origin', 'invoke_exception', 20)]}
        conn = Conn(result_rows(f))
        data = w.aggregates(conn, START, END)
        self.assertEqual(data.get('winrm_reasons'), f['winrm_reasons'])
        self.assertEqual(conn.cur.sql[10], 'SELECT origin, reason, calls FROM winrm_diagnostics_utc(%s,%s)')
        self.assertEqual(conn.cur.params[10], (START, END))

    def test_reason_enum_matches_existing_importer_without_extending_general_axes(self):
        import ast
        tree = ast.parse((Path(__file__).parents[1] / 'import_jsonl.py').read_text())
        contract = next(ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == 'WINRM_REASONS' for t in n.targets))
        self.assertEqual(w.WINRM_REASONS, contract | {'uninstrumented'})
        self.assertNotIn('winrmReasons', w.AXES)

    def test_user_proxy_coverage_rendering_and_complement_suppression_in_both_parts(self):
        data = fixture() | {'users': [('unknown_origin',20,10,10,10)]}
        for body in w.report(data, START, END, NOW):
            self.assertIn('Optional user pseudonym proxies and installation coverage', body)
            self.assertIn('Unknown user installations', body)
            self.assertIn('not anonymous or verified humans', body)
        data['users'] = [('unknown_origin',21,21,0,20)]
        for body in w.report(data, START, END, NOW):
            self.assertNotIn('Unknown user installations', body)
            self.assertIn('privacy suppression', body)
    def test_week_boundaries(self):
        self.assertEqual((START.isoformat(), END.isoformat()), ('2026-10-12T00:00:00+00:00', '2026-10-19T00:00:00+00:00'))
    def test_aggregate_grants_only_and_parameters(self):
        f = fixture()
        conn = Conn(result_rows(f))
        self.assertEqual(w.aggregates(conn, START, END)['adoption'], f['adoption'])
        self.assertTrue(all('telemetry_event ' not in s and 'telemetry_checkpoint ' not in s for s in conn.cur.sql))
        self.assertEqual(conn.cur.sql[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.assertTrue(all('%s' in s for s in conn.cur.sql[1:5]))
        self.assertIn('received_at >= %s AND received_at < %s', conn.cur.sql[5])
    def test_unknown_receipt_query_and_no_send(self):
        f = fixture()
        f['unknown_receipt_count'] = 1
        conn = Conn(result_rows(f))
        with self.assertRaisesRegex(ValueError, 'unassignable receipt'):
            w.render(w.aggregates(conn, START, END), START, END, NOW)
        sql = ' '.join(conn.cur.sql)
        self.assertIn('received_at IS NULL', sql)
        self.assertIn("receipt_time_quality IS DISTINCT FROM 'valid'", sql)
        self.assertIn('dashboard_events', sql)
        self.assertNotIn('event_at IS NULL', sql)
        self.assertEqual(conn.cur.sql[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.assertNotIn('WHERE received_at >=', conn.cur.sql[6])
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps(dict(enabled=True, recipient='isak@ialogics.com', approved_recipients=['isak@ialogics.com'], host='mail.ialogics.co.uk', port=587, sender='sender@example.invalid', username='sender')))
            state = Path(tmp) / 'state'
            with self.assertRaisesRegex(ValueError, 'unassignable receipt'):
                w.main(['--config', str(config), '--state-dir', str(state)], NOW,
                       lambda: Conn(result_rows(f)), lambda *args: self.fail('sent'))
            self.assertFalse(state.exists())

    def test_missing_unknown_receipt_field_fails_closed(self):
        f = fixture()
        del f['unknown_receipt_count']
        with self.assertRaises((KeyError, ValueError)):
            w.render(f, START, END, NOW)

    def test_render_separates_streams_and_proxies(self):
        body = w.render(fixture(), START, END, NOW)
        self.assertIn('Installation IDs are proxies, not people', body)
        self.assertIn('Legacy count stream: 13 recorded calls', body)
        self.assertIn('Metric stream: 13 recorded calls', body)
        self.assertNotIn('unique calls=6', body)
    def test_health_failures_and_privacy(self):
        for mutation in ('no_receipts', 'missing_hour', 'stale', 'quality', 'unsafe_tool'):
            with self.subTest(mutation=mutation):
                f = fixture()
                if mutation == 'no_receipts': f['receipts'] = []
                if mutation == 'missing_hour': f['receipts'].pop(4)
                if mutation == 'stale': f['imported'] = NOW - dt.timedelta(hours=3)
                if mutation == 'quality': f['quality'].append(('invalid', 'valid', 1))
                if mutation == 'unsafe_tool': f['tools'].append(('unknown_origin', 'counts', 'host=password', 1))
                with self.assertRaises(ValueError): w.render(f, START, END, NOW)
    def test_disabled_preview_delivery_and_ambiguous_replay(self):
        f = fixture()
        def connect(): return Conn(result_rows(f))
        sent = []
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            state = Path(tmp) / 'state'
            config.write_text('{}')
            args = ['--config', str(config), '--state-dir', str(state)]
            self.assertIn('Private telemetry digest', w.main(args + ['--preview'], NOW, connect))
            with self.assertRaisesRegex(ValueError, 'disabled'): w.main(args, NOW, connect)
            config.write_text(json.dumps(dict(enabled=True, recipient='isak@ialogics.com', approved_recipients=['isak@ialogics.com'], host='mail.ialogics.co.uk', port=587, sender='sender@example.invalid', username='sender')))
            def uncertain(msg, recipient, config):
                sent.append((msg, recipient))
                raise TimeoutError('ambiguous SMTP acceptance')
            with self.assertRaises(TimeoutError): w.main(args, NOW, connect, uncertain)
            with self.assertRaises(FileExistsError): w.main(args, NOW, connect, uncertain)
            self.assertEqual(len(sent), 1)
            self.assertEqual(len(list(state.glob('*.attempted'))), 1)
    def test_small_cells_and_complements_are_not_disclosed(self):
        f = fixture()
        f['adoption'] = [('internal', 1, 1, 0), ('test', 12, 11, 1)]
        f['events'] = [('internal', 'startup', 1), ('test', 'startup', 12)]
        f['tools'] = [('internal', 'counts', 'ssh_exec', 1), ('test', 'counts', 'ssh_exec', 12), ('internal', 'metrics', 'ssh_exec', 1), ('test', 'metrics', 'ssh_exec', 12)]
        f['axes'] = [('internal', 'ssh_exec', 'outcomes', 'success', 1), ('test', 'ssh_exec', 'outcomes', 'success', 12)]
        for body in (w.render(f, START, END, NOW), w.render_html(f, START, END, NOW)):
            self.assertIn('withheld', body)
            self.assertNotIn('ssh_exec', body)
            self.assertNotIn('internal |', body)
            self.assertNotIn('test |', body)
            self.assertNotIn('recorded calls', body)
            self.assertNotIn('<table', body)

    def test_derived_installation_complements_default_and_private_optin(self):
        audience = dict(sender='sender@example.invalid', recipient=w.RECIPIENT,
                        approved_recipients=[w.RECIPIENT])
        for observed, active, startup in ((12, 11, 0), (29, 10, 10), (21, 0, 20)):
            f = fixture() | {'adoption': [('unknown_origin', observed, active, startup)]}
            for body in w.report(f, START, END, NOW):
                self.assertIn('withheld', body)
                self.assertNotIn('recorded calls', body)
                self.assertNotIn('ssh_exec', body)
                self.assertNotIn('<table', body)
            for body in w.report(f, START, END, NOW, audience | {'private_small_counts': audience}):
                self.assertNotIn('withheld', body)
                self.assertIn('Installation proxies', body)
        for observed, active, startup in ((20, 10, 10), (30, 10, 10)):
            for body in w.report(fixture() | {'adoption': [('unknown_origin', observed, active, startup)]}, START, END, NOW):
                self.assertNotIn('withheld', body)

    def test_old_invalid_event_does_not_poison_clean_receipt_week(self):
        f = fixture()
        f['quality'] = [('valid', 'valid', 168)]
        self.assertIn('Private telemetry digest', w.render(f, START, END, NOW))

    def test_snapshot_is_established_before_first_query(self):
        f = fixture()
        conn = Conn(result_rows(f))
        w.aggregates(conn, START, END)
        self.assertEqual(conn.cur.sql[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')

    def test_unapproved_or_malformed_headers_leave_no_intent(self):
        f = fixture()
        def connect(): return Conn(result_rows(f))
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            state = Path(tmp) / 'state'
            args = ['--config', str(config), '--state-dir', str(state)]
            base = dict(enabled=True, recipient='isak@ialogics.com', approved_recipients=['approved@example.invalid'], host='mail.ialogics.co.uk', port=587, sender='sender@example.invalid', username='sender')
            for change in ({}, {'recipient': 'approved@example.invalid\nBcc: other@example.invalid', 'approved_recipients': ['approved@example.invalid\nBcc: other@example.invalid']}, {'recipient': 'approved@example.invalid', 'sender': 'sender@example.invalid\nBcc: other@example.invalid'}):
                config.write_text(json.dumps(base | change))
                with self.assertRaises(ValueError): w.main(args, NOW, connect, lambda *a: self.fail('delivery'))
                self.assertFalse(state.exists())

    def test_missing_recipient(self):
        f = fixture()
        def connect(): return Conn(result_rows(f))
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'enabled': True}))
            with self.assertRaisesRegex(ValueError, 'approved private recipient required'):
                w.main(['--config', str(config), '--state-dir', str(Path(tmp) / 'state')], NOW, connect)
            self.assertFalse((Path(tmp) / 'state').exists())


if __name__ == '__main__': unittest.main()

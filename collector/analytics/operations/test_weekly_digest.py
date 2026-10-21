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
    return dict(adoption=[('unknown_origin', 12, 11, 0)], events=[('unknown_origin', 'startup', 12)],
                tools=[('unknown_origin', 'counts', 'ssh_exec', 13), ('unknown_origin', 'metrics', 'ssh_exec', 13)],
                axes=[('unknown_origin', 'ssh_exec', 'outcomes', 'success', 13)],
                quality=[('valid', 'valid', 2)],
                receipts=[(START + dt.timedelta(hours=i), 1) for i in range(168)],
                imported=NOW - dt.timedelta(minutes=15))


class Cursor:
    def __init__(self, rows):
        self.rows = iter(rows)
        self.sql = []
    def __enter__(self): return self
    def __exit__(self, *a): pass
    def execute(self, sql, params=None):
        self.sql.append(sql)
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


class DigestTests(unittest.TestCase):
    def test_week_boundaries(self):
        self.assertEqual((START.isoformat(), END.isoformat()), ('2026-10-12T00:00:00+00:00', '2026-10-19T00:00:00+00:00'))
    def test_aggregate_grants_only_and_parameters(self):
        f = fixture()
        conn = Conn([f['adoption'], f['events'], f['tools'], f['axes'], f['quality'], f['receipts'], [(f['imported'],)]])
        self.assertEqual(w.aggregates(conn, START, END)['adoption'], f['adoption'])
        self.assertTrue(all('telemetry_event ' not in s and 'telemetry_checkpoint ' not in s for s in conn.cur.sql))
        self.assertEqual(conn.cur.sql[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.assertTrue(all('%s' in s for s in conn.cur.sql[1:5]))
        self.assertIn('received_at >= %s AND received_at < %s', conn.cur.sql[5])
    def test_render_separates_streams_and_proxies(self):
        body = w.render(fixture(), START, END, NOW)
        self.assertIn('Installation IDs are proxies, not people', body)
        self.assertIn('counts unknown_origin/ssh_exec: 13', body)
        self.assertIn('metrics unknown_origin/ssh_exec: 13', body)
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
        def connect(): return Conn([f['adoption'], f['events'], f['tools'], f['axes'], f['quality'], f['receipts'], [(f['imported'],)]])
        sent = []
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            state = Path(tmp) / 'state'
            config.write_text('{}')
            args = ['--config', str(config), '--state-dir', str(state)]
            self.assertIn('Private telemetry digest', w.main(args + ['--preview'], NOW, connect))
            with self.assertRaisesRegex(ValueError, 'disabled'): w.main(args, NOW, connect)
            config.write_text(json.dumps(dict(enabled=True, recipient='private@example.invalid', approved_recipients=['private@example.invalid'], host='localhost', port=587, sender='sender@example.invalid', username='sender')))
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
        f['tools'] = [('internal', 'counts', 'ssh_exec', 1), ('test', 'counts', 'ssh_exec', 12)]
        f['axes'] = [('internal', 'ssh_exec', 'outcomes', 'success', 1), ('test', 'ssh_exec', 'outcomes', 'success', 12)]
        body = w.render(f, START, END, NOW)
        self.assertNotIn('internal: observed installations=1', body)
        self.assertNotIn('test: observed installations=12', body)
        self.assertNotIn('internal/startup: 1', body)
        self.assertNotIn('test/startup: 12', body)
        self.assertNotIn('internal/ssh_exec: 1', body)
        self.assertNotIn('test/ssh_exec: 12', body)
        self.assertNotIn('internal/ssh_exec/outcomes/success: 1', body)
        self.assertNotIn('test/ssh_exec/outcomes/success: 12', body)

    def test_old_invalid_event_does_not_poison_clean_receipt_week(self):
        f = fixture()
        f['quality'] = [('valid', 'valid', 168)]
        self.assertIn('Private telemetry digest', w.render(f, START, END, NOW))

    def test_snapshot_is_established_before_first_query(self):
        f = fixture()
        conn = Conn([f['adoption'], f['events'], f['tools'], f['axes'], f['quality'], f['receipts'], [(f['imported'],)]])
        w.aggregates(conn, START, END)
        self.assertEqual(conn.cur.sql[0], 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')

    def test_unapproved_or_malformed_headers_leave_no_intent(self):
        f = fixture()
        def connect(): return Conn([f['adoption'], f['events'], f['tools'], f['axes'], f['quality'], f['receipts'], [(f['imported'],)]])
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            state = Path(tmp) / 'state'
            args = ['--config', str(config), '--state-dir', str(state)]
            base = dict(enabled=True, recipient='private@example.invalid', approved_recipients=['approved@example.invalid'], host='localhost', port=587, sender='sender@example.invalid', username='sender')
            for change in ({}, {'recipient': 'approved@example.invalid\nBcc: other@example.invalid', 'approved_recipients': ['approved@example.invalid\nBcc: other@example.invalid']}, {'recipient': 'approved@example.invalid', 'sender': 'sender@example.invalid\nBcc: other@example.invalid'}):
                config.write_text(json.dumps(base | change))
                with self.assertRaises(ValueError): w.main(args, NOW, connect, lambda *a: self.fail('delivery'))
                self.assertFalse(state.exists())

    def test_missing_recipient(self):
        f = fixture()
        def connect(): return Conn([f['adoption'], f['events'], f['tools'], f['axes'], f['quality'], f['receipts'], [(f['imported'],)]])
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.json'
            config.write_text(json.dumps({'enabled': True}))
            with self.assertRaisesRegex(ValueError, 'approved private recipient required'):
                w.main(['--config', str(config), '--state-dir', str(Path(tmp) / 'state')], NOW, connect)
            self.assertFalse((Path(tmp) / 'state').exists())


if __name__ == '__main__': unittest.main()

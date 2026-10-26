"""Synthetic local acceptance; these counts are never production evidence."""
import datetime as dt
from email import policy
from email.parser import BytesParser
import json
import os
from pathlib import Path
import tempfile
import shutil
import socketserver
import ssl
import subprocess
import sys
import threading
import unittest
from unittest.mock import patch

from test_weekly_digest import w, fixture, Conn, result_rows, START, END, NOW


def config():
    audience = dict(sender='sender@example.invalid', recipient='isak@ialogics.com',
                    approved_recipients=['isak@ialogics.com'])
    return dict(enabled=True, host='mail.ialogics.co.uk', port=587, username='sender',
                **audience, private_small_counts=audience.copy(),
                schedule_prior_week_end='2026-10-12')


class CandidateTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('openssl'), 'openssl required for isolated STARTTLS certificate')
    def test_real_starttls_scheduled_process_restart_and_replay(self):
        received = []
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cert, key = root/'cert.pem', root/'key.pem'
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
                            '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
                            '-keyout', str(key), '-out', str(cert)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            class Handler(socketserver.BaseRequestHandler):
                def handle(self):
                    conn = self.request
                    conn.settimeout(8)
                    reader = conn.makefile('rb')
                    conn.sendall(b'220 localhost fixture\r\n')
                    try:
                        while True:
                            line = reader.readline(65537)
                            if not line: break
                            verb = line.split(b' ',1)[0].strip().upper()
                            if verb == b'EHLO': conn.sendall(b'250-localhost\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n')
                            elif verb == b'STARTTLS':
                                conn.sendall(b'220 begin TLS\r\n')
                                reader.close()
                                conn = tls.wrap_socket(conn, server_side=True)
                                reader = conn.makefile('rb')
                            elif verb == b'AUTH':
                                self.assert_tls(conn)
                                conn.sendall(b'235 authenticated fixture\r\n')
                            elif verb in (b'MAIL', b'RCPT'): conn.sendall(b'250 OK\r\n')
                            elif verb == b'DATA':
                                conn.sendall(b'354 data\r\n')
                                chunks=[]
                                while True:
                                    part=reader.readline(65537)
                                    if part == b'.\r\n': break
                                    if not part: raise RuntimeError('incomplete fixture message')
                                    chunks.append(part)
                                received.append(b''.join(chunks))
                                conn.sendall(b'250 accepted\r\n')
                            elif verb == b'QUIT':
                                conn.sendall(b'221 bye\r\n'); break
                            else: conn.sendall(b'250 OK\r\n')
                    finally:
                        reader.close()
                        conn.close()
                def assert_tls(self, conn):
                    if not isinstance(conn, ssl.SSLSocket): raise RuntimeError('AUTH before TLS')
            with socketserver.TCPServer(('127.0.0.1',0), Handler) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                state=root/'state'; state.mkdir()
                anchor=state/w.intent_name(START-dt.timedelta(days=7), START, 'isak@ialogics.com')
                anchor.write_bytes(b'original intent preserved\n')
                (root/'config.json').write_text(json.dumps(config()))
                script = '''
import sys, datetime as dt, ssl, smtplib, os
from unittest.mock import patch
from test_weekly_digest import w, fixture, Conn, result_rows, END
root, port, cert = sys.argv[1:]
now=END+dt.timedelta(hours=3)
data=fixture() | {'imported':now}
real=smtplib.SMTP
context=ssl.create_default_context(cafile=cert)
def local(host, port_arg, **kw):
    assert host=='mail.ialogics.co.uk' and port_arg==587
    return real('127.0.0.1', int(port), **kw)
with patch.object(w.smtplib,'SMTP',side_effect=local), patch.object(w.ssl,'create_default_context',return_value=context):
    w.main(['--config',root+'/config.json','--state-dir',root+'/state','--scheduled'],now,lambda:Conn(result_rows(data)))
'''
                env = os.environ | {'PYTHONPATH': str(Path(__file__).parent), 'PYTHONDONTWRITEBYTECODE':'1',
                                    'DIGEST_SMTP_PASSWORD':'synthetic-fixture-password'}
                try:
                    commands = [sys.executable,'-c',script,str(root),str(server.server_address[1]),str(cert)]
                    first=subprocess.Popen(commands,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                    concurrent=subprocess.Popen(commands,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                    first_output=first.communicate(timeout=15)
                    concurrent_output=concurrent.communicate(timeout=15)
                    self.assertEqual(sorted([first.returncode,concurrent.returncode]),[0,1],repr((first_output,concurrent_output)))
                    second=subprocess.run(commands,env=env,capture_output=True,timeout=15)
                    self.assertNotEqual(second.returncode,0)
                    self.assertIn(b'FileExistsError', second.stderr)
                    self.assertEqual(len(received),1)
                    msg=BytesParser(policy=policy.default).parsebytes(received[0])
                    self.assertEqual(msg.get_content_type(),'multipart/alternative')
                    self.assertEqual(str(msg['To']),'isak@ialogics.com')
                    self.assertEqual(anchor.read_bytes(), b'original intent preserved\n')
                    accepted=list(state.glob('*.accepted'))
                    self.assertEqual(len(accepted),1)
                    self.assertTrue(json.loads(accepted[0].read_text())['scheduled'])
                finally:
                    server.shutdown()
                    thread.join(timeout=5)

    def run_digest(self, tmp, data=None, cfg=None, args=(), now=NOW, sink=None):
        p = Path(tmp) / 'config.json'
        p.write_text(json.dumps(cfg or config()))
        return w.main(['--config', str(p), '--state-dir', str(Path(tmp)/'state'), *args],
                      now, lambda: Conn(result_rows(data or fixture())), sink or (lambda *a: None))

    def test_private_multipart_and_separate_streams(self):
        data = fixture()
        data['tools'] = [('unknown_origin', 'counts', 'ssh_exec', 3),
                         ('unknown_origin', 'metrics', 'ssh_exec', 2)]
        data['axes'] = [('unknown_origin', 'ssh_exec', 'outcomes', 'success', 1),
                        ('unknown_origin', 'ssh_exec', 'outcomes', 'timeout', 1),
                        ('unknown_origin', 'ssh_exec', 'durations', 'gte10000', 2)]
        messages = []
        with tempfile.TemporaryDirectory() as tmp:
            self.run_digest(tmp, data, sink=lambda m, *a: messages.append(m.as_bytes()))
        msg = BytesParser(policy=policy.default).parsebytes(messages[0])
        self.assertEqual(msg.get_content_type(), 'multipart/alternative')
        text, html = [p.get_content() for p in msg.iter_parts()]
        for body in (text, html):
            for expected in ('Legacy count stream', 'Metric stream', 'ssh_exec', '50.0%', '10 seconds or more', '12 Oct 2026', '19 Oct 2026'):
                self.assertIn(expected, body)
            self.assertNotIn('src=', body)
        self.assertIn('<table', html)
        self.assertEqual(str(msg['To']), 'isak@ialogics.com')

    def test_preview_optin_is_audience_bound(self):
        for change in ({'sender': 'other@example.invalid'}, {'recipient': 'other@example.invalid'},
                       {'approved_recipients': ['isak@ialogics.com', 'other@example.invalid']}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                for preview in ('--preview','--preview-html'):
                    with self.assertRaisesRegex(ValueError, 'audience'):
                        self.run_digest(tmp, cfg=config() | change, args=[preview])
                self.assertFalse((Path(tmp)/'state').exists())

    def test_scheduled_outages_create_no_new_claim(self):
        monday = END + dt.timedelta(hours=3)
        for change in ({'imported':monday-dt.timedelta(hours=3)}, {'receipts':[]},
                       {'unknown_receipt_count':1}, {'quality':[]},
                       {'quality':[('invalid','valid',1)]}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                state=Path(tmp)/'state'; state.mkdir()
                anchor=state/w.intent_name(START-dt.timedelta(days=7),START,'isak@ialogics.com')
                anchor.write_bytes(b'prior intent\n')
                with self.assertRaises(ValueError):
                    self.run_digest(tmp, fixture() | {'imported':monday} | change,
                                    args=['--scheduled'],now=monday,sink=lambda *a:self.fail('SMTP on outage'))
                self.assertEqual(list(state.iterdir()),[anchor])

    def test_route_and_enabled_configuration_refuse_before_intent(self):
        for change in ({'host':'golem'}, {'port':25}, {'enabled':'false'},
                       {'recipient':'other@example.invalid','approved_recipients':['other@example.invalid'],'private_small_counts':None}):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError): self.run_digest(tmp,cfg=config() | change,sink=lambda *a:self.fail('SMTP'))
                self.assertFalse((Path(tmp)/'state').exists())

    def test_contract_dimensions_match_importer(self):
        import ast
        source=ast.parse((Path(__file__).parents[1]/'import_jsonl.py').read_text())
        constants={node.targets[0].id:ast.literal_eval(node.value) for node in source.body
                   if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name)
                   and node.targets[0].id in ('TOOLS','AXES')}
        self.assertEqual(w.TOOLS,constants['TOOLS'])
        self.assertEqual(w.AXES,constants['AXES'])

    def test_timer_invokes_schedule_guard_without_catchup(self):
        units=Path(__file__).with_name('systemd')
        service=(units/'analytics-weekly-digest.service').read_text()
        timer=(units/'analytics-weekly-digest.timer').read_text()
        self.assertIn('--scheduled',service)
        self.assertIn('UMask=0077',service)
        self.assertIn('Mon *-*-* 03:00:00 UTC',timer)
        self.assertIn('Persistent=false',timer)

    def test_missing_metrics_are_unavailable_and_default_withholds_html(self):
        data = fixture()
        data['tools'] = [('unknown_origin', 'counts', 'ssh_exec', 1)]
        data['axes'] = []
        with tempfile.TemporaryDirectory() as tmp:
            body = self.run_digest(tmp, data, args=['--preview'])
            self.assertIn('Outcomes unavailable', body)
            self.assertNotIn('0.0%', body)
        data['tools'] = []
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIn('No tool activity recorded', self.run_digest(tmp, data, args=['--preview']))
        data['tools'] = [('unknown_origin', 'counts', 'ssh_exec', 1)]
        self.assertIn('withheld', w.render_html(data, START, END, NOW))
        self.assertNotIn('ssh_exec', w.render_html(data, START, END, NOW))

    def test_future_checkpoint_and_unknown_axes_refuse(self):
        for key, value in [('imported', NOW+dt.timedelta(seconds=1)),
                           ('axes', [('unknown_origin', 'ssh_exec', 'outcomes', 'raw_error', 13)]),
                           ('axes', [('unknown_origin', 'ssh_exec', 'outcomes', 'success', 12)]),
                           ('tools', [('unknown_origin', 'password_secret', 'ssh_exec', 13)]),
                           ('tools', [('unknown_origin', 'counts', 'not_a_tool', 13)])]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(ValueError):
                    self.run_digest(tmp, fixture() | {key:value})
                self.assertFalse((Path(tmp)/'state').exists())

    def test_schedule_missing_anchor_late_tick_and_restart_replay(self):
        monday = END + dt.timedelta(hours=3)
        data = fixture() | {'imported': monday}
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'state|intent'):
                self.run_digest(tmp, data, args=['--scheduled'], now=monday)
            state = Path(tmp)/'state'
            state.mkdir(exist_ok=True)
            anchor = state/w.intent_name(START-dt.timedelta(days=7), START, 'isak@ialogics.com')
            anchor.write_bytes(b'original durable intent\n')
            sent=[]
            self.run_digest(tmp, data, args=['--scheduled'], now=monday, sink=lambda *a: sent.append(1))
            with self.assertRaises(FileExistsError):
                self.run_digest(tmp, data, args=['--scheduled'], now=monday, sink=lambda *a: sent.append(1))
            self.assertEqual(sent, [1])
            self.assertEqual(anchor.read_bytes(), b'original durable intent\n')
            with self.assertRaisesRegex(ValueError, 'schedule'):
                self.run_digest(tmp, args=['--scheduled'], now=NOW)

    def test_directory_sync_precedes_smtp_and_ambiguity_never_retries(self):
        order=[]
        with tempfile.TemporaryDirectory() as tmp, patch.object(w, 'sync_directory', side_effect=lambda p: order.append('sync')):
            def sink(*a):
                self.assertEqual(order[-1], 'sync')
                order.append('smtp')
                raise TimeoutError()
            with self.assertRaises(TimeoutError): self.run_digest(tmp, sink=sink)
            with self.assertRaises(FileExistsError): self.run_digest(tmp, sink=sink)
            self.assertEqual(order.count('smtp'), 1)

    def test_directory_sync_failure_keeps_claim_and_prevents_smtp(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(w, 'sync_directory', side_effect=[None,OSError('fixture fsync failure')]):
            with self.assertRaises(OSError):
                self.run_digest(tmp,sink=lambda *a:self.fail('SMTP before durable directory'))
            self.assertEqual(len(list((Path(tmp)/'state').glob('*.attempted'))),1)
            self.assertFalse(list((Path(tmp)/'state').glob('*.accepted')))


if __name__ == '__main__': unittest.main()

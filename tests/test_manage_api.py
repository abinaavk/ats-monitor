"""Tests for manage_api.py (stdlib unittest, Flask test client).

    python3 -m unittest tests.test_manage_api -v      (from the repo root)

The ats CLI is replaced by a small stub script written to a temp dir, so the
suite needs no root, systemd, docker or network. The stub records every call
(argv + stdin) so tests can prove how user input reaches the CLI.
"""
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import textwrap
import time
import types
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from flask import Flask  # noqa: E402

import manage_api  # noqa: E402

STUB = textwrap.dedent('''
    import json, os, sys, time
    argv = sys.argv[1:]
    raw = sys.stdin.read()
    rec = os.environ.get("STUB_RECORD")
    if rec:
        with open(rec, "a") as f:
            f.write(json.dumps({"argv": argv, "stdin": raw}) + "\\n")
    mode = os.environ.get("STUB_MODE", "ok")
    op = argv[1] if len(argv) > 1 else ""
    args = json.loads(raw) if raw.strip() else {}
    def out(o):
        sys.stdout.write(json.dumps(o) + "\\n"); sys.stdout.flush()
    if mode == "noresult":
        print("Traceback: boom")
        sys.stderr.write("fatal: password is hunter2 for https://tok3n@github.com/o/r.git\\n")
        sys.exit(1)
    if mode == "garbage":
        print("not json at all"); sys.exit(0)
    if mode.startswith("fail:"):
        out({"t": "result", "ok": False, "code": mode[5:], "error": "stub says " + mode[5:]}); sys.exit(1)
    if mode == "sleep":
        time.sleep(float(os.environ.get("STUB_SLEEP", "30")))
    if mode == "die":
        out({"t": "step", "id": "clone", "state": "start"}); out({"t": "log", "m": "working"})
        sys.stderr.write("killed by oom\\n"); os._exit(9)
    if mode in ("job", "jobfail"):
        d = float(os.environ.get("STUB_STEP", "0.15"))
        out({"t": "step", "id": "clone", "state": "start"})
        out({"t": "log", "m": "Cloning https://tok3n@github.com/o/r.git"}); time.sleep(d)
        out({"t": "step", "id": "clone", "state": "done"})
        out({"t": "step", "id": "build", "state": "start"}); out({"t": "log", "m": "building"}); time.sleep(d)
        if mode == "jobfail":
            out({"t": "step", "id": "build", "state": "fail"})
            out({"t": "result", "ok": False, "code": "failed", "error": "build failed"}); sys.exit(1)
        out({"t": "step", "id": "build", "state": "done"})
        out({"t": "log", "m": "done"})
        out({"t": "result", "ok": True, "data": {"op": op, "name": args.get("name")}}); sys.exit(0)
    if op == "services.list":
        data = {"services": [{"name": "alpha", "status": "active"}]}
    elif op == "system.dependencies":
        data = {"git": {"ok": True, "version": "2.43"}, "docker_access": {"ok": False}}
    elif op == "docker.info":
        data = {"available": True, "version": "27", "access": False, "hint": "add user to docker group"}
    else:
        data = {"op": op, "args": args}
    out({"t": "log", "m": "hello"})
    out({"t": "result", "ok": True, "data": data})
''')


def make_app():
    app = Flask(__name__)
    app.register_blueprint(manage_api.bp)
    return app


H = {'X-Requested-With': 'ats-monitor'}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='manage-test-')
        cls.stub = os.path.join(cls.tmp, 'ats_stub.py')
        with open(cls.stub, 'w') as f:
            f.write(STUB)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self):
        self.jobs = tempfile.mkdtemp(prefix='jobs-', dir=self.tmp)
        self.record = os.path.join(self.tmp, f'rec-{self._testMethodName}.jsonl')
        self.env = mock.patch.dict(os.environ, {
            'ATS_CLI': f'{shlex.quote(sys.executable)} {shlex.quote(self.stub)}',
            'ATS_MONITOR_JOBS_DIR': self.jobs, 'STUB_RECORD': self.record, 'STUB_MODE': 'ok'})
        self.env.start()
        self.addCleanup(self.env.stop)
        manage_api._procs.clear()
        self.app = make_app()
        self.c = self.app.test_client()

    def tearDown(self):
        # kill any job a test left running so the suite never leaks processes
        for entry in os.listdir(self.jobs):
            m = manage_api._read_meta(entry) if manage_api.JOB_ID_RE.match(entry) else None
            if m and m.get('pid'):
                try:
                    os.killpg(int(m['pid']), signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    pass
        for p in list(manage_api._procs.values()):
            try:
                p.wait(timeout=2)
            except Exception:
                pass

    def calls(self):
        if not os.path.exists(self.record):
            return []
        with open(self.record) as f:
            return [json.loads(x) for x in f if x.strip()]

    def j(self, resp):
        return resp.get_json()

    def wait_job(self, jid, timeout=15, since=0):
        end = time.time() + timeout
        while time.time() < end:
            d = self.j(self.c.get(f'/api/manage/jobs/{jid}?since={since}'))['data']
            if d['status'] != 'running':
                return d
            time.sleep(0.05)
        self.fail('job did not finish')


class TestRouting(Base):
    SPEC_ROUTES = [
        ('GET', '/api/manage/settings'), ('PUT', '/api/manage/settings'), ('GET', '/api/manage/dependencies'),
        ('GET', '/api/manage/domains/check'), ('GET', '/api/manage/ports/suggest'),
        ('GET', '/api/manage/services'), ('GET', '/api/manage/services/<name>'), ('POST', '/api/manage/services'),
        ('POST', '/api/manage/services/<name>/redeploy'), ('PATCH', '/api/manage/services/<name>'),
        ('DELETE', '/api/manage/services/<name>'), ('POST', '/api/manage/services/<name>/action'),
        ('GET', '/api/manage/services/<name>/logs'), ('POST', '/api/manage/services/<name>/logs/clear'),
        ('GET', '/api/manage/services/<name>/status'), ('GET', '/api/manage/services/<name>/resources'),
        ('GET', '/api/manage/backups'), ('POST', '/api/manage/backups'), ('POST', '/api/manage/backups/restore'),
        ('DELETE', '/api/manage/backups'), ('GET', '/api/manage/services/<name>/webhook'),
        ('POST', '/api/manage/services/<name>/webhook'), ('POST', '/api/manage/services/<name>/webhook/test'),
        ('GET', '/api/manage/cloudflare'), ('POST', '/api/manage/cloudflare/sync'),
        ('POST', '/api/manage/cloudflare/restart'), ('GET', '/api/manage/jobs/<job_id>'), ('GET', '/api/manage/jobs'),
    ]

    def test_route_table_matches_spec(self):
        have = set()
        for r in self.app.url_map.iter_rules():
            for m in r.methods - {'HEAD', 'OPTIONS'}:
                have.add((m, r.rule.replace('<name>', '<name>')))
        for m, p in self.SPEC_ROUTES:
            self.assertIn((m, p), have, f'missing {m} {p}')

    def test_reads_work_without_csrf_header(self):
        r = self.c.get('/api/manage/services')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.j(r), {'ok': True, 'data': {'services': [{'name': 'alpha', 'status': 'active'}]}})

    def test_writes_need_csrf_header(self):
        cases = [('post', '/api/manage/services', {}), ('put', '/api/manage/settings', {}),
                 ('patch', '/api/manage/services/alpha', {'port': 8000}),
                 ('delete', '/api/manage/services/alpha', {'confirm': 'alpha'}),
                 ('post', '/api/manage/services/alpha/action', {'action': 'start'}),
                 ('post', '/api/manage/cloudflare/restart', {}), ('delete', '/api/manage/backups', {'id': 1})]
        for method, url, body in cases:
            r = getattr(self.c, method)(url, json=body)
            self.assertEqual(r.status_code, 403, url)
            self.assertEqual(self.j(r)['code'], 'forbidden')
            r = getattr(self.c, method)(url, json=body, headers={'X-Requested-With': 'XMLHttpRequest'})
            self.assertEqual(r.status_code, 403, url)
        self.assertEqual(self.calls(), [], 'ats must not be called without the CSRF header')

    def test_session_auth_is_enforced_by_the_app(self):
        """The real app.py registers the blueprint behind its app-wide session check."""
        added = []
        try:
            import flask_socketio  # noqa: F401
        except ImportError:  # keep the test runnable without the production dependencies
            fake = types.ModuleType('flask_socketio')

            class SocketIO:
                def __init__(self, *a, **k):
                    pass

                def on(self, *a, **k):
                    return lambda f: f

                def emit(self, *a, **k):
                    pass

            fake.SocketIO, fake.emit = SocketIO, lambda *a, **k: None
            sys.modules['flask_socketio'] = fake
            added.append('flask_socketio')
        try:
            import app as monitor_app
        finally:
            for m in added:
                sys.modules.pop(m, None)
        self.assertIn('manage_api', monitor_app.app.blueprints)
        c = monitor_app.app.test_client()
        r = c.get('/api/manage/services')
        self.assertEqual(r.status_code, 401)
        r = c.post('/api/manage/services', json={}, headers=H)
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.calls(), [])
        with c.session_transaction() as sess:
            sess['authenticated'] = True
        self.assertEqual(c.get('/api/manage/services').status_code, 200)


class TestValidation(Base):
    def reject(self, method, url, body=None, status=400, code='validation'):
        r = getattr(self.c, method)(url, json=body, headers=H) if body is not None else getattr(self.c, method)(url, headers=H)
        self.assertEqual(r.status_code, status, f'{method} {url} {body} -> {r.get_data(as_text=True)}')
        d = self.j(r)
        self.assertFalse(d['ok'])
        self.assertEqual(d['code'], code)
        self.assertTrue(d['error'])

    def good_deploy(self, **kw):
        d = {'name': 'api-x', 'domain': 'api.example.com', 'repo_url': 'https://github.com/o/r.git'}
        d.update(kw)
        return d

    def test_service_names(self):
        for bad in ['a b', 'a;b', 'a$(id)', 'x' * 65, 'a.b', 'ünï', '-rf']:
            if bad == '-rf':  # allowed by the rule (starts with '-') but never reaches argv anyway
                continue
            self.reject('get', f'/api/manage/services/{bad}')
        self.reject('post', '/api/manage/services', self.good_deploy(name='bad name'))
        self.reject('post', '/api/manage/services', self.good_deploy(name=None))
        self.assertEqual(self.calls(), [])

    def test_deploy_fields(self):
        base = '/api/manage/services'
        for patch in [{'repo_url': 'http://github.com/o/r.git'}, {'repo_url': 'ftp://x/y'}, {'repo_url': 'https://a b/c'},
                      {'repo_url': 'https://x/\ny'}, {'repo_url': ''}, {'domain': 'a..b.com'}, {'domain': '.a.com'},
                      {'domain': 'a.com.'}, {'domain': '-a.com'}, {'domain': 'a-.com'}, {'domain': ('x' * 64) + '.com'},
                      {'domain': 'localhost'}, {'domain': 'a b.com'}, {'domain': ''},
                      {'port': 0}, {'port': 70000}, {'port': 'abc'}, {'port': True}, {'port': 80.5},
                      {'workers': 0}, {'workers': 33}, {'max_memory_mb': 10}, {'cpu_quota': 4}, {'cpu_quota': 801},
                      {'container_port': 0}, {'runtime': 'ruby'}, {'branch': '--upload-pack=x'}, {'branch': 'a b'},
                      {'branch': 'a..b'}, {'storage_root': 'relative/path'}, {'storage_root': '/opt/../etc'},
                      {'env': {'1BAD': 'x'}}, {'env': {'A-B': 'x'}}, {'env': {'OK': 'multi\nline'}},
                      {'env': {'OK': 'nul\x00'}}, {'env': {'OK': 5}}, {'env': ['A=B']}, {'auto_update': 'yes'},
                      {'shell': 'rm -rf /'}]:
            self.reject('post', base, self.good_deploy(**patch))
        self.reject('post', base, [1, 2])
        self.assertEqual(self.calls(), [], 'invalid input must be rejected before ats is invoked')

    def test_patch_fields(self):
        u = '/api/manage/services/alpha'
        self.reject('patch', u, {})
        self.reject('patch', u, {'port': 0})
        self.reject('patch', u, {'workers': 100})
        self.reject('patch', u, {'domain': 'bad_domain'})
        self.reject('patch', u, {'env': {'bad key': 'v'}})
        self.reject('patch', u, {'name': 'other'})
        self.reject('patch', u, {'runtime': 'docker'}, 422, 'unsupported')
        self.assertEqual(self.calls(), [])

    def test_actions_and_logs(self):
        u = '/api/manage/services/alpha'
        self.reject('post', u + '/action', {'action': 'rm -rf'})
        self.reject('post', u + '/action', {})
        self.reject('post', u + '/action', {'action': 'start', 'extra': 1})
        for q in ('source=../../etc/passwd', 'source=syslog', 'lines=0', 'lines=99999', 'lines=abc', 'grep=' + 'x' * 201):
            r = self.c.get(u + '/logs?' + q)
            self.assertEqual(r.status_code, 400, q)
        self.reject('post', u + '/logs/clear', {'source': 'journal'})
        self.reject('post', u + '/logs/clear', {'source': '../x'})
        self.assertEqual(self.calls(), [])

    def test_delete_requires_typed_name(self):
        u = '/api/manage/services/alpha'
        self.reject('delete', u, {})
        self.reject('delete', u, {'confirm': 'beta'})
        self.reject('delete', u, {'confirm': 'alpha', 'delete_files': 'yes'})
        self.reject('delete', u, {'confirm': 'alpha', 'rm': True})
        self.assertEqual(self.calls(), [])

    def test_backups(self):
        self.reject('post', '/api/manage/backups', {'name': 'a b'})
        self.reject('post', '/api/manage/backups', {'name': 'alpha', 'gdrive': 'true'})
        for fn in ['../../etc/passwd', 'a/b.tar.gz', '-rf', '', 'a b.tar.gz', '.hidden']:
            self.reject('post', '/api/manage/backups/restore', {'name': 'alpha', 'filename': fn, 'source': 'local'})
            self.reject('delete', '/api/manage/backups', {'filename': fn, 'source': 'local'})
        self.reject('post', '/api/manage/backups/restore', {'name': 'alpha', 'filename': 'a.tar.gz', 'source': 'ftp'})
        self.reject('delete', '/api/manage/backups', {'id': '../x'})
        self.reject('delete', '/api/manage/backups', {'id': True})
        r = self.c.get('/api/manage/backups?name=a%20b')
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.calls(), [])

    def test_settings(self):
        u = '/api/manage/settings'
        self.reject('put', u, {})
        self.reject('put', u, {'service_user': 'root'})
        self.reject('put', u, {'webhook': {'port': 1}})
        self.reject('put', u, {'storage_root': 'opt'})
        self.reject('put', u, {'domains': ['ok.com', 'ok.com']})
        self.reject('put', u, {'domains': ['bad_domain']})
        self.reject('put', u, {'domains': 'a.com'})
        self.reject('put', u, {'domains': ['a.com'], 'main_domain': 'b.com'})
        self.reject('put', u, {'defaults': {'workers': 0}})
        self.reject('put', u, {'defaults': {'bogus': 1}})
        self.reject('put', u, {'cloudflared_service': 'a; reboot'})
        self.reject('put', u, {'cloudflare_config': 'etc/x.yml'})
        self.reject('put', u, {'nonsense': 1})
        self.assertEqual(self.calls(), [])

    def test_misc_validation(self):
        self.assertEqual(self.c.get('/api/manage/domains/check?domain=a..b').status_code, 400)
        self.assertEqual(self.c.get('/api/manage/domains/check').status_code, 400)
        self.reject('post', '/api/manage/services/alpha/webhook', {})
        self.reject('post', '/api/manage/services/alpha/webhook', {'rotate_secret': 'yes'})
        self.reject('post', '/api/manage/cloudflare/sync', {'remove_orphans': 1})
        self.reject('post', '/api/manage/services/alpha/redeploy', {})
        self.reject('post', '/api/manage/services/alpha/redeploy', {'repo_url': 'http://x/y'})
        self.assertEqual(self.c.get('/api/manage/jobs/not-a-job').status_code, 400)
        self.assertEqual(self.c.get('/api/manage/jobs/0123456789abcdef?since=-1').status_code, 400)
        self.assertEqual(self.calls(), [])

    def test_body_size_cap(self):
        r = self.c.post('/api/manage/services', data=b'{"x":"' + b'a' * (300 * 1024) + b'"}',
                        content_type='application/json', headers=H)
        self.assertEqual(r.status_code, 413)
        self.assertEqual(self.calls(), [])

    def test_valid_requests_are_accepted(self):
        for method, url, body in [
            ('put', '/api/manage/settings', {'storage_root': '/srv', 'domains': ['a.com', 'b.org'], 'main_domain': 'a.com',
                                             'defaults': {'workers': 2, 'runtime': 'node'}, 'cloudflared_service': 'cloudflared'}),
            ('patch', '/api/manage/services/alpha', {'port': '8100', 'workers': 3, 'env': {'A_1': 'x y'}, 'auto_update': False}),
            ('post', '/api/manage/services/alpha/action', {'action': 'restart'}),
            ('post', '/api/manage/services/alpha/logs/clear', {'source': 'stderr'}),
            ('post', '/api/manage/services/alpha/webhook', {'rotate_secret': True}),
            ('delete', '/api/manage/backups', {'filename': 'alpha_20260101.tar.gz', 'source': 'gdrive'}),
            ('delete', '/api/manage/backups', {'id': 12}),
        ]:
            r = getattr(self.c, method)(url, json=body, headers=H)
            self.assertEqual(r.status_code, 200, f'{method} {url}: {r.get_data(as_text=True)}')


class TestBridge(Base):
    def test_argv_and_stdin_contract(self):
        self.c.patch('/api/manage/services/alpha', json={'port': 8100}, headers=H)
        (call,) = self.calls()
        self.assertEqual(call['argv'], ['--api', 'services.config.set'])
        self.assertEqual(json.loads(call['stdin']), {'port': 8100, 'name': 'alpha'})

    def test_dependencies_merges_docker_info(self):
        d = self.j(self.c.get('/api/manage/dependencies'))['data']
        self.assertTrue(d['dependencies']['git']['ok'])
        self.assertFalse(d['docker']['access'])
        self.assertEqual([c['argv'][1] for c in self.calls()], ['system.dependencies', 'docker.info'])

    def test_error_code_mapping(self):
        table = {'validation': 400, 'notfound': 404, 'conflict': 409, 'busy': 409, 'unsupported': 422,
                 'not_configured': 503, 'failed': 500}
        for code, status in table.items():
            with mock.patch.dict(os.environ, {'STUB_MODE': 'fail:' + code}):
                r = self.c.get('/api/manage/services')
            self.assertEqual(r.status_code, status, code)
            d = self.j(r)
            self.assertEqual((d['ok'], d['code'], d['error']), (False, code, 'stub says ' + code))
        with mock.patch.dict(os.environ, {'STUB_MODE': 'fail:martian'}):
            r = self.c.get('/api/manage/services')
        self.assertEqual((r.status_code, self.j(r)['code']), (500, 'failed'))

    def test_missing_result_line_is_failed_with_stderr_tail_redacted(self):
        with mock.patch.dict(os.environ, {'STUB_MODE': 'noresult'}):
            r = self.c.get('/api/manage/services')
        d = self.j(r)
        self.assertEqual((r.status_code, d['code'], d['bridge']), (500, 'failed', True))
        self.assertIn('hunter2', d['detail'])
        self.assertNotIn('tok3n', d['detail'])
        self.assertIn('***@github.com', d['detail'])
        self.assertIn('ats_stub.py', d['command'])

    def test_garbage_output_is_failed(self):
        with mock.patch.dict(os.environ, {'STUB_MODE': 'garbage'}):
            r = self.c.get('/api/manage/services')
        self.assertEqual((r.status_code, self.j(r)['code']), (500, 'failed'))

    def test_unreachable_cli(self):
        with mock.patch.dict(os.environ, {'ATS_CLI': '/nonexistent/ats-binary --flag'}):
            r = self.c.get('/api/manage/services')
        d = self.j(r)
        self.assertEqual((r.status_code, d['code'], d['bridge']), (503, 'unreachable', True))
        self.assertEqual(d['command'], '/nonexistent/ats-binary --flag')
        with mock.patch.dict(os.environ, {'ATS_CLI': "'unterminated"}):
            self.assertEqual(self.c.get('/api/manage/services').status_code, 503)

    def test_timeout(self):
        with mock.patch.dict(os.environ, {'STUB_MODE': 'sleep', 'STUB_SLEEP': '5'}):
            with self.assertRaises(manage_api.ApiError) as cm:
                manage_api.ats_call('services.list', {}, timeout=0.3)
        self.assertIn('timed out', cm.exception.error)

    def test_default_cli_is_sudo_ats(self):
        with mock.patch.dict(os.environ):
            os.environ.pop('ATS_CLI')
            raw, argv = manage_api.ats_command()
        self.assertEqual(argv[:3], ['sudo', '-n', 'python3'])
        self.assertTrue(raw.endswith('/home/gaia/ats/app.py'))


class TestNoShell(Base):
    EVIL = ['; touch {p}', '$(touch {p})', '`touch {p}`', '| touch {p}', '&& touch {p}', "'; touch {p}; '"]

    def test_input_never_reaches_a_shell_or_argv(self):
        pwn = os.path.join(self.tmp, 'pwned')
        for evil in self.EVIL:
            e = evil.format(p=pwn)
            self.c.get('/api/manage/services/alpha/logs?source=stdout&grep=' + __import__('urllib.parse').parse.quote(e))
            self.c.post('/api/manage/services', json={'name': 'svc', 'domain': 'a.example.com', 'repo_url': 'https://github.com/o/' + e.replace(' ', '%20') + '.git',
                                                      'env': {'K': e}}, headers=H)
            self.c.patch('/api/manage/services/alpha', json={'env': {'K': e}}, headers=H)
            self.c.post('/api/manage/services/alpha/redeploy', json={'repo_url': 'https://h/' + e.replace(' ', '%20')}, headers=H)
        self.assertFalse(os.path.exists(pwn), 'a shell metacharacter was executed')
        time.sleep(0.5)
        for call in self.calls():
            self.assertEqual(len(call['argv']), 2)
            self.assertEqual(call['argv'][0], '--api')
            self.assertIn(call['argv'][1], {'services.logs', 'services.deploy', 'services.config.set', 'services.redeploy'})
        # the evil strings travelled only as JSON on stdin
        self.assertTrue(any('touch' in c['stdin'] for c in self.calls()))

    def test_popen_is_called_without_shell(self):
        seen = []
        real_run, real_popen = subprocess.run, subprocess.Popen

        def run(*a, **k):
            seen.append(('run', a, k))
            return real_run(*a, **k)

        class P(real_popen):
            def __init__(self, *a, **k):
                seen.append(('popen', a, k))
                super().__init__(*a, **k)

        with mock.patch.object(manage_api.subprocess, 'run', run), mock.patch.object(manage_api.subprocess, 'Popen', P):
            self.c.get('/api/manage/services')
            with mock.patch.dict(os.environ, {'STUB_MODE': 'job'}):
                jid = self.j(self.c.post('/api/manage/backups', json={'name': 'alpha'}, headers=H))['data']['job_id']
            self.wait_job(jid)
        kinds = {s[0] for s in seen}
        self.assertEqual(kinds, {'run', 'popen'})
        for _, a, k in seen:
            self.assertFalse(k.get('shell'), 'shell=True is forbidden')
            self.assertIsInstance(a[0], list)
            self.assertEqual(a[0][-2], '--api')

    def test_source_has_no_shell_usage(self):
        with open(os.path.join(ROOT, 'manage_api.py')) as f:
            src = f.read()
        for needle in ('shell=True', 'os.system', 'os.popen', 'commands.getoutput'):
            self.assertNotIn(needle, src)


class TestJobs(Base):
    def post_job(self, body=None, mode='job', **env):
        env = dict({'STUB_MODE': mode}, **env)
        with mock.patch.dict(os.environ, env):
            r = self.c.post('/api/manage/services', json=body or {'name': 'api-x', 'domain': 'api.example.com',
                                                                  'repo_url': 'https://tok3n@github.com/o/r.git',
                                                                  'env': {'SECRET': 'topsecretvalue'}}, headers=H)
        return r

    def test_lifecycle_and_since(self):
        r = self.post_job(STUB_STEP='0.3')
        self.assertEqual(r.status_code, 202)
        jid = self.j(r)['data']['job_id']
        d = self.j(self.c.get(f'/api/manage/jobs/{jid}'))['data']
        self.assertEqual((d['id'], d['op'], d['name']), (jid, 'services.deploy', 'api-x'))
        self.assertIn(d['status'], ('running', 'done'))
        final = self.wait_job(jid)
        self.assertEqual(final['status'], 'done')
        self.assertEqual(final['result'], {'ok': True, 'data': {'op': 'services.deploy', 'name': 'api-x'}})
        self.assertEqual([(s['id'], s['state']) for s in final['steps']], [('clone', 'done'), ('build', 'done')])
        self.assertTrue(final['finished'])
        total = final['next']
        self.assertEqual(total, len(final['lines']))
        self.assertEqual(final['lines'][-1]['t'], 'result')
        # incremental polling: since=n returns only what comes after n
        mid = self.j(self.c.get(f'/api/manage/jobs/{jid}?since=3'))['data']
        self.assertEqual(mid['lines'], final['lines'][3:])
        self.assertEqual(mid['next'], total)
        tail = self.j(self.c.get(f'/api/manage/jobs/{jid}?since={total}'))['data']
        self.assertEqual((tail['lines'], tail['next']), ([], total))

    def test_polling_while_running_sees_progress(self):
        jid = self.j(self.post_job(STUB_STEP='0.4'))['data']['job_id']
        seen_running = False
        since, collected = 0, []
        end = time.time() + 15
        while time.time() < end:
            d = self.j(self.c.get(f'/api/manage/jobs/{jid}?since={since}'))['data']
            seen_running |= d['status'] == 'running'
            collected += d['lines']
            since = d['next']
            if d['status'] != 'running':
                break
            time.sleep(0.05)
        self.assertTrue(seen_running)
        self.assertEqual(d['status'], 'done')
        self.assertEqual(sum(1 for x in collected if x['t'] == 'step'), 4)

    def test_failed_job_marks_running_step_failed(self):
        jid = self.j(self.post_job(mode='jobfail'))['data']['job_id']
        d = self.wait_job(jid)
        self.assertEqual(d['status'], 'failed')
        self.assertEqual(d['result'], {'ok': False, 'code': 'failed', 'error': 'build failed'})
        self.assertEqual([(s['id'], s['state']) for s in d['steps']], [('clone', 'done'), ('build', 'fail')])

    def test_process_dying_without_result_is_failed_with_stderr(self):
        jid = self.j(self.post_job(mode='die'))['data']['job_id']
        d = self.wait_job(jid)
        self.assertEqual(d['status'], 'failed')
        self.assertEqual(d['result']['code'], 'failed')
        self.assertIn('killed by oom', d['result']['error'])
        self.assertEqual(d['steps'], [{'id': 'clone', 'state': 'fail'}])

    def test_one_running_job_per_service(self):
        jid = self.j(self.post_job(mode='sleep', STUB_SLEEP='30'))['data']['job_id']
        r = self.c.post('/api/manage/services/api-x/action', json={'action': 'update'}, headers=H)
        self.assertEqual(r.status_code, 409)
        d = self.j(r)
        self.assertEqual((d['code'], d['job_id']), ('busy', jid))
        r = self.c.post('/api/manage/backups', json={'name': 'api-x'}, headers=H)
        self.assertEqual(r.status_code, 409)
        # another service is independent
        with mock.patch.dict(os.environ, {'STUB_MODE': 'job'}):
            r = self.c.post('/api/manage/backups', json={'name': 'other'}, headers=H)
        self.assertEqual(r.status_code, 202)
        self.wait_job(self.j(r)['data']['job_id'])
        # once it ends the slot is free again
        os.killpg(manage_api._read_meta(jid)['pid'], signal.SIGKILL)
        self.assertEqual(self.wait_job(jid)['status'], 'failed')
        with mock.patch.dict(os.environ, {'STUB_MODE': 'job'}):
            r = self.c.post('/api/manage/backups', json={'name': 'api-x'}, headers=H)
        self.assertEqual(r.status_code, 202)
        self.wait_job(self.j(r)['data']['job_id'])

    def test_which_operations_are_jobs(self):
        with mock.patch.dict(os.environ, {'STUB_MODE': 'job'}):
            cases = [('post', '/api/manage/services/s1/action', {'action': 'update'}, 202),
                     ('post', '/api/manage/services/s2/action', {'action': 'rebuild'}, 202),
                     ('post', '/api/manage/services/s3/action', {'action': 'reinstall_deps'}, 202),
                     ('post', '/api/manage/services/s4/action', {'action': 'restart'}, 200),
                     ('post', '/api/manage/services/s4/action', {'action': 'stop'}, 200),
                     ('post', '/api/manage/services/s4/action', {'action': 'start'}, 200),
                     ('post', '/api/manage/services/s5/redeploy', {'repo_url': 'https://github.com/o/r.git'}, 202),
                     ('post', '/api/manage/services/s6/webhook/test', {}, 202),
                     ('post', '/api/manage/backups', {'name': 's7', 'gdrive': True}, 202),
                     ('post', '/api/manage/backups/restore', {'name': 's8', 'filename': 'f.tar.gz', 'source': 'local'}, 202),
                     ('delete', '/api/manage/services/s9', {'confirm': 's9', 'backup_first': True}, 202),
                     ('delete', '/api/manage/services/s10', {'confirm': 's10'}, 200)]
            ids = []
            for method, url, body, status in cases:
                r = getattr(self.c, method)(url, json=body, headers=H)
                self.assertEqual(r.status_code, status, f'{url} {body}')
                if status == 202:
                    ids.append(self.j(r)['data']['job_id'])
        for i in ids:
            self.wait_job(i)
        sync_ops = [c['argv'][1] for c in self.calls()]
        self.assertEqual(sync_ops.count('services.action'), 3 + 3)  # 3 sync actions + 3 job actions
        delete_calls = [json.loads(c['stdin']) for c in self.calls() if c['argv'][1] == 'services.delete']
        self.assertEqual(sorted(d['name'] for d in delete_calls), ['s10', 's9'])
        d10 = next(d for d in delete_calls if d['name'] == 's10')
        self.assertEqual((d10['confirm'], d10['delete_files'], d10['delete_backups'], d10['backup_first']), ('s10', True, False, False))

    def test_detached_job_survives_the_starting_process(self):
        env = dict(os.environ, STUB_MODE='job', STUB_STEP='0.5', PYTHONPATH=os.pathsep.join(filter(None, [ROOT, os.environ.get('PYTHONPATH')])))
        code = textwrap.dedent('''
            import json, sys
            from flask import Flask
            import manage_api
            app = Flask(__name__); app.register_blueprint(manage_api.bp)
            r = app.test_client().post("/api/manage/backups", json={"name": "survivor"}, headers={"X-Requested-With": "ats-monitor"})
            print(r.get_json()["data"]["job_id"])
        ''')
        out = subprocess.run([sys.executable, '-c', code], env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        jid = out.stdout.strip()
        meta = manage_api._read_meta(jid)
        self.assertTrue(manage_api._proc_state(meta['pid'], meta['ticks']), 'job should still be running after the monitor process exited')
        self.assertNotEqual(os.getsid(meta['pid']), os.getsid(0), 'job must run in its own session')
        self.assertEqual(os.getpgid(meta['pid']), meta['pid'])
        manage_api._procs.clear()
        self.c = make_app().test_client()  # a "restarted" monitor with no memory of the job
        d = self.wait_job(jid)
        self.assertEqual((d['status'], d['name']), ('done', 'survivor'))

    def test_secrets_are_not_left_on_disk_or_in_output(self):
        jid = self.j(self.post_job())['data']['job_id']
        d = self.wait_job(jid)
        files = os.listdir(os.path.join(self.jobs, jid))
        self.assertNotIn('args.json', files)
        for f in files:
            with open(os.path.join(self.jobs, jid, f), errors='replace') as fh:
                self.assertNotIn('topsecretvalue', fh.read(), f)
        cloning = [x['m'] for x in d['lines'] if x['t'] == 'log' and 'Cloning' in x['m']]
        self.assertEqual(cloning, ['Cloning https://***@github.com/o/r.git'])
        self.assertEqual(oct(os.stat(os.path.join(self.jobs, jid)).st_mode & 0o777), '0o700')
        self.assertEqual(oct(os.stat(self.jobs).st_mode & 0o777), '0o700')

    def test_unknown_job_and_listing(self):
        self.assertEqual(self.c.get('/api/manage/jobs/0123456789abcdef').status_code, 404)
        ids = []
        for n in ('a1', 'a2', 'a3'):
            with mock.patch.dict(os.environ, {'STUB_MODE': 'job'}):
                ids.append(self.j(self.c.post('/api/manage/backups', json={'name': n}, headers=H))['data']['job_id'])
            time.sleep(0.01)
        for i in ids:
            self.wait_job(i)
        rows = self.j(self.c.get('/api/manage/jobs'))['data']['jobs']
        self.assertEqual({r['id'] for r in rows}, set(ids))
        self.assertTrue(all(r['status'] == 'done' for r in rows))
        self.assertLessEqual(len(rows), 30)

    def test_old_jobs_are_reaped_but_running_ones_are_kept(self):
        jid = self.j(self.post_job(mode='sleep', STUB_SLEEP='30'))['data']['job_id']
        old = os.path.join(self.jobs, 'deadbeefdeadbeef')
        os.makedirs(old)
        with open(os.path.join(old, 'meta.json'), 'w') as f:
            json.dump({'id': 'deadbeefdeadbeef', 'op': 'x', 'name': 'old', 'status': 'done', 'started': 'x'}, f)
        past = time.time() - 25 * 3600
        for p in (os.path.join(old, 'meta.json'), old):
            os.utime(p, (past, past))
        self.c.get('/api/manage/jobs')
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(os.path.join(self.jobs, jid)))

    def test_unreachable_cli_for_job(self):
        with mock.patch.dict(os.environ, {'ATS_CLI': '/no/such/cli'}):
            r = self.c.post('/api/manage/backups', json={'name': 'alpha'}, headers=H)
        self.assertEqual((r.status_code, self.j(r)['code']), (503, 'unreachable'))
        self.assertEqual(self.j(self.c.get('/api/manage/jobs'))['data']['jobs'][0]['status'], 'failed')
        # a failed spawn must not block the service name
        with mock.patch.dict(os.environ, {'STUB_MODE': 'job'}):
            r = self.c.post('/api/manage/backups', json={'name': 'alpha'}, headers=H)
        self.assertEqual(r.status_code, 202)
        self.wait_job(self.j(r)['data']['job_id'])


if __name__ == '__main__':
    unittest.main()

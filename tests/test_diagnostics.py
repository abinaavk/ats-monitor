"""Failures name their cause; the Global adapter runs headless with only Flask installed."""
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess
import sys
import tempfile
import unittest
import unittest.mock

import test_servers

ROOT = Path(__file__).resolve().parents[1]
ADAPTER = ROOT / 'remote_host.py'


class ExplainedFailures(unittest.TestCase):
    # Reuse the real TLS Global + Local Monitor fixture, not its test cases.
    setUp = test_servers.ServersTests.setUp

    def csrf(self):
        return {'X-CSRF-Token': self.client.get('/api/settings').json['csrf_token']}

    def test_wrong_key_is_explained_and_never_leaks_credentials(self):
        key = self.node['secret']
        with self.global_store.db() as db:
            db.execute('UPDATE node SET secret=?', (secrets.token_hex(32),))
        response = self.client.get('/api/manage/services', headers=self.remote_headers)
        self.assertEqual(response.status_code, 503)
        text = response.get_json()['error']
        self.assertIn('rejected the server ID or passkey', text)
        self.assertIn('No operation was sent to Local', text)
        self.assertEqual(response.get_json()['code'], 'auth')
        self.assertNotIn(key, response.get_data(as_text=True))
        self.assertEqual(self.local_calls, [])

    def test_health_endpoint_reports_the_reason(self):
        self.http.shutdown()
        self.http.server_close()
        response = self.client.get('/api/servers/' + self.node['id'] + '/health')
        self.assertEqual(response.status_code, 503)
        body = response.get_json()
        self.assertEqual(body['status'], 'offline')
        self.assertIn('refused the connection', body['error'])
        self.assertEqual(body['code'], 'refused')

    def test_pairing_failures_say_why(self):
        headers = self.csrf()
        other = test_servers.Store(self.root / 'other.db').configure('global', 'Other', 'https://localhost')
        base = {'id': other['id'], 'name': 'Other', 'domain': self.origin, 'secret': other['secret']}
        response = self.client.post('/api/servers', json=base, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertRegex(response.get_json()['error'], r'Pairing failed: .*(passkey|different server ID)')
        # A duplicate saved name is reported as such, not as a generic failure.
        self.assertEqual(self.client.post('/api/servers', json=dict(base, id=self.node['id'], secret=self.node['secret'], name='Global'),
                                          headers=headers).status_code, 200)
        clash = dict(base, id=self.node['id'], secret=self.node['secret'], name='Global', domain=self.origin.replace('localhost', '127.0.0.1'))
        self.assertEqual(self.client.post('/api/servers', json=clash, headers=headers).status_code, 400)
        self.assertNotIn(self.node['secret'], json.dumps(self.client.get('/api/servers').get_json()))

    def test_credential_update_failure_is_specific_and_preserves_state(self):
        before = self.primary.server(self.node['id'])
        body = {'id': self.node['id'], 'name': 'Global', 'domain': self.origin, 'secret': secrets.token_hex(32)}
        response = self.client.post('/api/servers/%s/credentials' % self.node['id'], json=body, headers=self.csrf())
        self.assertEqual(response.status_code, 400)
        message = response.get_json()['error']
        self.assertIn('rejected the server ID or passkey', message)
        self.assertIn('Existing pairing and routes were preserved', message)
        self.assertNotIn(body['secret'], response.get_data(as_text=True))
        self.assertEqual(self.primary.server(self.node['id']), before)
        # A body missing fields is a clean 400, never a server error.
        bad = self.client.post('/api/servers/%s/credentials' % self.node['id'], json={'name': 'x'}, headers=self.csrf())
        self.assertEqual(bad.status_code, 400)


class ServerPageApi(unittest.TestCase):
    setUp = test_servers.ServersTests.setUp

    def test_server_list_shows_webhook_mappings_but_never_secrets(self):
        hook_secret = secrets.token_hex(32)
        self.primary.mapping('owner/site', self.node['id'], 'site', 'main', hook_secret)
        response = self.client.get('/api/servers')
        body = response.get_json()
        entry = next(item for item in body['servers'] if item['id'] == self.node['id'])
        self.assertEqual(entry['mappings'], [{'repository': 'owner/site', 'service': 'site', 'branch': 'main'}])
        self.assertEqual(body['webhook'], 'hooks.example.com')
        text = response.get_data(as_text=True)
        self.assertNotIn(hook_secret, text)
        self.assertNotIn(self.node['secret'], text)
        local = next(item for item in body['servers'] if item['local'])
        self.assertEqual(local['mappings'], [])

    def test_connection_test_reports_each_step(self):
        result = self.client.get('/api/servers/%s/test' % self.node['id']).get_json()
        self.assertTrue(result['ok'], result)
        self.assertEqual([step['name'] for step in result['steps']],
                         ['Signed health over HTTPS', 'Monitor adapter', 'Service read through the adapter'])
        self.assertTrue(all(step['ok'] for step in result['steps']))
        self.assertNotIn(self.node['secret'], json.dumps(result))

    def test_connection_test_explains_failures_and_states(self):
        sid = self.node['id']
        with self.global_store.db() as db:
            db.execute('UPDATE node SET secret=?', (secrets.token_hex(32),))
        wrong = self.client.get('/api/servers/%s/test' % sid).get_json()
        self.assertFalse(wrong['ok'])
        self.assertIn('rejected the server ID or passkey', wrong['steps'][0]['detail'])
        self.assertEqual(len(wrong['steps']), 1)
        self.primary.connection(sid, 'disconnect')
        off = self.client.get('/api/servers/%s/test' % sid).get_json()
        self.assertFalse(off['ok'])
        self.assertEqual(off['steps'][0]['name'], 'Connection setting')
        local = self.client.get('/api/servers/%s/test' % self.local['id']).get_json()
        self.assertTrue(local['ok'])
        self.assertEqual(self.client.get('/api/servers/%s/test' % ('f' * 32)).status_code, 404)

    def test_missing_adapter_stops_after_the_adapter_step(self):
        with unittest.mock.patch.dict(os.environ, {'ATS_MONITOR_ADAPTER': '/missing/remote_host.py'}):
            result = self.client.get('/api/servers/%s/test' % self.node['id']).get_json()
        self.assertFalse(result['ok'])
        self.assertEqual(result['steps'][-1]['name'], 'Monitor adapter')
        self.assertIn('server setup --apply', result['steps'][-1]['detail'])

    def test_page_requires_login(self):
        anonymous = self.app.test_client()
        self.assertEqual(anonymous.get('/api/servers/%s/test' % self.node['id']).status_code, 401)
        self.assertEqual(anonymous.get('/api/servers').status_code, 401)


class HeadlessAdapter(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        stub = self.root / 'cli.py'
        stub.write_text(test_servers.STUB)
        self.blocked = self.root / 'blocked'
        self.blocked.mkdir()
        # A Global has only Flask: Socket.IO and gevent must never be imported by the adapter.
        for module in ('flask_socketio', 'gevent', 'psutil'):
            (self.blocked / (module + '.py')).write_text(
                f'raise ModuleNotFoundError("No module named \'{module}\'", name="{module}")\n')
        self.env = dict(os.environ, ATS_MODULE_DIR=str(ROOT.parent / 'ats'), ATS_SECURITY_DB=str(self.root / 'sec.sqlite3'),
                        ATS_MONITOR_JOBS_DIR=str(self.root / 'jobs'), ATS_CLI=shlex.join([sys.executable, str(stub)]),
                        REMOTE_RECORD=str(self.root / 'record.jsonl'), PYTHONPATH=str(self.blocked), ATS_COOKIE_SECURE='false')
        if not (ROOT.parent / 'ats' / 'ats_cluster.py').is_file():
            self.env['ATS_MODULE_DIR'] = os.environ['ATS_MODULE_DIR']

    def run_adapter(self, *args, stdin='', env=None):
        return subprocess.run([sys.executable, str(ADAPTER), *args], input=stdin, capture_output=True, text=True,
                              env=env or self.env, timeout=60)

    def test_check_passes_without_socketio_gevent_or_psutil(self):
        result = self.run_adapter('--check')
        report = json.loads(result.stdout)
        self.assertTrue(report['ok'], report)
        self.assertEqual(result.returncode, 0)
        self.assertTrue(any('psutil' in note for note in report['notes']))
        self.assertEqual(json.loads(Path(self.root / 'record.jsonl').read_text().splitlines()[0])['op'], 'services.list')

    def test_check_reports_a_failing_ats_cli_and_a_missing_flask(self):
        broken = self.root / 'broken.py'
        broken.write_text('import sys\nsys.exit(1)\n')
        report = json.loads(self.run_adapter('--check', env=dict(self.env, ATS_CLI=shlex.join([sys.executable, str(broken)]))).stdout)
        self.assertFalse(report['ok'])
        self.assertTrue(any('ATS CLI could not list services' in item for item in report['problems']), report)
        (self.blocked / 'flask.py').write_text('raise ModuleNotFoundError("No module named \'flask\'", name="flask")\n')
        result = self.run_adapter('--check')
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 2)
        self.assertTrue(any("Python module 'flask' is missing" in item for item in report['problems']), report)

    def test_a_request_through_the_headless_adapter_works(self):
        result = self.run_adapter(stdin=json.dumps({'kind': 'http', 'method': 'GET', 'path': '/api/manage/services'}))
        self.assertEqual(result.returncode, 0, result.stderr[-500:])
        data = json.loads(result.stdout)
        self.assertEqual(data['status'], 200)
        self.assertEqual(data['body']['data']['services'][0]['name'], 'global-service')

    def test_operation_errors_keep_their_real_status_and_message(self):
        # Regression: any 4xx/409 from a Global operation crashed the adapter ("tuple has no is_json"),
        # so every refusal looked like an outage. Each must arrive as its own status and message.
        for code, status in (('notfound', 404), ('busy', 409), ('validation', 400), ('failed', 500)):
            failing = self.root / f'fail-{code}.py'
            failing.write_text('import json,sys\njson.load(sys.stdin)\n'
                               f'print(json.dumps({{"t":"result","ok":False,"code":"{code}","error":"{code} reason"}}))\n')
            env = dict(self.env, ATS_CLI=shlex.join([sys.executable, str(failing)]))
            result = self.run_adapter(stdin=json.dumps({'kind': 'http', 'method': 'POST', 'path': '/api/manage/services/web/action',
                                                        'body': {'action': 'restart'}}), env=env)
            self.assertEqual(result.returncode, 0, f'{code}: {result.stderr[-300:]}')
            data = json.loads(result.stdout)
            self.assertEqual(data['status'], status)
            self.assertEqual(data['body']['error'], f'{code} reason')

    def test_unexpected_exception_in_a_route_is_a_clean_500_not_an_adapter_crash(self):
        crashing = self.root / 'crash.py'
        crashing.write_text('raise SystemExit(3)\n')
        env = dict(self.env, ATS_CLI=shlex.join([sys.executable, str(crashing)]))
        result = self.run_adapter(stdin=json.dumps({'kind': 'http', 'method': 'GET', 'path': '/api/manage/services'}), env=env)
        self.assertEqual(result.returncode, 0, result.stderr[-300:])
        self.assertGreaterEqual(json.loads(result.stdout)['status'], 400)

    def test_a_failing_adapter_names_only_a_missing_module(self):
        (self.blocked / 'flask.py').write_text('raise ModuleNotFoundError("No module named \'flask\'", name="flask")\n')
        result = self.run_adapter(stdin=json.dumps({'kind': 'http', 'method': 'GET', 'path': '/api/manage/services'}))
        self.assertEqual(result.returncode, 1)
        self.assertIn("adapter-error: ModuleNotFoundError: No module named 'flask'", result.stderr)
        self.assertNotIn('Traceback', result.stderr)

    def test_adapter_flag_does_not_leak_into_other_importers(self):
        # Importing remote_host (as the Monitor's own tests do) must not turn the browser app headless.
        code = 'import os, remote_host; print(os.environ.get("ATS_MONITOR_HEADLESS"))'
        env = dict(self.env, PYTHONPATH=str(ROOT))
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, env=env, cwd=str(ROOT), timeout=60)
        self.assertEqual(result.stdout.strip(), 'None', result.stderr[-300:])


if __name__ == '__main__':
    unittest.main()

"""Fleet overview, updates, rotation, pairing codes, webhook mappings, alerts, registry backups and the audit trail.

The Global here is a real TLS listener from ATS in this process, so these exercise the real signed channel. The
two things that would touch the machine running the tests (updating the ATS checkout, the pairing file) are patched.
"""
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import activity
import ats_notify
import ats_update
import fleet_api
import security
import servers_api
import test_servers


class FleetBase(unittest.TestCase):
    setUp_servers = test_servers.ServersTests.setUp

    def setUp(self):
        self.setUp_servers()
        pairing = patch('ats_server_cli.default_pairing_path', return_value=self.root / 'pairing' / 'pairing.json')
        pairing.start()
        self.addCleanup(pairing.stop)
        fleet_api._refresh['at'] = 0.0
        self.token = self.client.get('/api/settings').json['csrf_token']
        self.sid = self.node['id']

    def csrf(self):
        return {'X-CSRF-Token': self.token}

    def post(self, path, body=None, **kwargs):
        return self.client.post(path, json=body if body is not None else {}, headers=self.csrf(), **kwargs)

    def audit(self):
        return self.client.get('/api/settings/devices').json['audit']


class AccessTests(FleetBase):
    def test_every_route_needs_a_session_and_changes_need_the_anti_csrf_token(self):
        outsider = self.app.test_client()
        for method, path in (('get', '/api/fleet'), ('post', '/api/fleet/refresh'), ('get', '/api/alerts'), ('put', '/api/alerts'), ('post', '/api/alerts/test'),
                             ('get', '/api/registry-backup'), ('post', '/api/registry-backup'), ('post', f'/api/servers/{self.sid}/update'),
                             ('post', f'/api/servers/{self.sid}/rotate'), ('post', '/api/servers/pair-code'), ('post', f'/api/servers/{self.sid}/mappings'),
                             ('delete', '/api/mappings/o/r'), ('post', '/api/mappings/o/r/test')):
            self.assertEqual(getattr(outsider, method)(path).status_code, 401, path)
            if method != 'get':
                self.assertEqual(getattr(self.client, method)(path, json={}).status_code, 403, path)        # signed in, but no token
        self.assertEqual(self.client.get('/api/fleet').status_code, 200)

    def test_a_global_registry_or_unconfigured_local_is_refused_politely(self):
        with patch.object(servers_api, 'registry', return_value=None), patch.object(fleet_api, 'registry', return_value=None):
            response = self.client.get('/api/fleet')
        self.assertEqual(response.status_code, 503)
        self.assertIn('server configure', response.json['error'])


class OverviewTests(FleetBase):
    def test_overview_reports_state_age_and_which_servers_are_outdated(self):
        now = time.time()
        local = self.primary.node()['id']
        import ats_status
        mine = ats_status.repo_info(Path(ats_status.__file__).parent).get('short')
        self.primary.kv_set('fleet_state', {
            self.sid: {'status': 'up', 'since': now - 50, 'last_ok': now, 'error': None, 'metrics': {'at': now, 'cpu': 5.0, 'memory': 40.0, 'disk': 55.0, 'ats': 'abc1234', 'companion': 'def5678'}},
            local: {'status': 'up', 'metrics': {'at': now, 'cpu': 1.0, 'memory': 20.0, 'disk': 30.0, 'ats': mine}}})
        self.primary.kv_set('fleet_events', [{'at': now - 5, 'kind': 'down', 'name': 'X', 'message': 'X is unreachable'}])
        data = self.client.get('/api/fleet').json
        by_id = {s['id']: s for s in data['servers']}
        self.assertTrue(by_id[self.sid]['outdated'] and by_id[self.sid]['updatable'])
        self.assertFalse(by_id[local]['outdated'] or by_id[local]['updatable'])
        self.assertFalse(data['watcher']['stale'])
        self.assertEqual(data['events'][0]['kind'], 'down')
        text = json.dumps(data)
        for private in (self.node['secret'], 'secret'):
            self.assertNotIn(private, text)

    def test_without_watcher_data_the_overview_says_so(self):
        data = self.client.get('/api/fleet').json
        self.assertTrue(data['watcher']['stale'])
        self.assertTrue(all(s['status'] == 'unknown' for s in data['servers']))

    def test_refresh_probes_the_real_global_over_the_signed_channel_and_is_rate_limited(self):
        data = self.post('/api/fleet/refresh').json
        remote = data['servers'][self.sid]
        self.assertEqual(remote['status'], 'up')
        self.assertTrue(0 <= remote['metrics']['cpu'] <= 100 and remote['metrics']['ats'])
        self.assertEqual(data['servers'][self.primary.node()['id']]['status'], 'up')
        self.assertIsNone(self.primary.kv_get('fleet_state'))                      # a refresh saves nothing
        again = self.post('/api/fleet/refresh')
        self.assertEqual(again.status_code, 429)
        self.assertIn('wait', again.json['error'])

    def test_refresh_shows_a_down_global_plainly(self):
        self.http.shutdown()
        self.http.server_close()
        data = self.post('/api/fleet/refresh').json['servers'][self.sid]
        self.assertEqual(data['status'], 'down')
        self.assertTrue(data['error'])


class UpdateAndRotationTests(FleetBase):
    def test_update_goes_through_the_signed_channel_and_is_audited(self):
        done = {'ats': {'changed': True, 'before': 'aaaaaaa', 'after': 'bbbbbbb', 'commits': ['Fix'], 'detached': False}, 'restart': True}
        with patch.object(ats_update, 'update', return_value=done) as update:
            response = self.post(f'/api/servers/{self.sid}/update', {'targets': 'ats'})
        self.assertEqual((response.status_code, response.json['result']['restart']), (200, True))
        update.assert_called_once_with('ats', restart=True)
        self.assertIn('server updated', self.audit()[0]['action'].replace('_', ' '))
        self.assertIn('ats', self.audit()[0]['detail'])

    def test_update_refuses_bad_targets_the_local_itself_and_old_globals(self):
        self.assertEqual(self.post(f'/api/servers/{self.sid}/update', {'targets': 'rm -rf'}).status_code, 400)
        self.assertEqual(self.post(f"/api/servers/{self.primary.node()['id']}/update").status_code, 400)
        with patch.object(ats_update, 'update', side_effect=ats_update.UpdateError('ats: the checkout has local changes; commit or discard them first')):
            response = self.post(f'/api/servers/{self.sid}/update')
        self.assertEqual(response.status_code, 400)
        self.assertIn('local changes', response.json['error'])

    def test_rotation_swaps_the_key_on_both_sides_and_the_saved_one_still_works(self):
        old = self.node['secret']
        response = self.post(f'/api/servers/{self.sid}/rotate')
        self.assertEqual(response.status_code, 200, response.json)
        fresh = self.global_store.node()['secret']
        self.assertNotEqual(fresh, old)
        self.assertEqual(self.primary.server(self.sid)['secret'], fresh)
        self.assertTrue(self.client.get(f'/api/servers/{self.sid}/health').json['status'] == 'online')
        self.assertNotIn(fresh + old, json.dumps(response.json))
        self.assertNotIn(fresh, json.dumps(response.json))
        self.assertIn('key rotated', self.audit()[0]['action'].replace('_', ' '))

    def test_pairing_with_a_code_adds_the_server_without_a_key(self):
        other = test_servers.Store(self.root / 'fresh.db')
        other.configure('local', 'Fresh', webhook='fresh.example.com')
        code, _ = self.global_store.make_pair_code()
        with patch.object(servers_api, 'Store', return_value=other):
            response = self.post('/api/servers/pair-code', {'domain': self.origin, 'code': code, 'name': 'Via code'})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(other.server(self.sid)['name'], 'Via code')
        with patch.object(servers_api, 'Store', return_value=other):
            again = self.post('/api/servers/pair-code', {'domain': self.origin, 'code': code})
        self.assertEqual(again.status_code, 400)
        self.assertIn('wrong, already used or expired', again.json['error'])
        self.assertNotIn(self.node['secret'], again.get_data(as_text=True))


class MappingTests(FleetBase):
    def create(self, **extra):
        return self.post(f'/api/servers/{self.sid}/mappings', dict({'repository': 'Owner/Site', 'service': 'service', 'branch': 'main'}, **extra))

    def test_a_mapping_is_created_with_a_secret_shown_once_and_listed_without_it(self):
        response = self.create()
        self.assertEqual(response.status_code, 200, response.json)
        secret = response.json['secret']
        self.assertRegex(secret, '^[0-9a-f]{64}$')
        self.assertEqual((response.json['repository'], response.json['payload_url']), ('owner/site', 'https://hooks.example.com/webhook'))
        listing = self.client.get('/api/servers').get_data(as_text=True)
        self.assertIn('owner/site', listing)
        self.assertNotIn(secret, listing)
        self.assertEqual(self.primary_route('owner/site')['secret'], secret)
        again = self.create()
        self.assertEqual(again.status_code, 400)                                  # never silently replaced
        self.assertIn('already', again.json['error'])
        self.assertNotIn(secret, again.get_data(as_text=True))
        self.assertEqual(self.primary_route('owner/site')['secret'], secret)
        self.assertIn('already', self.create(repository='Third/Repo').json['error'])    # one mapping per service per server
        detail = self.audit()[0]
        self.assertIn('owner/site', detail['detail'])
        self.assertNotIn(secret, json.dumps(self.audit()))

    def primary_route(self, repository):
        with self.primary.db() as db:
            return dict(db.execute('SELECT * FROM routes WHERE repository=?', (repository,)).fetchone())

    def test_bad_input_is_rejected_before_anything_is_stored(self):
        for body in ({'repository': 'no-slash'}, {'repository': 'a/b/c'}, {'repository': 5}, {'service': '../x'}, {'service': ''},
                     {'branch': '../../x'}, {'branch': '-rf'}, {'repository': 'o/r;x'}):
            self.assertEqual(self.create(**body).status_code, 400, body)
        self.assertEqual(self.post('/api/servers/' + 'a' * 32 + '/mappings', {'repository': 'o/r', 'service': 's'}).status_code, 400)
        with self.primary.db() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM routes').fetchone()[0], 0)

    def test_deleting_a_mapping_removes_only_that_one(self):
        self.create()
        self.post(f'/api/servers/{self.sid}/mappings', {'repository': 'other/repo', 'service': 'second'})
        response = self.client.delete('/api/mappings/Owner/Site', headers=self.csrf())
        self.assertEqual(response.status_code, 200, response.json)
        with self.primary.db() as db:
            self.assertEqual([r[0] for r in db.execute('SELECT repository FROM routes')], ['other/repo'])
        self.assertEqual(self.client.delete('/api/mappings/Owner/Site', headers=self.csrf()).status_code, 400)

    def test_the_test_delivery_checks_signature_public_address_server_and_service_without_deploying(self):
        self.create()
        with patch.object(fleet_api, 'deliver', return_value=200):
            data = self.post('/api/mappings/owner/site/test').json
        self.assertTrue(data['ok'], data)
        self.assertEqual([s['name'] for s in data['steps']], ['Mapping and signature', 'Public webhook address', 'Destination server reachable', 'Service exists there'])
        operations = (self.root / 'operations.jsonl').read_text() if (self.root / 'operations.jsonl').exists() else ''
        self.assertNotIn('services.action', operations)                           # a ping never starts a deploy
        self.assertEqual(self.primary_seen_count(), 0)                            # and leaves no delivery record behind

    def primary_seen_count(self):
        with self.primary.db() as db:
            return db.execute("SELECT count(*) FROM seen WHERE scope='webhook'").fetchone()[0]

    def test_each_failure_is_named(self):
        self.create()
        with patch.object(fleet_api, 'deliver', return_value=502):
            steps = {s['name']: s for s in self.post('/api/mappings/owner/site/test').json['steps']}
        self.assertFalse(steps['Public webhook address']['ok'])
        self.assertIn('HTTP 502', steps['Public webhook address']['detail'])
        self.assertTrue(steps['Destination server reachable']['ok'])
        self.post(f'/api/servers/{self.sid}/mappings', {'repository': 'o/gone', 'service': 'gone'})
        self.primary.connection(self.sid, 'disconnect')
        with patch.object(fleet_api, 'deliver', return_value=200):
            steps = {s['name']: s for s in self.post('/api/mappings/o/gone/test').json['steps']}
        self.assertIn('disconnected', steps['Destination server reachable']['detail'])
        self.assertNotIn('Service exists there', steps)
        self.assertEqual(self.post('/api/mappings/no/such/test').status_code, 400)


class AlertTests(FleetBase):
    CONFIG = {'ntfy': {'url': 'https://ntfy.example.com/alerts', 'token': 'tk_secretvalue'}, 'enabled': {'ntfy': True}, 'thresholds': {'failures': 2, 'disk': 85, 'memory': 90}}

    def put(self, config):
        return self.client.put('/api/alerts', json=config, headers=self.csrf())

    def test_settings_round_trip_with_secrets_masked_and_kept(self):
        saved = self.put(self.CONFIG)
        self.assertEqual(saved.status_code, 200, saved.json)
        shown = self.client.get('/api/alerts').json['config']
        self.assertEqual(shown['ntfy']['token'], ats_notify.MASK)
        self.assertNotIn('tk_secretvalue', self.client.get('/api/alerts').get_data(as_text=True))
        shown['thresholds']['disk'] = 80
        self.assertEqual(self.put(shown).status_code, 200)
        self.assertEqual(ats_notify.load(self.primary)['ntfy']['token'], 'tk_secretvalue')
        self.assertEqual(ats_notify.load(self.primary)['thresholds']['disk'], 80)
        self.assertIn('alerts changed', self.audit()[0]['action'].replace('_', ' '))

    def test_unsafe_settings_are_refused_with_the_reason(self):
        for config, word in (({'webhook': {'url': 'http://x.example.com'}}, 'https'), ({'enabled': {'telegram': True}}, 'Telegram'), ({'thresholds': {'disk': 5}}, 'disk')):
            response = self.put(config)
            self.assertEqual(response.status_code, 400)
            self.assertIn(word, response.json['error'])

    def test_a_test_alert_reports_per_channel_and_never_echoes_secrets(self):
        self.put(self.CONFIG)
        seen = []

        def opener(request, timeout):
            seen.append(request.full_url)
            raise ats_notify.NotifyError('HTTP 403')
        with patch.object(ats_notify, 'urlopen', opener):
            response = self.post('/api/alerts/test', {'channel': 'ntfy'})
        self.assertEqual(response.json['outcome']['ntfy'], {'ok': False, 'error': 'HTTP 403'})
        self.assertEqual(seen, ['https://ntfy.example.com/alerts'])
        self.assertNotIn('tk_secretvalue', response.get_data(as_text=True))
        self.assertEqual(self.post('/api/alerts/test', {'channel': 'sms'}).status_code, 400)
        self.assertIn('Save the telegram settings first', self.post('/api/alerts/test', {'channel': 'telegram'}).json['error'])


class RegistryBackupTests(FleetBase):
    def test_a_backup_can_be_made_listed_and_never_downloaded(self):
        self.assertEqual(self.client.get('/api/registry-backup').json['items'], [])
        made = self.post('/api/registry-backup')
        self.assertEqual(made.status_code, 200, made.json)
        self.assertFalse(made.json['encrypted'])
        listing = self.client.get('/api/registry-backup').json
        self.assertEqual(len(listing['items']), 1)
        self.assertEqual(listing['status']['last']['error'], None)
        path = Path(listing['directory']) / listing['items'][0]['name']
        self.assertEqual(oct(path.stat().st_mode & 0o777), '0o600')
        self.assertNotIn(self.node['secret'], json.dumps(listing))
        self.assertEqual(self.client.get('/api/registry-backup/' + path.name).status_code, 404)
        self.assertIn('registry backup created', self.audit()[0]['action'].replace('_', ' '))

    def test_an_encrypted_backup_needs_a_real_passphrase(self):
        self.assertEqual(self.post('/api/registry-backup', {'passphrase': 'short'}).status_code, 400)
        if os.system('openssl version >/dev/null 2>&1') == 0:
            made = self.post('/api/registry-backup', {'passphrase': 'a long enough passphrase'})
            self.assertTrue(made.json['encrypted'], made.json)
            self.assertNotIn('passphrase', made.get_data(as_text=True).lower().replace('"encrypted"', ''))


class AuditTrailTests(FleetBase):
    def test_remote_actions_record_device_server_and_target_but_never_content(self):
        names = [e['detail'] for e in self.audit() if e['detail']]
        self.assertEqual(names, [])
        self.client.post('/api/manage/services/service/action', json={'action': 'restart'}, headers=self.remote_headers)
        self.client.post('/api/manage/cloudflare/restart', json={}, headers=self.remote_headers)
        response = self.client.post('/api/manage/dependencies/install', json={'name': 'docker'}, headers=self.remote_headers)
        self.client.put('/api/manage/settings', json={'storage_root': '/tmp/global-storage'}, headers=self.remote_headers)
        self.client.post('/api/manage/cloudflare/restore', json={'name': 'c.yml.bak-20240101-101010', 'base_sha256': 'a' * 64}, headers=self.remote_headers)
        entries = {e['action']: e for e in self.audit()}
        self.assertEqual(entries['service_restart']['detail'], 'Global · service')
        self.assertEqual(entries['tunnel_restarted']['detail'], 'Global')
        self.assertEqual(entries['package_installed']['detail'], 'Global · docker')
        self.assertIn('server_settings_changed', entries)
        self.assertEqual(entries['tunnel_config_restored']['detail'], 'Global · c.yml.bak-20240101-101010')
        self.assertTrue(all(e['device_name'] for e in entries.values()))
        self.assertNotIn('/tmp/global-storage', json.dumps(self.audit()))             # request bodies are never recorded

    def test_reads_failures_to_authenticate_and_unrelated_posts_are_not_recorded(self):
        self.client.get('/api/manage/services', headers=self.remote_headers)
        self.app.test_client().post('/api/manage/services/service/action', json={'action': 'restart'}, headers=self.remote_headers)
        self.client.post('/api/manage/services/service/action', json={'action': 'format-disk'}, headers=self.remote_headers)
        self.client.post('/api/manage/services/service/logs/clear', json={}, headers=self.remote_headers)
        self.assertEqual([e for e in self.audit() if e['action'].startswith(('service_', 'tunnel_'))], [])

    def test_failed_attempts_say_so(self):
        self.client.post('/api/manage/dependencies/install', json={'name': 'git'}, headers=self.remote_headers)
        entry = [e for e in self.audit() if e['action'] == 'package_installed'][0]
        self.assertIn('failed (HTTP 400)', entry['detail'])

    def test_actions_on_this_server_name_it_and_the_terminal_helper_finds_the_device(self):
        self.client.post('/api/manage/services/service/action', json={'action': 'stop'}, headers={'X-ATS-Target': self.primary.node()['id'], 'X-Requested-With': 'ats-monitor'})
        self.assertIn('Local (this server)', [e for e in self.audit() if e['action'] == 'service_stop'][0]['detail'])
        with self.app.test_request_context('/'):
            with security.database() as db:
                token_hash = db.execute('SELECT token_hash FROM auth_sessions').fetchone()[0]
            security.record_for_session(token_hash, 'terminal_opened', activity.describe('Global'))
            security.record_for_session('nonexistent', 'terminal_opened', 'orphan')
        rows = [e for e in self.audit() if e['action'] == 'terminal_opened']
        self.assertEqual({e['detail'] for e in rows}, {'Global', 'orphan'})
        self.assertTrue([e for e in rows if e['detail'] == 'Global'][0]['device_name'])

    def test_describe_and_classify_are_strict(self):
        self.assertEqual(activity.describe('Box', 'svc', 502), 'Box · svc · failed (HTTP 502)')
        self.assertIsNone(activity.classify('POST', '/api/manage/services/../x/action', {'action': 'restart'}))
        self.assertEqual(activity.classify('POST', '/api/manage/dependencies/install', {'name': 'x;rm -rf /'}), ('package_installed', None))
        self.assertIsNone(activity.classify('GET', '/api/manage/services', None))


if __name__ == '__main__':
    unittest.main()

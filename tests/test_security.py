"""Device credentials, isolation, persistence and authorization regression tests."""
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from flask import Flask, jsonify, session
import security


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.path=self.tmp.name+'/security.sqlite3'
        self.env=patch.dict(os.environ,{'ATS_COOKIE_SECURE':'false'})
        self.env.start()
        self.app=self.make_app()
        self.a=self.app.test_client();self.b=self.app.test_client()

    def tearDown(self):
        self.env.stop();self.tmp.cleanup()

    def make_app(self):
        app=Flask(__name__,template_folder=str(Path(__file__).resolve().parents[1]/'templates'))
        app.config.update(TESTING=True,ATS_SECURITY_DB=self.path)
        security.init_app(app,'test-password')
        app.add_url_rule('/',view_func=lambda:jsonify(ok=True))
        return app

    def login(self,c):
        c.get('/login')
        with c.session_transaction() as s:csrf=s['login_csrf']
        r=c.post('/login',data={'password':'test-password','csrf_token':csrf})
        self.assertEqual(r.status_code,302)
        return c.get('/api/settings').json['current_device_id']

    def change(self,c,path,body=None):
        csrf=c.get('/api/settings').json['csrf_token']
        return c.post(path,json={'password':'test-password',**(body or {})},headers={'X-CSRF-Token':csrf})

    def trust(self,c,did):
        return self.change(c,'/api/settings/devices/'+did+'/trust')

    def test_unauthorized_endpoints_and_forged_legacy_cookie(self):
        for endpoint in ['/','/api/settings','/api/settings/devices','/api/auth/status']:
            self.assertIn(self.a.get(endpoint).status_code,(302,401))
        with self.a.session_transaction() as s:s['authenticated']=True
        self.assertEqual(self.a.get('/api/settings').status_code,401)

    def test_login_csrf_and_password(self):
        self.assertEqual(self.a.post('/login',data={'password':'test-password'}).status_code,403)
        self.a.get('/login')
        with self.a.session_transaction() as s:csrf=s['login_csrf']
        self.assertEqual(self.a.post('/login',data={'password':'wrong','csrf_token':csrf}).status_code,401)
        self.assertEqual(self.a.post('/login',data={'password':'test-password','csrf_token':csrf},headers={'Origin':'https://attacker.example'}).status_code,403)
        self.login(self.a)

    def test_metadata_and_unavailable_fields(self):
        self.login(self.a)
        d=self.a.get('/api/settings/devices').json['devices'][0]
        self.assertTrue(d['current']);self.assertIsNone(d['mac']);self.assertIsNone(d['location'])
        self.assertEqual(d['active_sessions'],1);self.assertIsNone(d['trusted_until'])

    def test_absolute_expiry_not_extended_by_keepalive(self):
        self.login(self.a)
        expires=self.a.get('/api/auth/status').json['expires_at']
        with patch('security.time.time',return_value=expires-1):
            self.assertEqual(self.a.post('/api/session-keepalive').json['expires_at'],expires)
        with patch('security.time.time',return_value=expires+1):
            self.assertEqual(self.a.get('/api/auth/status').status_code,401)

    def test_csrf_and_password_required_for_mutation(self):
        did=self.login(self.a);path='/api/settings/devices/'+did+'/trust'
        self.assertEqual(self.a.post(path,json={'password':'test-password'}).status_code,403)
        csrf=self.a.get('/api/settings').json['csrf_token']
        self.assertEqual(self.a.post(path,json={'password':'bad'},headers={'X-CSRF-Token':csrf}).status_code,403)
        self.assertEqual(self.a.post(path,json={'password':'test-password'},headers={'X-CSRF-Token':csrf,'Origin':'http://evil.test'}).status_code,403)
        self.assertFalse(self.a.get('/api/auth/status').json['trusted'])

    def test_trust_isolated_and_persistent_reauthentication(self):
        first=self.login(self.a);self.login(self.b)
        self.assertEqual(self.trust(self.a,first).status_code,200)
        self.assertTrue(self.a.get('/api/auth/status').json['trusted'])
        self.assertFalse(self.b.get('/api/auth/status').json['trusted'])
        self.a.delete_cookie(security.SESSION_COOKIE)
        self.a.delete_cookie('session')
        self.assertEqual(self.a.get('/login').status_code,302)
        self.assertTrue(self.a.get('/api/auth/status').json['trusted'])

    def test_trust_absolute_expiry(self):
        did=self.login(self.a);self.trust(self.a,did)
        expires=self.a.get('/api/auth/status').json['expires_at']
        with patch('security.time.time',return_value=expires+1):
            self.assertEqual(self.a.get('/api/settings').status_code,401)

    def test_revocation_rejects_old_complete_cookie_set(self):
        did=self.login(self.a);self.trust(self.a,did);self.login(self.b)
        stolen={key:self.a.get_cookie(key).value for key in (security.SESSION_COOKIE,security.DEVICE_COOKIE,'session')}
        self.assertEqual(self.change(self.b,'/api/settings/devices/'+did+'/revoke').status_code,200)
        replay=self.app.test_client()
        for key,value in stolen.items():replay.set_cookie(key,value)
        self.assertEqual(replay.get('/api/settings').status_code,401)
        self.assertEqual(self.b.get('/api/settings').status_code,200)
        self.assertNotEqual(self.login(replay),did)

    def test_untrust_forces_standard_login(self):
        did=self.login(self.a);self.trust(self.a,did)
        r=self.change(self.a,'/api/settings/devices/'+did+'/untrust')
        self.assertTrue(r.json['reauthenticate']);self.assertEqual(self.a.get('/api/settings').status_code,401)
        self.assertEqual(self.login(self.a),did)
        self.assertFalse(self.a.get('/api/auth/status').json['trusted'])

    def test_logout_all_others_removes_trust(self):
        self.login(self.a);did=self.login(self.b);self.trust(self.b,did)
        self.assertEqual(self.change(self.a,'/api/settings/logout-others').status_code,200)
        self.assertEqual(self.b.get('/api/settings').status_code,401)
        self.assertEqual(self.a.get('/api/settings').status_code,200)

    def test_logout_cannot_silently_reauthenticate(self):
        did=self.login(self.a);self.trust(self.a,did)
        self.a.delete_cookie(security.SESSION_COOKIE)
        self.assertEqual(self.a.get('/logout').status_code,302)
        self.assertEqual(self.a.get('/api/settings').status_code,401)

    def test_device_and_session_survive_restart(self):
        did=self.login(self.a);self.trust(self.a,did)
        cookies={key:self.a.get_cookie(key).value for key in (security.SESSION_COOKIE,security.DEVICE_COOKIE,'session')}
        app=self.make_app();client=app.test_client()
        for key,value in cookies.items():client.set_cookie(key,value)
        self.assertEqual(client.get('/api/settings').json['current_device_id'],did)
        self.assertTrue(client.get('/api/auth/status').json['trusted'])

    def test_hashes_permissions_no_secrets_in_api_or_audit(self):
        self.login(self.a)
        raw=self.a.get_cookie(security.DEVICE_COOKIE).value
        token=self.a.get_cookie(security.SESSION_COOKIE).value
        self.assertEqual(os.stat(self.path).st_mode & 0o777,0o600)
        with self.app.app_context(),security.database() as db:
            dump='\n'.join(db.iterdump())
        for secret in (raw,token,'test-password'):
            self.assertNotIn(secret,dump)
            self.assertNotIn(secret,self.a.get('/api/settings/devices').text)
        self.assertEqual(self.a.get('/api/settings').headers['Cache-Control'],'no-store')

    def test_malformed_unknown_and_rate_limit(self):
        did=self.login(self.a);csrf=self.a.get('/api/settings').json['csrf_token']
        path='/api/settings/devices/'+did+'/trust'
        self.assertEqual(self.a.post(path,json=[],headers={'X-CSRF-Token':csrf}).status_code,400)
        self.assertEqual(self.change(self.a,'/api/settings/devices/missing/trust').status_code,404)
        for _ in range(10):self.assertEqual(self.change(self.a,path,{'password':'bad'}).status_code,403)
        self.assertEqual(self.trust(self.a,did).status_code,403)

    def test_login_rotates_and_invalidates_previous_session(self):
        self.login(self.a);old=self.a.get_cookie(security.SESSION_COOKIE).value
        self.a.delete_cookie(security.SESSION_COOKIE)
        self.a.delete_cookie('session')
        self.login(self.a)
        with self.app.app_context():self.assertIsNone(security.valid_session(old))

    def test_socket_registry_rejects_expiry_and_revocation(self):
        did=self.login(self.a)
        with self.a.session_transaction() as s:auth=s['auth_id']
        with self.app.app_context():self.assertTrue(security.socket_authorized(auth))
        self.login(self.b);self.change(self.b,'/api/settings/devices/'+did+'/logout')
        with self.app.app_context():self.assertFalse(security.socket_authorized(auth))

    def test_session_alone_or_device_alone_cannot_authenticate_standard(self):
        self.login(self.a)
        for name in (security.SESSION_COOKIE,security.DEVICE_COOKIE):
            replay=self.app.test_client();replay.set_cookie(name,self.a.get_cookie(name).value)
            self.assertEqual(replay.get('/api/settings').status_code,401)

    def test_profile_update_requires_authorization(self):
        self.login(self.a);csrf=self.a.get('/api/settings').json['csrf_token']
        self.assertEqual(self.a.patch('/api/settings',json={'display_name':'Admin','password':'test-password'},headers={'X-CSRF-Token':csrf}).status_code,200)
        self.assertEqual(self.a.get('/api/settings').json['profile']['display_name'],'Admin')
        self.assertEqual(self.a.patch('/api/settings',json={'display_name':'','password':'test-password'},headers={'X-CSRF-Token':csrf}).status_code,400)

    def test_concurrent_device_trust_is_isolated(self):
        from concurrent.futures import ThreadPoolExecutor
        first=self.login(self.a);second=self.login(self.b)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda pair:self.trust(*pair),[(self.a,first),(self.b,second)]))
        self.assertEqual([result.status_code for result in results],[200,200])
        self.assertTrue(self.a.get('/api/auth/status').json['trusted'])
        self.assertTrue(self.b.get('/api/auth/status').json['trusted'])
        self.change(self.a,'/api/settings/devices/'+second+'/untrust')
        self.assertTrue(self.a.get('/api/auth/status').json['trusted'])
        self.assertEqual(self.b.get('/api/settings').status_code,401)

    def test_production_cookie_flags(self):
        with patch.dict(os.environ,{'ATS_COOKIE_SECURE':'true'}):app=self.make_app()
        c=app.test_client();c.get('/login',base_url='https://localhost')
        with c.session_transaction() as s:csrf=s['login_csrf']
        response=c.post('/login',base_url='https://localhost',data={'password':'test-password','csrf_token':csrf})
        cookies=response.headers.getlist('Set-Cookie')
        self.assertEqual(len(cookies),3)
        for cookie in cookies:
            for flag in ('Secure','HttpOnly','SameSite=Lax','Path=/'):self.assertIn(flag,cookie)

if __name__=='__main__':unittest.main()

"""Local authentication + real HTTPS Global adapter integration with host fixtures."""
import http.client
import json
import os
from pathlib import Path
import secrets
import shlex
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from flask import Flask, jsonify
import security
import servers_api
from cluster_support import Store, remote
import ats_remote


STUB = '''import sys,json,os,time
args=json.load(sys.stdin);op=sys.argv[-1]
with open(os.environ['REMOTE_RECORD'],'a') as f:f.write(json.dumps({'op':op,'args':args})+'\\n')
if op=='services.get':data={'name':args['name'],'repo_url':'https://github.com/owner/repo.git','branch':'main','auto_update':True}
elif op=='services.list':data={'services':[{'name':'global-service','status':'active'}]}
else:data={'target':'global','op':op,'args':args}
print(json.dumps({'t':'log','m':'global operation '+op}))
print(json.dumps({'t':'result','ok':True,'data':data}))
'''


class ServersTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.primary=Store(self.root/'primary.db');self.local=self.primary.configure('local','Local',webhook='hooks.example.com')
        self.global_store=Store(self.root/'global.db');self.node=self.global_store.configure('global','Global','https://localhost')
        cert=self.root/'cert';key=self.root/'key'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],check=True,capture_output=True)
        stub=self.root/'cli.py';stub.write_text(STUB)
        docker=self.root/'docker';docker.write_text('#!/usr/bin/env python3\nimport json,sys\nif sys.argv[1]=="ps":print(json.dumps({"Names":"global-container","ID":"abc123"}))\nelif sys.argv[1]=="version":print(json.dumps({"Server":{"Version":"27"},"Client":{"Version":"27"}}))\n');docker.chmod(0o700)
        ping=self.root/'ping';ping.write_text('#!/bin/sh\nexit 0\n');ping.chmod(0o700)
        systemctl=self.root/'systemctl';systemctl.write_text('#!/bin/sh\necho active\n');systemctl.chmod(0o700)
        home=self.root/'global-home';home.mkdir();(home/'ats.log').write_text('GLOBAL LOG MARKER\n');(home/'audit.trace').write_text('{"action":"GLOBAL AUDIT"}\n')
        with sqlite3.connect(home/'ats.db') as db:
            db.execute('CREATE TABLE services(name TEXT,port INTEGER,domain TEXT,runtime TEXT,storage_path TEXT,created_at TEXT)')
            db.execute("INSERT INTO services VALUES('global-service',9000,'global.example','node','/tmp','2026-01-01')")
        self.env=patch.dict(os.environ,{'ATS_CLUSTER_DB':self.global_store.path,'ATS_HOME':str(home),'ATS_MODULE_DIR':str(Path(ats_remote.__file__).resolve().parent),
            'ATS_MONITOR_ADAPTER':str(Path(__file__).resolve().parents[1]/'remote_host.py'),'ATS_CLI':shlex.join([sys.executable,str(stub)]),
            'ATS_MONITOR_JOBS_DIR':str(self.root/'jobs'),'ATS_SECURITY_DB':str(self.root/'remote-security.db'),
            'ATS_COOKIE_SECURE':'false','REMOTE_RECORD':str(self.root/'operations.jsonl'),'DOCKER_BIN':str(docker),
            'SSL_CERT_FILE':str(cert),'PATH':str(self.root)+os.pathsep+os.environ['PATH']})
        self.env.start();self.addCleanup(self.env.stop)
        self.http=ats_remote.Server(('127.0.0.1',0),self.global_store)
        ctx=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);ctx.load_cert_chain(cert,key)
        self.http.socket=ctx.wrap_socket(self.http.socket,server_side=True)
        threading.Thread(target=self.http.serve_forever,daemon=True).start()
        self.addCleanup(self.http.server_close);self.addCleanup(self.http.shutdown)
        self.origin='https://localhost:'+str(self.http.server_port)
        self.primary.pair(self.node['id'],'Global',self.origin,self.node['secret'])
        self.store_patch=patch.object(servers_api,'Store',return_value=self.primary);self.store_patch.start();self.addCleanup(self.store_patch.stop)
        self.app=Flask(__name__,template_folder=str(Path(__file__).resolve().parents[1]/'templates'));self.app.config.update(TESTING=True,ATS_SECURITY_DB=str(self.root/'local-security.db'))
        security.init_app(self.app,'password');servers_api.initialize(self.app)
        import fleet_api;fleet_api.initialize(self.app)
        self.local_calls=[]
        def local_view(**kwargs):self.local_calls.append(kwargs);return jsonify(target='LOCAL SENTINEL')
        for i,path in enumerate(['/api/overview','/api/logs','/api/database','/api/stats','/api/audit','/api/docker/containers','/api/manage/services','/api/manage/services/<name>/action','/api/manage/jobs','/api/manage/jobs/<job_id>','/api/manage/settings','/api/manage/backups']):
            self.app.add_url_rule(path,'local'+str(i),local_view,methods=['GET','POST','PUT','PATCH','DELETE'])
        self.client=self.app.test_client();self.client.get('/login')
        with self.client.session_transaction() as s:csrf=s['login_csrf']
        self.assertEqual(self.client.post('/login',data={'password':'password','csrf_token':csrf}).status_code,302)
        self.remote_headers={'X-ATS-Target':self.node['id'],'X-Requested-With':'ats-monitor'}

    def test_all_host_reads_use_real_global_http_with_zero_local_calls(self):
        expected={'/api/overview':'global-service','/api/logs':'GLOBAL LOG MARKER','/api/database':'global-service','/api/stats':'global-service','/api/audit':'GLOBAL AUDIT','/api/docker/containers':'global-container','/api/manage/services':'global-service','/api/manage/settings':'global','/api/manage/backups':'global'}
        for path,marker in expected.items():
            with self.subTest(path=path):
                r=self.client.get(path,headers=self.remote_headers)
                self.assertEqual(r.status_code,200,r.get_data(as_text=True));self.assertIn(marker,r.get_data(as_text=True))
        self.assertEqual(self.local_calls,[])

    def test_remote_mutation_and_job_stay_on_origin(self):
        r=self.client.post('/api/manage/services/service/action',json={'action':'update'},headers=self.remote_headers)
        self.assertEqual(r.status_code,202,r.get_data(as_text=True));jid=r.json['data']['job_id']
        r=self.client.get('/api/manage/jobs/'+jid,headers=self.remote_headers)
        self.assertEqual(r.status_code,200);self.assertEqual(r.json['data']['name'],'service');self.assertEqual(r.json['data']['server_id'],self.node['id'])
        calls=(self.root/'operations.jsonl').read_text();self.assertIn('services.action',calls);self.assertIn('"update"',calls)
        self.assertEqual(self.local_calls,[])
        local=self.client.get('/api/manage/jobs/'+jid,headers={'X-ATS-Target':self.local['id']})
        self.assertEqual(local.json['target'],'LOCAL SENTINEL')

    def test_remote_docker_settings_and_backup_mutations(self):
        for method,path,body,status in [('POST','/api/docker/containers/abc123/restart',{},200),
                ('PUT','/api/manage/settings',{'storage_root':'/tmp/global-storage'},200),
                ('POST','/api/manage/backups',{'name':'backup-service','gdrive':False},202)]:
            with self.subTest(path=path):
                response=self.client.open(path,method=method,json=body,headers=self.remote_headers)
                self.assertEqual(response.status_code,status,response.get_data(as_text=True))
        self.assertEqual(self.local_calls,[])
        calls=(self.root/'operations.jsonl').read_text()
        self.assertIn('settings.set',calls);self.assertIn('backups.create',calls)

    def test_disconnected_unknown_missing_target_never_falls_back(self):
        self.primary.connection(self.node['id'],'disconnect')
        for sid in [self.node['id'],'a'*32,None]:
            headers={} if sid is None else {'X-ATS-Target':sid}
            self.assertEqual(self.client.get('/api/overview',headers=headers).status_code,503)
        self.assertEqual(self.local_calls,[])
        self.primary.connection(self.node['id'],'reconnect')
        self.assertEqual(self.client.get('/api/logs',headers=self.remote_headers).status_code,200)

    def test_session_origin_csrf_and_credential_redaction(self):
        outsider=self.app.test_client();self.assertEqual(outsider.get('/api/servers').status_code,401)
        self.assertEqual(self.client.post('/api/manage/services/service/action',json={'action':'restart'},headers={**self.remote_headers,'Origin':'https://attacker.example'}).status_code,403)
        self.assertEqual(self.client.post('/api/servers/'+self.node['id']+'/disconnect',json={}).status_code,403)
        response=self.client.get('/api/servers');self.assertNotIn(self.node['secret'],response.get_data(as_text=True));self.assertNotIn('secret',response.get_data(as_text=True))
        token=self.client.get('/api/settings').json['csrf_token']
        r=self.client.post('/api/servers/'+self.node['id']+'/disconnect',json={},headers={'X-CSRF-Token':token})
        self.assertEqual(r.status_code,200)
        self.assertEqual(self.local_calls,[])

    def test_health_distinguishes_api_listener_from_management_adapter(self):
        path='/api/servers/'+self.node['id']+'/health'
        self.assertTrue(self.client.get(path).json['management_ready'])
        with patch.dict(os.environ, {'ATS_MONITOR_ADAPTER':'/missing/remote_host.py'}):
            response=self.client.get(path)
            self.assertEqual(response.status_code,200)
            self.assertFalse(response.json['management_ready'])

    def test_server_edit_is_authenticated_verified_and_preserves_disconnect(self):
        token=self.client.get('/api/settings').json['csrf_token']
        path='/api/servers/'+self.node['id']
        body={'name':'Renamed','domain':self.origin}
        self.assertEqual(self.client.patch(path,json=body).status_code,403)
        self.primary.connection(self.node['id'],'disconnect')
        response=self.client.patch(path,json=body,headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,200,response.json)
        server=self.primary.server(self.node['id'])
        self.assertEqual(server['name'],'Renamed');self.assertFalse(server['connected'])
        response=self.client.patch(path,json={**body,'domain':'http://localhost'},headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,400)
        self.assertEqual(self.primary.server(self.node['id']),server)

    def test_remote_adapter_rejects_arbitrary_and_auth_routes(self):
        server=self.primary.server(self.node['id'])
        for path in ['/api/settings','/api/servers','https://attacker.example/api/logs','//attacker.example/api/logs','/api/auth/status']:
            with self.subTest(path=path),self.assertRaises(ValueError):remote(server,{'kind':'http','method':'GET','path':path})

    def test_signed_central_deployment_correct_service_and_remote_dedup(self):
        server=self.primary.server(self.node['id'])
        value={'kind':'http','method':'POST','path':'/api/manage/services/service/action','body':{'action':'update'},'delivery':'unique-delivery','repository':'owner/repo','branch':'main'}
        first=remote(server,value);second=remote(server,value)
        self.assertEqual(first['status'],202);self.assertEqual(first,second)
        self.assertEqual((self.root/'operations.jsonl').read_text().count('"op": "services.action"'),1)
        bad={**value,'delivery':'bad-delivery','repository':'other/repo'}
        with self.assertRaises(ValueError):remote(server,bad)

    def test_replacement_credentials_are_csrf_protected_and_verified(self):
        path='/api/servers/'+self.node['id']+'/credentials'
        body={'id':self.node['id'],'name':'Remote updated','domain':self.origin,'secret':secrets.token_hex(32)}
        before=self.primary.server(self.node['id'])
        self.assertEqual(self.client.post(path,json=body).status_code,403)
        token=self.client.get('/api/settings').json['csrf_token']
        headers={'X-CSRF-Token':token}
        self.assertEqual(self.client.post(path,json=body,headers=headers).status_code,400)
        self.assertEqual(self.primary.server(self.node['id']),before)
        with self.global_store.db() as db:db.execute('UPDATE node SET secret=?',(body['secret'],))
        self.primary.connection(self.node['id'],'disconnect')
        response=self.client.post(path,json=body,headers=headers)
        self.assertEqual(response.status_code,200,response.json)
        self.assertFalse(self.primary.server(self.node['id'])['connected'])
        self.assertNotIn(body['secret'],response.get_data(as_text=True))
        self.assertNotIn(body['secret'],self.client.get('/api/servers').get_data(as_text=True))
        self.primary.connection(self.node['id'],'reconnect')
        self.assertEqual(self.client.get('/api/manage/services',headers=self.remote_headers).status_code,200)
        self.assertEqual(self.local_calls,[])

    def test_changed_identity_stale_target_fails_closed(self):
        sid=secrets.token_hex(16);key=secrets.token_hex(32)
        with self.global_store.db() as db:db.execute('UPDATE node SET id=?,secret=?',(sid,key))
        token=self.client.get('/api/settings').json['csrf_token']
        response=self.client.post('/api/servers/'+self.node['id']+'/credentials',json={
            'id':sid,'name':'Replacement','domain':self.origin,'secret':key},headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(self.client.get('/api/manage/services',headers=self.remote_headers).status_code,503)
        self.assertEqual(self.client.get('/api/manage/services',headers={**self.remote_headers,'X-ATS-Target':sid}).status_code,200)
        self.assertEqual(self.local_calls,[])

    def test_pairing_rejects_non_object_json_without_500(self):
        token=self.client.get('/api/settings').json['csrf_token']
        for value in [[],['x'],'x',None]:
            response=self.client.post('/api/servers',json=value,headers={'X-CSRF-Token':token})
            self.assertEqual(response.status_code,400)

    def test_automatic_setup_checks_real_signed_loopback_and_public_adapter_reads(self):
        import ats_global_setup
        plain=ats_remote.Server(('127.0.0.1',0),self.global_store)
        threading.Thread(target=plain.serve_forever,daemon=True).start()
        self.addCleanup(plain.server_close);self.addCleanup(plain.shutdown)
        plan={'node':dict(self.node,domain=self.origin),'port':plain.server_port}
        for public in (False,True):
            ats_global_setup.verify_health(plan,public=public)
            ats_global_setup.verify_health(plan,public=public,management=True)
        self.assertEqual(self.local_calls,[])

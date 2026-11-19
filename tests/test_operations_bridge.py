"""Validation, CSRF, dispatch and detached-job coverage for Operations routes."""
from unittest import mock
from test_manage_api import Base, H
import manage_api


class OperationsBridge(Base):
    def test_reads_and_config_dispatch(self):
        self.assertEqual(self.c.get('/api/manage/operations').status_code, 200)
        self.assertEqual(self.c.get('/api/manage/services/alpha/operations').status_code, 200)
        result = self.c.put('/api/manage/services/alpha/operations', json={'health_enabled': True, 'health_path': '/health', 'interval_hours': 2}, headers=H)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.calls()[-1]['argv'], ['--api', 'operations.set'])

    def test_invalid_and_unconfirmed_writes_never_dispatch(self):
        path = '/api/manage/services/alpha'
        for body in ({'health_enabled':'yes'}, {'retain_count':0}, {'timeout_seconds':True}, {'unknown':1}):
            self.assertEqual(self.c.put(path+'/operations', json=body, headers=H).status_code, 400)
        for body in ({'deployment_id':1}, {'deployment_id':1,'confirm':'beta'}, {'deployment_id':True,'confirm':'alpha'}):
            self.assertEqual(self.c.post(path+'/rollback', json=body, headers=H).status_code, 400)
        for method, url, body in [('put',path+'/operations',{}), ('post',path+'/rollback',{'deployment_id':1,'confirm':'alpha'}), ('post','/api/manage/alerts/1/ack',{}), ('post','/api/manage/backups/verify',{'name':'alpha','id':1})]:
            self.assertEqual(getattr(self.c, method)(url,json=body).status_code,403)
        self.assertEqual(self.calls(), [])

    def test_ack_and_long_jobs(self):
        self.assertEqual(self.c.post('/api/manage/alerts/1/ack',json={},headers=H).status_code,200)
        self.assertEqual(self.calls()[-1]['argv'], ['--api','alerts.ack'])
        for url, body, op in [('/api/manage/services/alpha/rollback', {'deployment_id':1,'confirm':'alpha'}, 'deployments.rollback'), ('/api/manage/backups/verify', {'name':'alpha','id':1}, 'backups.verify')]:
            with mock.patch.dict('os.environ', {'STUB_MODE':'job'}):
                result=self.c.post(url,json=body,headers=H)
            self.assertEqual(result.status_code,202)
            job=self.wait_job(self.j(result)['data']['job_id'])
            self.assertEqual(job['op'],op)
            self.assertEqual(job['status'],'done')

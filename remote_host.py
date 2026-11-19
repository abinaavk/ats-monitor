"""Private stdin adapter invoked only by the authenticated ATS Global API.

No network listener, session or credential bypass is exposed by this executable.
The allowlist excludes authentication, device settings, registry, and arbitrary URLs.
"""
import json
import os
import re
import sys
from urllib.parse import urlsplit
import cluster_support


def allowed(path):
    return (path in ('/api/overview', '/api/logs', '/api/database', '/api/stats', '/api/audit') or
            path.startswith('/api/manage/') or path.startswith('/api/docker/'))


def dispatch(value):
    path = value.get('path', '')
    method = value.get('method')
    u = urlsplit(path)
    if u.scheme or u.netloc or u.fragment or not allowed(u.path) or method not in ('GET','POST','PUT','PATCH','DELETE'):
        raise ValueError('Unsupported remote route')
    import app as host
    with host.app.test_request_context(path, method=method, json=value.get('body'),
                                       headers={'X-Requested-With':'ats-monitor'}):
        adapter = host.app.url_map.bind('localhost')
        endpoint, arguments = adapter.match(u.path, method=method)
        if endpoint.startswith(('security.', 'cluster.')):
            raise ValueError('Forbidden remote route')
        if value.get('delivery'):
            # Remote delivery replay protection persists independently of Local state.
            if method != 'POST' or not re.fullmatch(r'/api/manage/services/[A-Za-z0-9_-]{1,64}/action', u.path) or value.get('body') != {'action':'update'}:
                raise ValueError('Invalid deployment request')
            store = cluster_support.Store()
            name = arguments['name']
            service = host.manage_api.ats_call('services.get', {'name':name})
            repo = service.get('repo_url', '').removesuffix('.git')
            normalized = repo.replace('git@github.com:', 'https://github.com/').removeprefix('https://github.com/')
            if normalized.lower() != value.get('repository','').lower() or service.get('branch') != value.get('branch') or not service.get('auto_update', True):
                raise ValueError('Deployment mapping does not match Global service')
            with store.db() as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT result FROM seen WHERE scope=\'deployment\' AND nonce=?', (value['delivery'],)).fetchone()
                if row:
                    return json.loads(row['result']) if row['result'] else {'status':409, 'body':{'error':'Delivery outcome unknown; inspect Global jobs'}}
                db.execute('INSERT INTO seen VALUES(?,?,0,\'running\',NULL)', ('deployment', value['delivery']))
        # Route validators remain in use; browser authentication is deliberately outside
        # this private subprocess and is enforced at the signed HTTPS boundary.
        for guard in host.app.before_request_funcs.get(endpoint.split('.')[0], []):
            error = guard()
            if error:
                response = host.app.make_response(error)
                return {'status':response.status_code, 'body':response.get_json()}
        try:
            response = host.app.make_response(host.app.view_functions[endpoint](**arguments))
        except Exception as error:
            response = host.app.handle_user_exception(error)
        if not response.is_json:
            raise ValueError('Only JSON remote routes are supported')
        result = {'status':response.status_code, 'body':response.get_json()}
        if value.get('delivery'):
            with store.db() as db:
                db.execute('UPDATE seen SET state=\'done\',result=? WHERE scope=\'deployment\' AND nonce=?', (json.dumps(result),value['delivery']))
        return result


if __name__ == '__main__':
    result_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    try:
        raw = sys.stdin.buffer.read(cluster_support.MAX_BODY+1)
        if len(raw)>cluster_support.MAX_BODY:
            raise ValueError('Request too large')
        result = dispatch(json.loads(raw))
        with os.fdopen(result_fd, 'w') as output:
            output.write(json.dumps(result))
    except Exception:
        sys.exit(1)

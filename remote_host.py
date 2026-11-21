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
            returned = host.app.view_functions[endpoint](**arguments)
        except Exception as error:
            try:
                # A blueprint error handler returns a (body, status) tuple, not a Response.
                returned = host.app.handle_user_exception(error)
            except Exception:
                returned = ({'ok': False, 'error': 'Operation failed on this server'}, 500)
        response = host.app.make_response(returned)
        if not response.is_json:
            raise ValueError('Only JSON remote routes are supported')
        result = {'status':response.status_code, 'body':response.get_json()}
        if value.get('delivery'):
            with store.db() as db:
                db.execute('UPDATE seen SET state=\'done\',result=? WHERE scope=\'deployment\' AND nonce=?', (json.dumps(result),value['delivery']))
        return result


def check():
    """Self-test the adapter exactly as the Global daemon runs it; print one JSON report.

    Messages here are written by this program and name only modules, paths and
    settings. They never include a key, a signature or a remote response.
    """
    problems, notes = [], []
    try:
        import flask  # noqa: F401
    except ImportError:
        problems.append(f"Python module 'flask' is missing for {sys.executable}; install it "
                        "(apt-get install python3-flask, or pip install -r requirements-adapter.txt)")
    else:
        try:
            import psutil  # noqa: F401
        except ImportError:
            notes.append("optional module 'psutil' is not installed; host metrics will be limited")
    if not problems:
        try:
            import app as host
        except ImportError as exc:
            missing = getattr(exc, 'name', None) or 'unknown'
            problems.append(f"Monitor could not start: Python module '{missing}' is missing for {sys.executable}")
        except Exception as exc:
            problems.append(f'Monitor could not start: {type(exc).__name__} while importing app.py; check ATS_SECURITY_DB and ATS_MODULE_DIR')
        else:
            try:
                host.manage_api.jobs_dir()
            except Exception as exc:
                problems.append('ATS_MONITOR_JOBS_DIR is not usable: ' + str(getattr(exc, 'error', None) or type(exc).__name__)[:160])
            try:
                host.manage_api.ats_call('services.list', {}, timeout=40)
            except Exception as exc:
                problems.append('The ATS CLI could not list services (check ATS_CLI, ATS_CONFIG_FILE and ATS_HOME): '
                                + str(getattr(exc, 'error', None) or type(exc).__name__)[:160])
    return {'ok': not problems, 'python': sys.executable, 'problems': problems, 'notes': notes}


if __name__ == '__main__':
    # Only this subprocess is headless; importing remote_host elsewhere changes nothing.
    os.environ['ATS_MONITOR_HEADLESS'] = '1'
    result_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    if sys.argv[1:] == ['--check']:
        report = check()
        with os.fdopen(result_fd, 'w') as output:
            output.write(json.dumps(report))
        sys.exit(0 if report['ok'] else 2)
    try:
        raw = sys.stdin.buffer.read(cluster_support.MAX_BODY+1)
        if len(raw)>cluster_support.MAX_BODY:
            raise ValueError('Request too large')
        result = dispatch(json.loads(raw))
        with os.fdopen(result_fd, 'w') as output:
            output.write(json.dumps(result))
    except Exception as exc:
        # One safe line for the Global's diagnostics: never the message of an arbitrary error.
        name = getattr(exc, 'name', None)
        detail = f": No module named '{name}'" if isinstance(exc, ImportError) and isinstance(name, str) else ''
        sys.stderr.write(f'adapter-error: {type(exc).__name__}{detail}\n')
        sys.exit(1)

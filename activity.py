"""Audit trail of administrative actions: which device did what, on which server, and when.

Entries are written to the same ``security_audit`` table as sign-ins. The text recorded is only the action,
the server's name and the name of the thing acted on (service, package, hostname). Terminal keystrokes and
output, file contents, environment values, secrets and request bodies are never recorded.
"""
import re

import security

NAME = r'([A-Za-z0-9_-]{1,64})'
ACTIONS = {'start', 'stop', 'restart', 'update', 'rebuild', 'reinstall_deps'}

# (method, path pattern, action, how to name the target: 'path' group 1, 'body:<field>' or None)
RULES = [
    ('POST', r'/api/manage/services', 'service_deployed', 'body:name'),
    ('PATCH', rf'/api/manage/services/{NAME}', 'service_edited', 'path'),
    ('DELETE', rf'/api/manage/services/{NAME}', 'service_deleted', 'path'),
    ('POST', rf'/api/manage/services/{NAME}/redeploy', 'service_redeployed', 'path'),
    ('POST', rf'/api/manage/services/{NAME}/rollback', 'service_rolled_back', 'path'),
    ('POST', rf'/api/manage/services/{NAME}/webhook', 'service_webhook_secret_changed', 'path'),
    ('POST', rf'/api/manage/services/{NAME}/webhook/test', 'service_webhook_tested', 'path'),
    ('POST', r'/api/manage/backups', 'service_backup_created', 'body:name'),
    ('POST', r'/api/manage/backups/restore', 'service_backup_restored', 'body:name'),
    ('DELETE', r'/api/manage/backups', 'service_backup_deleted', 'body:name'),
    ('PUT', r'/api/manage/cloudflare/config', 'tunnel_config_edited', None),
    ('POST', r'/api/manage/cloudflare/restore', 'tunnel_config_restored', 'body:name'),
    ('POST', r'/api/manage/cloudflare/sync', 'tunnel_routes_synced', None),
    ('POST', r'/api/manage/cloudflare/restart', 'tunnel_restarted', None),
    ('POST', r'/api/manage/dependencies/install', 'package_installed', 'body:name'),
    ('PUT', r'/api/manage/settings', 'server_settings_changed', None),
]
COMPILED = [(m, re.compile(p + r'\Z'), a, t) for m, p, a, t in RULES]
SAFE_VALUE = re.compile(r'[A-Za-z0-9._@:/ -]{1,120}\Z')


def server_label(sid):
    """The paired server's name for a target ID (the Local itself when there is no target)."""
    from cluster_support import registry
    import servers_api
    try:
        store = registry(servers_api.Store)
        if store is None:
            return 'this server'
        server = store.server(sid)
        return server['name'] + (' (this server)' if server['local'] else '')
    except Exception:
        return 'unknown server'


def classify(method, path, body, action_hint=None):
    """(action, thing) for a request worth recording, or None. ``thing`` is a bare name or None."""
    for rule_method, pattern, action, target in COMPILED:
        if method != rule_method:
            continue
        found = pattern.match(path)
        if not found:
            continue
        thing = None
        if target == 'path':
            thing = found.group(1)
        elif target and target.startswith('body:') and isinstance(body, dict):
            value = body.get(target[5:])
            thing = value if isinstance(value, str) and SAFE_VALUE.fullmatch(value) else None
        return action, thing
    found = re.fullmatch(rf'/api/manage/services/{NAME}/action', path)
    if method == 'POST' and found and isinstance(body, dict) and body.get('action') in ACTIONS:
        return 'service_' + body['action'], found.group(1)
    return None


def describe(server, thing=None, status=None):
    text = server + (f' · {thing}' if thing else '')
    return text + (f' · failed (HTTP {status})' if status and status >= 400 else '')


def install(app):
    from flask import g, request

    @app.after_request
    def record_remote_actions(response):
        if request.method == 'GET' or not getattr(g, 'auth', None) or response.status_code in (401, 403):
            return response
        hit = classify(request.method, request.path, request.get_json(silent=True))
        if hit:
            action, thing = hit
            security.record(action, describe(server_label(request.headers.get('X-ATS-Target')), thing, response.status_code))
        return response

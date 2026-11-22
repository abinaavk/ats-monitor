"""Fleet operations on the primary Local: overview, updates, key rotation, pairing codes, webhook mappings,
alert channels and registry backups. Every route is Local-only, needs the anti-CSRF token for changes, and
never returns a key, token or webhook secret (a new mapping's secret is returned once, on creation).
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request

from flask import Blueprint, current_app, jsonify, request

import activity
import security
import servers_api
from cluster_support import TransportError, registry, remote

bp = Blueprint('fleet', __name__)
REFRESH_GAP = 5
_refresh = {'at': 0.0, 'lock': threading.Lock()}
REPO = re.compile(r'[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z')
SERVICE = re.compile(r'[A-Za-z0-9_-]{1,64}\Z')
BRANCH = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,99}\Z')


class Unavailable(Exception):
    """This Local's ATS is too old (or not set up) for the requested feature."""


def local():
    """(store, node) for a configured primary Local, or raise."""
    try:
        store = registry(servers_api.Store)
        node = store.node() if store else None
    except (OSError, sqlite3.Error):
        raise Unavailable('The server registry is not readable; check the operator setup.')
    if not node or node['role'] != 'local':
        raise Unavailable('Configure the primary Local with "server configure" first.')
    return store, node


def ats(*names):
    """Import optional ATS modules; an older ATS on this Local gets a message that says what to do."""
    try:
        return [__import__(name) for name in names] if len(names) > 1 else __import__(names[0])
    except ImportError:
        raise Unavailable('Update ATS on this Local server (git pull, then restart ATS) to use this feature.')


def offload(function, *args, **kwargs):
    try:
        from gevent import get_hub
    except ImportError:
        return function(*args, **kwargs)

    def run():
        # Carry an expected failure back to the caller instead of letting the thread pool print it as a crash.
        try:
            return True, function(*args, **kwargs)
        except Exception as exc:
            return False, exc
    ok, value = get_hub().threadpool.apply(run)
    if not ok:
        raise value
    return value


def guarded(handler):
    """Wrap a route: CSRF for changes, Local-only, and operator-readable failures."""
    def wrapper(*args, **kwargs):
        if request.method != 'GET':
            error = servers_api.guard()
            if error:
                return error
        try:
            return handler(*args, **kwargs)
        except Unavailable as exc:
            return jsonify(error=str(exc)), 503
        except (ValueError, OSError, sqlite3.Error) as exc:
            reason, code = servers_api.explain(exc, 'The operation could not be completed.', handler.__name__)
            return jsonify(error=reason, code=code), 400
    wrapper.__name__ = handler.__name__
    return wrapper


def body():
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value


# ── overview ────────────────────────────────────────────────────────────────
@bp.get('/api/fleet')
@guarded
def overview():
    store, node = local()
    status = ats('ats_status')
    mine = status.repo_info(Path(status.__file__).resolve().parent)
    state = store.kv_get('fleet_state', {})
    now = time.time()
    servers = []
    for summary in store.servers():
        entry = state.get(summary['id']) or {}
        metrics = entry.get('metrics') or {}
        known = bool(metrics.get('ats'))
        servers.append({'id': summary['id'], 'name': summary['name'], 'local': bool(summary['local']), 'domain': summary['domain'],
                        'status': entry.get('status', 'unknown'), 'since': entry.get('since'), 'error': entry.get('error'),
                        'last_ok': entry.get('last_ok'), 'metrics': metrics or None, 'legacy': bool(metrics.get('legacy')),
                        'outdated': bool(known and mine.get('short') and metrics['ats'] != mine['short'] and not summary['local']),
                        'updatable': bool(not summary['local'] and summary['connected'] and summary['paired'])})
    last = max((s['metrics']['at'] for s in servers if s['metrics']), default=None)
    return jsonify(servers=servers, events=list(reversed(store.kv_get('fleet_events', [])[-30:])),
                   current={'short': mine.get('short'), 'subject': mine.get('subject')},
                   watcher={'last_run': last, 'stale': last is None or now - last > 180, 'interval': 60})


@bp.post('/api/fleet/refresh')
@guarded
def refresh():
    store, _ = local()
    fleet = ats('ats_fleet')
    with _refresh['lock']:
        wait = REFRESH_GAP - (time.time() - _refresh['at'])
        if wait > 0:
            return jsonify(error=f'Just refreshed; wait {int(wait) + 1} seconds.'), 429
        _refresh['at'] = time.time()
    found = offload(fleet.snapshot, store)
    return jsonify(ok=True, servers=found)


# ── updates and key rotation ─────────────────────────────────────────────────
@bp.post('/api/servers/<sid>/update')
@guarded
def update_global(sid):
    store, _ = local()
    value = request.get_json(silent=True) or {}
    targets = value.get('targets', 'both')
    if targets not in ('ats', 'companion', 'both'):
        raise ValueError('Choose ats, companion or both')
    server = store.server(sid)
    if server['local']:
        raise ValueError('Update this Local server with git pull and a restart; Monitor cannot restart itself.')
    try:
        result = remote(server, {'kind': 'update', 'targets': targets, 'restart': True}, timeout=100)
    except TransportError as exc:
        if exc.code == 'adapter' and 'Unsupported request kind' in str(exc):
            raise ValueError('That Global runs an older ATS that cannot update itself. Update it once by hand (git pull and restart ATS); after that this button works.')
        raise
    changed = [name for name in ('ats', 'companion') if (result.get(name) or {}).get('changed')]
    security.record('server_updated', activity.describe(server['name'], ', '.join(changed) or 'already current'))
    return jsonify(ok=True, result=result)


@bp.post('/api/servers/<sid>/rotate')
@guarded
def rotate(sid):
    store, _ = local()
    result = store.rotate_global(sid)
    security.record('server_key_rotated', activity.describe(store.server(sid)['name']))
    return jsonify(ok=True, grace_seconds=result['grace_seconds'])


@bp.post('/api/servers/pair-code')
@guarded
def pair_with_code():
    store, _ = local()
    value = body()
    store.pair_by_code(value.get('domain'), value.get('code'), value.get('name') or None)
    security.record('server_paired_with_code', activity.describe(str(value.get('name') or value.get('domain'))[:100]))
    return jsonify(ok=True)


# ── webhook mappings ────────────────────────────────────────────────────────
def mapping_row(store, repository):
    with store.db() as db:
        row = db.execute('SELECT * FROM routes WHERE repository=? COLLATE NOCASE', (repository,)).fetchone()
    if not row:
        raise ValueError('No such mapping')
    return dict(row)


@bp.post('/api/servers/<sid>/mappings')
@guarded
def create_mapping(sid):
    store, node = local()
    value = body()
    repository, service, branch = value.get('repository'), value.get('service'), value.get('branch') or 'main'
    if not isinstance(repository, str) or not REPO.fullmatch(repository.strip()):
        raise ValueError('Enter the repository as owner/name, for example abinaavk/site')
    if not isinstance(service, str) or not SERVICE.fullmatch(service):
        raise ValueError('Enter the service name exactly as it appears on that server')
    if not isinstance(branch, str) or not BRANCH.fullmatch(branch) or '..' in branch:
        raise ValueError('That branch name is not valid')
    secret = secrets.token_hex(32)
    store.mapping(repository.strip(), sid, service, branch, secret)
    server = store.server(sid)
    security.record('webhook_mapping_created', activity.describe(server['name'], f'{repository.strip().lower()} → {service}'))
    host = node.get('webhook')
    return jsonify(ok=True, repository=repository.strip().lower(), secret=secret,
                   payload_url=f'https://{host}/webhook' if host else None, content_type='application/json',
                   events='Just the push event')


@bp.delete('/api/mappings/<owner>/<name>')
@guarded
def delete_mapping(owner, name):
    store, _ = local()
    repository = f'{owner}/{name}'
    row = mapping_row(store, repository)
    store.unmap(repository)
    security.record('webhook_mapping_deleted', activity.describe(store.server(row['server_id'])['name'], f"{row['repository']} → {row['service']}"))
    return jsonify(ok=True)


def deliver(url, headers, payload, timeout=10):
    """POST a signed test event to this Local's public webhook address. Redirects are never followed."""
    class Stop(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request_ = urllib.request.Request(url, data=payload, headers=headers, method='POST')
    try:
        with urllib.request.build_opener(Stop).open(request_, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


@bp.post('/api/mappings/<owner>/<name>/test')
@guarded
def test_mapping(owner, name):
    """Send a signed GitHub 'ping' through the same checks as a real delivery. It never deploys anything."""
    store, node = local()
    routing = ats('ats_routing')
    row = mapping_row(store, f'{owner}/{name}')
    steps = []

    def step(label, action):
        started = time.monotonic()
        try:
            detail = action() or ''
            ok = True
        except (ValueError, OSError, PermissionError, ConnectionError, sqlite3.Error, TransportError) as exc:
            ok, detail = False, servers_api.explain(exc, 'The check could not be completed.', 'mapping test ' + label)[0]
        steps.append({'name': label, 'ok': ok, 'ms': int((time.monotonic() - started) * 1000), 'detail': detail})
        return ok

    payload = json.dumps({'zen': 'ATS test delivery', 'hook_id': 0, 'repository': {'full_name': row['repository']}}).encode()
    signature = 'sha256=' + hmac.new(row['secret'].encode(), payload, hashlib.sha256).hexdigest()
    headers = {'X-Hub-Signature-256': signature, 'X-GitHub-Event': 'ping', 'X-GitHub-Delivery': 'ats-test-' + secrets.token_hex(8),
               'Content-Type': 'application/json', 'User-Agent': 'ATS-Monitor-Test/1'}

    def accepted():
        routing.route(store, '/webhook', {k.lower(): v for k, v in headers.items()}, payload)
        return 'The signature, repository and destination all match the mapping.'

    def public():
        if not node.get('webhook'):
            raise ValueError('This Local has no webhook host configured.')
        status = offload(deliver, f"https://{node['webhook']}/webhook", headers, payload)
        if status != 200:
            raise ValueError(f"https://{node['webhook']}/webhook answered HTTP {status}; GitHub's deliveries would fail the same way. "
                             'Check the tunnel route for the webhook host and that ATS is running.')
        return f"https://{node['webhook']}/webhook answered 200."

    def reachable():
        server = store.server(row['server_id'])
        if not server['connected']:
            raise ValueError('That server is disconnected in Monitor; reconnect it first.')
        remote(server, {'kind': 'health'})

    def service_exists():
        result = remote(store.server(row['server_id']), {'kind': 'http', 'method': 'GET', 'path': '/api/manage/services/' + row['service']})
        if result.get('status') == 404:
            raise ValueError(f"That server has no service named “{row['service']}”. Deliveries would be accepted and then fail.")
        if result.get('status') != 200:
            raise ValueError(f"The server answered HTTP {result.get('status')} when asked for that service.")

    if step('Mapping and signature', accepted):
        step('Public webhook address', public)
    if step('Destination server reachable', reachable):
        step('Service exists there', service_exists)
    security.record('webhook_mapping_tested', activity.describe(store.server(row['server_id'])['name'], f"{row['repository']} → {row['service']}"))
    return jsonify(ok=all(item['ok'] for item in steps), steps=steps)


# ── alert channels ──────────────────────────────────────────────────────────
@bp.get('/api/alerts')
@guarded
def alerts_get():
    store, _ = local()
    notify = ats('ats_notify')
    return jsonify(config=notify.mask(notify.load(store)), last=store.kv_get('fleet_notify'))


@bp.put('/api/alerts')
@guarded
def alerts_put():
    store, _ = local()
    notify = ats('ats_notify')
    saved = notify.save(store, body())
    security.record('alerts_changed', 'on for ' + (', '.join(k for k, v in saved['enabled'].items() if v) or 'no channel'))
    return jsonify(ok=True, config=saved)


@bp.post('/api/alerts/test')
@guarded
def alerts_test():
    store, _ = local()
    notify = ats('ats_notify')
    channel = body().get('channel')
    config = notify.load(store)
    if channel not in config['enabled']:
        raise ValueError('Choose ntfy, telegram or webhook')
    config['enabled'] = {key: key == channel for key in config['enabled']}
    try:
        notify.validate(config)
    except ValueError as exc:
        raise ValueError(f'Save the {channel} settings first: {exc}')
    outcome = offload(notify.send, config, 'ATS test alert', 'If you can read this, alerts from ATS reach you.', 'info')
    security.record('alert_tested', channel)
    return jsonify(ok=all(v['ok'] for v in outcome.values()), outcome=outcome)


# ── registry backups ────────────────────────────────────────────────────────
@bp.get('/api/registry-backup')
@guarded
def backup_status():
    store, _ = local()
    backups = ats('ats_registry_backup')
    offsite = backups.offsite_status(store) if hasattr(backups, 'offsite_status') else {}
    destinations = [x['name'] for x in store.servers() if not x['local'] and x['paired'] and x['connected']]
    return jsonify(status=backups.status(store), items=backups.listing(store)[:10], directory=str(backups.directory(store, False)),
                   offsite=list(offsite.values()), destinations=destinations,
                   passphrase_configured=bool(os.environ.get('ATS_REGISTRY_BACKUP_PASSPHRASE_FILE')))


@bp.post('/api/registry-backup')
@guarded
def backup_now():
    store, _ = local()
    backups = ats('ats_registry_backup')
    passphrase = (request.get_json(silent=True) or {}).get('passphrase') or None
    if passphrase is not None and (not isinstance(passphrase, str) or len(passphrase) < 8):
        raise ValueError('The passphrase must be at least 8 characters')
    made = offload(backups.create, store, None, passphrase)
    backups.prune(store)
    store.kv_set('registry_backup', {'at': made['at'], 'path': made['path'], 'size': made['size'], 'encrypted': made['encrypted'], 'error': None})
    security.record('registry_backup_created', 'encrypted' if made['encrypted'] else 'not encrypted')
    return jsonify(ok=True, name=made['path'].rsplit('/', 1)[-1], size=made['size'], encrypted=made['encrypted'])


@bp.post('/api/registry-backup/offsite')
@guarded
def backup_offsite():
    """Send an encrypted copy to every connected Global now. Unencrypted data never leaves this server."""
    store, _ = local()
    backups = ats('ats_registry_backup')
    if not hasattr(backups, 'push_offsite'):
        raise Unavailable('Update ATS on this Local server (git pull, then restart ATS) to use this feature.')
    passphrase = (request.get_json(silent=True) or {}).get('passphrase') or None
    if passphrase is not None and (not isinstance(passphrase, str) or len(passphrase) < 8):
        raise ValueError('The passphrase must be at least 8 characters')
    results = offload(backups.push_offsite, store, passphrase)
    sent = [r['server'] for r in results.values() if r['ok']]
    security.record('registry_backup_sent_offsite', 'to ' + (', '.join(sent) if sent else 'no server (all failed)'))
    return jsonify(ok=all(r['ok'] for r in results.values()), results=[{'server': r['server'], 'ok': r['ok'], 'error': r.get('error'), 'at': r['at']} for r in results.values()])


def initialize(app):
    app.register_blueprint(bp)

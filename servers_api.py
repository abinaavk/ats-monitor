"""Primary-only server registry and explicit selected-target routing."""
import hmac
import json
import sqlite3
from flask import Blueprint, current_app, g, jsonify, request
import security
from cluster_support import Store, remote, MAX_BODY, registry, TransportError

bp = Blueprint('cluster', __name__)


def explain(exc, fallback, where=''):
    """The operator-facing reason for a failure, and a server-side log line without secrets.

    ATS validators and the signed transport write their own messages and never put a
    key, signature or remote response in them, so those are shown. Anything else
    (file, database or library errors) is logged by type only and replaced by `fallback`.
    """
    code = getattr(exc, 'code', None) if isinstance(exc, TransportError) else None
    if isinstance(exc, sqlite3.IntegrityError):
        text = str(exc)
        reason = ('Another server already uses this name.' if 'servers.name' in text else
                  'Another server already uses this HTTPS address.' if 'servers.domain' in text else None)
    elif isinstance(exc, ValueError) and str(exc):
        reason = str(exc)[:300]
    else:
        reason = None
    current_app.logger.warning('servers_api %s failed: %s%s', where or request.endpoint,
                               reason or type(exc).__name__, f' [{code}]' if code else '')
    return (reason or fallback), code


def initialize(app):
    app.register_blueprint(bp)

    @app.before_request
    def selected_target():
        # security.init_app's authentication hook was registered first.
        if not getattr(g, 'auth', None) or not request.path.startswith('/api/'):
            return
        from remote_host import allowed
        if not allowed(request.path):
            return
        try:
            # Read-only discovery must not create a registry for legacy installations.
            store = registry(Store)
            node = store.node() if store else None
            sid = request.headers.get('X-ATS-Target')
            # Legacy local clients work only until an operator enables the registry.
            if not node:
                if sid:
                    raise ValueError('Server registry has not been configured')
                return
            server = store.server(sid)
            if request.method != 'GET':
                if request.headers.get('X-Requested-With') != 'ats-monitor' or not security.same_origin():
                    return jsonify(error='Cross-origin operation rejected'),403
            if request.content_length and request.content_length > MAX_BODY:
                return jsonify(error='Request body too large'),413
            if server['local']:
                return
            result = remote(server, {'kind':'http', 'method':request.method,
                'path':request.full_path.rstrip('?'), 'body':request.get_json(silent=True)})
            return jsonify(result['body']),result['status']
        except (ValueError, OSError, sqlite3.Error) as exc:
            reason, code = explain(exc, 'Selected server is unavailable or invalid.', 'selected target')
            return jsonify(ok=False, error=reason + ' No operation was sent to Local.', code=code),503


@bp.route('/api/servers', methods=['GET','POST'])
def servers():
    try:
        store = registry(Store)
        node = store.node() if store else None
    except (OSError,sqlite3.Error):
        return jsonify(error='Server registry is not readable; check operator setup'),503
    if not node or node['role'] != 'local':
        return jsonify(error='Configure the primary Local with ATS server configure first'),503
    if request.method == 'GET':
        return jsonify(servers=store.servers(), primary_id=node['id'])
    error = guard()
    if error:
        return error
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        return jsonify(error='Expected a pairing object'),400
    try:
        store.pair(value.get('id'), value.get('name'), value.get('domain'), value.get('secret'))
        return jsonify(ok=True)
    except (ValueError, OSError, sqlite3.Error) as exc:
        reason, code = explain(exc, 'Check identity, HTTPS domain, credentials and duplicate names/domains.', 'pair')
        return jsonify(error='Pairing failed: ' + reason, code=code),400


def guard():
    token = security.digest('csrf:'+getattr(g,'auth_token',''))
    if not security.same_origin() or not hmac.compare_digest(request.headers.get('X-CSRF-Token',''), token):
        return jsonify(error='Security token invalid; refresh and retry'),403
    if request.content_length and request.content_length>MAX_BODY:
        return jsonify(error='Request too large'),413


@bp.patch('/api/servers/<sid>')
def update_server(sid):
    error = guard()
    if error:
        return error
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        return jsonify(error='Expected server name and HTTPS API origin'),400
    try:
        Store().update_server(sid, value.get('name'), value.get('domain'))
        return jsonify(ok=True)
    except (ValueError, OSError, sqlite3.Error) as exc:
        reason, code = explain(exc, 'Check the name, HTTPS origin and Global connectivity.', 'update')
        return jsonify(error='Server update failed: ' + reason + ' Existing settings were preserved.', code=code),400


@bp.post('/api/servers/<sid>/credentials')
def replace_credentials(sid):
    error = guard()
    if error:
        return error
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        return jsonify(error='Expected server ID, name, HTTPS origin and pairing secret'),400
    try:
        store = registry(Store)
        if not store or not hasattr(store, 'replace_credentials'):
            return jsonify(error='Update ATS on Local before replacing credentials'),503
        store.replace_credentials(sid, value.get('id'), value.get('name'),
                                  value.get('domain'), value.get('secret'))
        return jsonify(ok=True, server_id=value['id'])
    except (ValueError, OSError, sqlite3.Error, KeyError) as exc:
        reason, code = explain(exc, 'Verify the new Global ID, key and HTTPS origin.', 'replace credentials')
        return jsonify(error='Credential update failed: ' + reason + ' Existing pairing and routes were preserved.', code=code),400


@bp.post('/api/servers/<sid>/<action>')
def connection(sid, action):
    error = guard()
    if error:
        return error
    try:
        Store().connection(sid,action)
        return jsonify(ok=True)
    except (ValueError,OSError,sqlite3.Error) as exc:
        messages = {'disconnect': 'Disconnect failed. Check the Local registry permissions and server identity.',
                    'reconnect': 'Reconnect failed. Check that the Global daemon, HTTPS tunnel and pairing credentials are valid.',
                    'revoke': 'Revocation could not be confirmed. Keep this server disconnected and rotate credentials on Global before pairing again.'}
        reason, code = explain(exc, '', action)
        base = messages.get(action, 'Invalid connection action')
        return jsonify(error=base + (' Reason: ' + reason if reason else ''), code=code),400


@bp.get('/api/servers/<sid>/health')
def health(sid):
    try:
        server=Store().server(sid)
        result = {'management_ready': True}
        if not server['local']:
            result = remote(server,{'kind':'health'})
        return jsonify(status='online',server_id=sid,management_ready=result.get('management_ready'))
    except (ValueError,OSError,sqlite3.Error) as exc:
        reason, code = explain(exc, 'Check the Global daemon and HTTPS tunnel.', 'health')
        return jsonify(status='offline',server_id=sid,error=reason,code=code),503

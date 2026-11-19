"""Docker management API for ATS Monitor.

Thin wrapper around the `docker` CLI (no extra Python dependencies). Everything
is registered behind the app-wide auth check in app.py. State-changing requests
must also send the `X-Requested-With: ats-monitor` header, which a cross-site
form post cannot do, so a logged-in browser cannot be driven from another site.

All commands are run as argument lists (never through a shell) and every
user-supplied identifier is validated against a strict pattern that cannot
start with '-', so it cannot be read as a docker flag.
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import subprocess
import termios
import threading

from flask import Blueprint, jsonify, request, session
import security

DOCKER_BIN = os.environ.get('DOCKER_BIN', 'docker')

bp = Blueprint('docker_api', __name__, url_prefix='/api/docker')

# container / image / volume / network reference: name, short or full id, repo:tag, repo@sha256:...
REF_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@/\-]{0,254}$')
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$')
PORT_RE = re.compile(r'^(?:(?:\d{1,3}\.){3}\d{1,3}:)?\d{1,5}(?:-\d{1,5})?:\d{1,5}(?:-\d{1,5})?(?:/(?:tcp|udp))?$')
ENV_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*=[^\x00\r\n]*$')
VOL_RE = re.compile(r'^[A-Za-z0-9_.\-/]+:/[A-Za-z0-9_.\-/]*(?::(?:ro|rw))?$')
RESTART_POLICIES = ('no', 'always', 'unless-stopped', 'on-failure')

CONTAINER_ACTIONS = {
    'start':   ['start'],
    'stop':    ['stop'],
    'restart': ['restart'],
    'pause':   ['pause'],
    'unpause': ['unpause'],
}


# ── helpers ────────────────────────────────────────────────
def _docker(*args, timeout=20):
    """Run docker, return (ok, stdout, stderr). Never raises."""
    try:
        r = subprocess.run([DOCKER_BIN, *args], capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout, r.stderr.strip()
    except FileNotFoundError:
        return False, '', 'docker CLI not found on this host'
    except subprocess.TimeoutExpired:
        return False, '', f'docker {args[0]} timed out after {timeout}s'
    except Exception as e:  # pragma: no cover - defensive
        return False, '', str(e)


def _json_lines(out):
    rows = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue
    return rows


def _err(msg, code=400):
    return jsonify({'ok': False, 'error': msg}), code


def _ref(value):
    value = (value or '').strip() if isinstance(value, str) else ''
    return value if REF_RE.match(value) else None


def _parse_labels(raw):
    labels = {}
    for part in (raw or '').split(','):
        k, sep, v = part.partition('=')
        if sep:
            labels[k] = v
    return labels


@bp.before_request
def _require_header_for_writes():
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE') and request.headers.get('X-Requested-With') != 'ats-monitor':
        return _err('missing X-Requested-With header', 403)


# ── status ─────────────────────────────────────────────────
@bp.route('/status')
def status():
    ok, out, err = _docker('version', '--format', '{{json .}}', timeout=8)
    if not ok:
        return jsonify({'available': False, 'error': err or 'docker is not reachable'})
    try:
        v = json.loads(out)
    except ValueError:
        v = {}
    return jsonify({
        'available': True,
        'server': (v.get('Server') or {}).get('Version'),
        'client': (v.get('Client') or {}).get('Version'),
    })


# ── containers ─────────────────────────────────────────────
@bp.route('/containers')
def containers():
    ok, out, err = _docker('ps', '-a', '--no-trunc', '--format', '{{json .}}')
    if not ok:
        return _err(err or 'docker ps failed', 502)
    rows = []
    for c in _json_lines(out):
        labels = _parse_labels(c.get('Labels'))
        project = labels.get('com.docker.compose.project') or ''
        rows.append({
            'id': (c.get('ID') or '')[:12],
            'full_id': c.get('ID') or '',
            'name': c.get('Names') or '',
            'image': c.get('Image') or '',
            'command': (c.get('Command') or '').strip('"'),
            'created': c.get('CreatedAt') or '',
            'status': c.get('Status') or '',
            'state': c.get('State') or '',
            'ports': c.get('Ports') or '',
            'project': project,
            'service': labels.get('com.docker.compose.service') or '',
        })
    rows.sort(key=lambda r: (r['project'] or '~', r['name']))
    return jsonify({'containers': rows})


@bp.route('/stats')
def stats():
    """Live usage for running containers (one-shot sample)."""
    ok, out, err = _docker('stats', '--no-stream', '--no-trunc', '--format', '{{json .}}', timeout=25)
    if not ok:
        return _err(err or 'docker stats failed', 502)
    res = {}
    for s in _json_lines(out):
        cid = (s.get('ID') or s.get('Container') or '')[:12]
        res[cid] = {
            'cpu': s.get('CPUPerc'), 'mem_pct': s.get('MemPerc'), 'mem': s.get('MemUsage'),
            'net': s.get('NetIO'), 'block': s.get('BlockIO'), 'pids': s.get('PIDs'),
        }
    return jsonify({'stats': res})


@bp.route('/containers/<cid>/logs')
def container_logs(cid):
    if not _ref(cid):
        return _err('invalid container')
    try:
        tail = max(1, min(int(request.args.get('tail', 300)), 5000))
    except ValueError:
        tail = 300
    ok, out, err = _docker('logs', '--tail', str(tail), '--timestamps', cid, timeout=20)
    if not ok:
        return _err(err or 'docker logs failed', 502)
    # docker writes the container's stderr to our stderr; keep both
    text = out + (('\n' + err) if err else '')
    return jsonify({'ok': True, 'lines': text.splitlines()})


@bp.route('/containers/<cid>/inspect')
def container_inspect(cid):
    if not _ref(cid):
        return _err('invalid container')
    ok, out, err = _docker('inspect', cid)
    if not ok:
        return _err(err or 'docker inspect failed', 502)
    try:
        return jsonify({'ok': True, 'data': json.loads(out)[0]})
    except (ValueError, IndexError):
        return _err('could not parse inspect output', 502)


@bp.route('/containers/<cid>/<action>', methods=['POST'])
def container_action(cid, action):
    if not _ref(cid):
        return _err('invalid container')
    if action not in CONTAINER_ACTIONS:
        return _err('unknown action', 404)
    ok, _, err = _docker(*CONTAINER_ACTIONS[action], cid, timeout=60)
    print(f'[docker] {action} {cid} -> {"ok" if ok else err}', flush=True)
    return (jsonify({'ok': True}) if ok else _err(err or f'{action} failed', 502))


@bp.route('/containers/<cid>', methods=['DELETE'])
def container_remove(cid):
    if not _ref(cid):
        return _err('invalid container')
    args = ['rm']
    if request.args.get('force') == '1':
        args.append('-f')
    ok, _, err = _docker(*args, cid, timeout=60)
    print(f'[docker] rm {cid} -> {"ok" if ok else err}', flush=True)
    return (jsonify({'ok': True}) if ok else _err(err or 'remove failed', 502))


@bp.route('/containers', methods=['POST'])
def container_create():
    body = request.get_json(silent=True) or {}
    image = _ref(body.get('image'))
    if not image:
        return _err('a valid image is required (e.g. nginx:latest)')
    args = ['run', '-d']

    name = (body.get('name') or '').strip()
    if name:
        if not NAME_RE.match(name):
            return _err('invalid container name')
        args += ['--name', name]

    policy = body.get('restart') or 'no'
    if policy not in RESTART_POLICIES:
        return _err('invalid restart policy')
    if policy != 'no':
        args += ['--restart', policy]

    for key, rx, flag, label in (('ports', PORT_RE, '-p', 'port mapping'),
                                 ('env', ENV_RE, '-e', 'environment variable'),
                                 ('volumes', VOL_RE, '-v', 'volume mount')):
        items = body.get(key) or []
        if not isinstance(items, list) or len(items) > 50:
            return _err(f'invalid {key}')
        for it in items:
            it = it.strip() if isinstance(it, str) else ''
            if not it:
                continue
            if not rx.match(it):
                return _err(f'invalid {label}: {it[:60]}')
            args += [flag, it]

    args.append(image)  # image last; nothing after it so no command override
    ok, out, err = _docker(*args, timeout=300)
    print(f'[docker] run {image} -> {"ok" if ok else err}', flush=True)
    if not ok:
        return _err(err or 'docker run failed', 502)
    return jsonify({'ok': True, 'id': out.strip()[:12]})


# ── images ─────────────────────────────────────────────────
@bp.route('/images')
def images():
    ok, out, err = _docker('images', '--no-trunc', '--format', '{{json .}}')
    if not ok:
        return _err(err or 'docker images failed', 502)
    _, cout, _ = _docker('ps', '-a', '--format', '{{.Image}}')
    used = set(cout.split())
    rows = []
    for i in _json_lines(out):
        iid = (i.get('ID') or '').replace('sha256:', '')[:12]
        repo, tag = i.get('Repository') or '<none>', i.get('Tag') or '<none>'
        rows.append({
            'id': iid, 'repo': repo, 'tag': tag, 'size': i.get('Size') or '',
            'created': i.get('CreatedSince') or i.get('CreatedAt') or '',
            'in_use': (f'{repo}:{tag}' in used) or repo in used or iid in used,
        })
    return jsonify({'images': rows})


@bp.route('/images/pull', methods=['POST'])
def image_pull():
    image = _ref((request.get_json(silent=True) or {}).get('image'))
    if not image:
        return _err('a valid image reference is required')
    ok, _, err = _docker('pull', image, timeout=600)
    print(f'[docker] pull {image} -> {"ok" if ok else err}', flush=True)
    return (jsonify({'ok': True}) if ok else _err(err or 'pull failed', 502))


@bp.route('/images/<iid>', methods=['DELETE'])
def image_remove(iid):
    if not _ref(iid):
        return _err('invalid image')
    ok, _, err = _docker('rmi', iid, timeout=60)
    print(f'[docker] rmi {iid} -> {"ok" if ok else err}', flush=True)
    return (jsonify({'ok': True}) if ok else _err(err or 'remove failed', 502))


# ── volumes ────────────────────────────────────────────────
@bp.route('/volumes')
def volumes():
    ok, out, err = _docker('volume', 'ls', '--format', '{{json .}}')
    if not ok:
        return _err(err or 'docker volume ls failed', 502)
    _, cout, _ = _docker('ps', '-a', '--format', '{{.Mounts}}')
    mounted = set()
    for line in cout.splitlines():
        mounted.update(p for p in line.split(',') if p)
    rows = [{
        'name': v.get('Name') or '', 'driver': v.get('Driver') or '',
        'scope': v.get('Scope') or '', 'in_use': (v.get('Name') or '') in mounted,
    } for v in _json_lines(out)]
    return jsonify({'volumes': rows})


@bp.route('/volumes/<name>', methods=['DELETE'])
def volume_remove(name):
    if not _ref(name):
        return _err('invalid volume')
    ok, _, err = _docker('volume', 'rm', name)
    print(f'[docker] volume rm {name} -> {"ok" if ok else err}', flush=True)
    return (jsonify({'ok': True}) if ok else _err(err or 'remove failed', 502))


# ── networks ───────────────────────────────────────────────
@bp.route('/networks')
def networks():
    ok, out, err = _docker('network', 'ls', '--no-trunc', '--format', '{{json .}}')
    if not ok:
        return _err(err or 'docker network ls failed', 502)
    rows = [{
        'id': (n.get('ID') or '')[:12], 'name': n.get('Name') or '',
        'driver': n.get('Driver') or '', 'scope': n.get('Scope') or '',
        'builtin': (n.get('Name') or '') in ('bridge', 'host', 'none'),
    } for n in _json_lines(out)]
    return jsonify({'networks': rows})


@bp.route('/networks/<nid>', methods=['DELETE'])
def network_remove(nid):
    if not _ref(nid):
        return _err('invalid network')
    ok, _, err = _docker('network', 'rm', nid)
    print(f'[docker] network rm {nid} -> {"ok" if ok else err}', flush=True)
    return (jsonify({'ok': True}) if ok else _err(err or 'remove failed', 502))


# ── interactive shell (`docker exec -it`) over Socket.IO ───
_shells = {}  # sid -> {fd, pid}


def register_shell(socketio, ns='/docker-shell', app=None):
    """Attach the container shell namespace. Unlike a bare namespace this one
    refuses unauthenticated connections."""

    def app_context():
        return app.app_context()

    def _pump(sid, fd):
        while sid in _shells:
            with app_context():
                authorized = security.socket_authorized(_shells[sid].get('auth_id'))
            if not authorized:
                socketio.server.disconnect(sid, namespace=ns)
                break
            try:
                r, _, _ = select.select([fd], [], [], 0.05)
                if r:
                    data = os.read(fd, 8192)
                    if not data:
                        break
                    socketio.emit('shell_output', data.decode('utf-8', errors='replace'), namespace=ns, room=sid)
            except OSError:
                break
        s = _shells.pop(sid, None)
        if s:
            _reap(s['fd'], s['pid'])
            socketio.emit('shell_output', '\r\n[Session ended]\r\n', namespace=ns, room=sid)

    def _reap(fd, pid):
        try:
            os.close(fd)
        except OSError:
            pass
        if pid:
            try:
                os.kill(pid, signal.SIGKILL)
                os.waitpid(pid, 0)  # returns at once after SIGKILL; avoids a zombie
            except OSError:
                pass

    @socketio.on('connect', namespace=ns)
    def _connect():
        if not security.socket_authorized(session.get('auth_id')):
            return False
        cid = _ref(request.args.get('container'))
        if not cid:
            return False
        sid = request.sid
        pid, fd = pty.fork()
        if pid == 0:
            env = os.environ.copy()
            env['TERM'] = 'xterm-256color'
            os.execvpe(DOCKER_BIN, [DOCKER_BIN, 'exec', '-it', cid, 'sh', '-c',
                                    'command -v bash >/dev/null 2>&1 && exec bash || exec sh'], env)
        _shells[sid] = {'fd': fd, 'pid': pid, 'auth_id': session.get('auth_id')}
        print(f'[docker] shell open {cid}', flush=True)
        threading.Thread(target=_pump, args=(sid, fd), daemon=True).start()

    @socketio.on('shell_input', namespace=ns)
    def _input(data):
        s = _shells.get(request.sid)
        if s and not security.socket_authorized(s.get('auth_id')):
            socketio.server.disconnect(request.sid, namespace=ns)
            return
        if s and isinstance(data, dict):
            try:
                os.write(s['fd'], str(data.get('input', '')).encode())
            except OSError:
                pass

    @socketio.on('shell_resize', namespace=ns)
    def _resize(data):
        s = _shells.get(request.sid)
        if s and not security.socket_authorized(s.get('auth_id')):
            socketio.server.disconnect(request.sid, namespace=ns)
            return
        if s and isinstance(data, dict):
            try:
                fcntl.ioctl(s['fd'], termios.TIOCSWINSZ,
                            struct.pack('HHHH', int(data.get('rows', 24)), int(data.get('cols', 80)), 0, 0))
            except (OSError, ValueError):
                pass

    @socketio.on('disconnect', namespace=ns)
    def _disconnect():
        s = _shells.pop(request.sid, None)
        if s:
            _reap(s['fd'], s['pid'])

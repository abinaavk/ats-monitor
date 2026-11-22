# Run this ONLY if you are using Gunicorn with the -k gevent worker
import os
try:
    if os.environ.get('GUNICORN_WORKER') == 'gevent' or 'gevent' in os.environ.get('WORKER_CLASS', ''):
        from gevent import monkey
        monkey.patch_all()
except ImportError:
    pass

import json, sqlite3, subprocess, datetime, socket, threading, select, signal, pty, fcntl, termios, struct
from flask import Flask, render_template, session, redirect, request, jsonify, url_for, send_from_directory
from functools import wraps

# The private Global adapter (remote_host.py) serves no browser or WebSocket, so it
# runs headless and needs only Flask. The browser-facing Monitor is unaffected.
if os.environ.get('ATS_MONITOR_HEADLESS') == '1':
    class SocketIO:
        def __init__(self, *args, **kwargs):
            pass

        def on(self, *args, **kwargs):
            return lambda function: function
else:
    from flask_socketio import SocketIO, emit

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

app = Flask(__name__)
import security
security.init_app(app, 'abi@arv')

@app.route('/sw.js')
def pwa_worker():
    response = send_from_directory(app.static_folder, 'sw.js', mimetype='application/javascript')
    response.headers['Cache-Control'] = 'no-cache'
    return response

# FORCE async_mode to gevent for stability
socketio = SocketIO(app, async_mode='gevent', cors_allowed_origins=None)

# Docker management (REST blueprint + authenticated `docker exec` shell namespace)
import docker_api
app.register_blueprint(docker_api.bp)
docker_api.register_shell(socketio, app=app)

# Manage tab: bridge to the ats headless CLI (see docs/manage.md)
import manage_api
app.register_blueprint(manage_api.bp)
import servers_api
servers_api.initialize(app)
import fleet_api
fleet_api.initialize(app)

# sid → {fd, pid}
_term_sessions = {}

# ══════════════════════════════════════════════════════
#   CONFIG (Optimized for Linux)
# ══════════════════════════════════════════════════════
ATS_HOME = os.environ.get('ATS_HOME', '/home/gaia')
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def get_path(filename):
    # priority: 1. Same folder as app.py, 2. /home/gaia, 3. /home/gaia/ats
    for d in [BASE_DIR, ATS_HOME, os.path.join(ATS_HOME, 'ats')]:
        p = os.path.join(d, filename)
        if os.path.exists(p): return p
    return os.path.join(ATS_HOME, filename)

DB_FILE      = get_path('ats.db')
LOG_FILE     = get_path('ats.log')
SEC_FILE     = get_path('security.log')
AUDIT_FILE   = get_path('audit.trace')
METRICS_FILE = get_path('metrics.prom')
BACKUP_DIR   = os.environ.get('BACKUP_DIR', '/opt/extra1_1tb/backups')


# ══════════════════════════════════════════════════════
#   AUTH
# ══════════════════════════════════════════════════════

@app.route('/')
def index(): return render_template('index.html')

@app.route('/api/audit')

def api_audit():
    n = min(int(request.args.get('n', 200)), 1000)
    entries = []
    if os.path.exists(AUDIT_FILE):
        try:
            with open(AUDIT_FILE, 'r', encoding='utf-8', errors='replace') as f:
                lines = f.readlines()
            for line in lines[-n:]:
                line = line.strip()
                if not line: continue
                try: 
                    entries.append(json.loads(line))
                except: 
                    entries.append({
                        'target': line, 
                        'action': 'LOG', 
                        'user': 'system', 
                        'timestamp': datetime.datetime.now().strftime('%H:%M'),
                        'details': 'Plain entry'
                    })
        except: pass
    entries.reverse()
    return jsonify({'entries': entries})

# ══════════════════════════════════════════════════════
#   DB HELPER
# ══════════════════════════════════════════════════════
def dbq(sql, args=(), fetch_all=False, fetch_one=False):
    if not os.path.exists(DB_FILE):
        return None
    try:
        # Linux standard: three slashes for absolute paths in file URIs
        path = os.path.abspath(DB_FILE)
        uri = f'file://{path}?mode=ro'
        conn = sqlite3.connect(uri, uri=True, timeout=15)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(sql, args)
        if fetch_all: res = [dict(r) for r in cur.fetchall()]
        elif fetch_one:
            row = cur.fetchone()
            res = dict(row) if row else None
        else: res = None
        conn.close()
        return res
    except Exception as e:
        print(f"DATABASE ERROR: {e}")
        return None

# ══════════════════════════════════════════════════════
#   UTILITIES
# ══════════════════════════════════════════════════════
def table_exists(table_name):
    res = dbq("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (table_name,), fetch_one=True)
    return bool(res)

def systemd_active(name):
    try:
        r = subprocess.run(['systemctl', 'is-active', '--quiet', name], timeout=1)
        return r.returncode == 0
    except: return False

def tail_file(path, n=300):
    if not os.path.exists(path): return ""
    try:
        # Fast native tail
        r = subprocess.run(['tail', '-n', str(n), path], capture_output=True, text=True, timeout=1)
        if r.returncode == 0: return r.stdout
    except: pass
    return ""

def disk_info_linux(path):
    try:
        u = os.statvfs(path)
        total = (u.f_frsize * u.f_blocks) / 1024**3
        free  = (u.f_frsize * u.f_bfree) / 1024**3
        used  = total - free
        pct   = round((used / total * 100), 1) if total > 0 else 0
        return {'path': path, 'used': round(used, 1), 'total': round(total, 1), 'pct': pct}
    except: return None

# ══════════════════════════════════════════════════════
#   API
# ══════════════════════════════════════════════════════
def _live_proc_metrics(svc_name):
    """Find processes matching svc_name via psutil and return cpu%/ram%/ram_mb."""
    if not HAS_PSUTIL: return None
    cpu = 0.0; mem = 0.0; mem_mb = 0.0; found = False
    try:
        for p in psutil.process_iter(['pid', 'name', 'cmdline', 'cpu_percent', 'memory_percent', 'memory_info']):
            try:
                info = p.info
                cmd = ' '.join(info.get('cmdline') or [])
                if svc_name.lower() in cmd.lower() or svc_name.lower() in (info.get('name') or '').lower():
                    p.cpu_percent()
                    cpu += p.cpu_percent(interval=0.05) or 0
                    mem += info.get('memory_percent') or 0
                    mi = info.get('memory_info')
                    if mi: mem_mb += mi.rss
                    found = True
            except (psutil.NoSuchProcess, psutil.AccessDenied): continue
    except: pass
    if found: return {'cpu': round(cpu, 1), 'ram': round(mem, 1), 'ram_mb': round(mem_mb / 1024**2, 1)}
    return None
@app.route('/api/overview')

def api_overview():
    svcs = dbq('SELECT * FROM services ORDER BY name', fetch_all=True) or []
    svc_list = []
    for s in svcs:
        svc_list.append({
            'name': s['name'], 'port': s['port'], 'status': 'online' if systemd_active(s['name']) else 'offline',
            'runtime': s.get('runtime', 'python'), 'domain': s.get('domain', 'localhost')
        })
    
    cpu = ram = swap = None
    if HAS_PSUTIL:
        cpu = psutil.cpu_percent(interval=0.1)
        mem = psutil.virtual_memory()
        ram = {'pct': mem.percent, 'used': round(mem.used/1024**3, 2), 'total': round(mem.total/1024**3, 2)}
        swp = psutil.swap_memory()
        swap = {'pct': swp.percent, 'used': round(swp.used/1024**2), 'total': round(swp.total/1024**2)}

    try: load = [round(x, 2) for x in os.getloadavg()]
    except: load = [0, 0, 0]

    try:
        uptime_secs = int(datetime.datetime.now().timestamp() - psutil.boot_time()) if HAS_PSUTIL else 0
        days, rem = divmod(uptime_secs, 86400)
        hours, rem2 = divmod(rem, 3600)
        mins, _ = divmod(rem2, 60)
        uptime = f"{days}d {hours}h {mins}m" if days > 0 else f"{hours}h {mins}m"
    except: uptime = "N/A"

    # Database Health
    db_exists = os.path.exists(DB_FILE)
    db_status = "ok"
    integrity_ok = False
    db_stats = {}

    if db_exists:
        try:
            integrity = dbq('PRAGMA integrity_check', fetch_one=True)
            if integrity:
                res_val = list(integrity.values())[0]
                integrity_ok = (res_val == 'ok')
                if not integrity_ok: db_status = f"Corrupt: {res_val}"
            else: db_status = "Check failed"
        except Exception as e: db_status = f"Error: {str(e)}"

        for t in ['services', 'backups', 'deployments', 'metrics_history']:
            if table_exists(t):
                r = dbq(f'SELECT COUNT(*) as c FROM {t}', fetch_one=True)
                db_stats[t] = r['c'] if r else 0
            else: db_stats[t] = 0
    else: db_status = "Database not found"

    return jsonify({
        'services': svc_list, 'online': sum(1 for s in svc_list if s['status'] == 'online'),
        'total': len(svc_list), 'cpu': cpu, 'ram': ram, 'swap': swap, 'load': load, 'uptime': uptime,
        'disk_root': disk_info_linux('/'), 'disk_storage': disk_info_linux('/opt/extra1_1tb'),
        'db_integrity': integrity_ok, 'db_status': db_status, 'db_exists': db_exists, 
        'db_stats': db_stats, 'db_path': DB_FILE,
        'internet': subprocess.call(['ping', '-c', '1', '-W', '1', '1.1.1.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0,
        'dns': subprocess.call(['ping', '-c', '1', '-W', '1', 'github.com'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0,
        'cloudflare': systemd_active('cloudflared'),
        'timestamp': datetime.datetime.now().strftime('%H:%M:%S')
    })

@app.route('/api/logs')

def api_logs():
    t = request.args.get('type', 'ats')
    paths = {'ats': LOG_FILE, 'security': SEC_FILE, 'metrics': METRICS_FILE}
    content = tail_file(paths.get(t, LOG_FILE), 400)
    return jsonify({'lines': content.splitlines(), 'type': t})

@app.route('/api/database')

def api_database():
    table = request.args.get('table', 'services')
    allowed = ['services', 'backups', 'deployments', 'metrics_history', 'remote_configs']
    if table not in allowed: return jsonify({'error': 'denied'}), 400
    rows = dbq(f'SELECT * FROM {table} ORDER BY rowid DESC LIMIT 100', fetch_all=True) or []
    cols = list(rows[0].keys()) if rows else []
    return jsonify({'table': table, 'columns': cols, 'rows': rows})

@app.route('/api/stats')

def api_stats():
    svcs = dbq('SELECT * FROM services ORDER BY name', fetch_all=True) or []
    out = []
    
    # Global aggregates
    total_deploys = 0
    total_success = 0
    total_backups = 0
    
    has_dep = table_exists('deployments')
    has_bk = table_exists('backups')
    has_metrics = table_exists('metrics_history')

    for s in svcs:
        nm = s['name']
        
        # Deployment stats
        dep = {'total': 0, 'ok': 0}
        if has_dep:
            r = dbq("SELECT COUNT(*) as total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok FROM deployments WHERE service_name=?", (nm,), fetch_one=True)
            if r:
                dep = r
                total_deploys += (r['total'] or 0)
                total_success += (r['ok'] or 0)
        
        last_dep = dbq("SELECT status, timestamp FROM deployments WHERE service_name=? ORDER BY timestamp DESC LIMIT 1", (nm,), fetch_one=True) if has_dep else None
        
        # Backup stats
        bk_count = 0
        if has_bk:
            r = dbq("SELECT COUNT(*) as c FROM backups WHERE service_name=?", (nm,), fetch_one=True)
            if r:
                bk_count = r['c']
                total_backups += bk_count
        
        # Uptime/Metric trend (Last 10 points)
        trend = []
        current_metrics = {'cpu': 0, 'ram': 0, 'ram_mb': 0}
        if has_metrics:
            rows = dbq("SELECT cpu, ram_pct FROM metrics_history WHERE service_name=? ORDER BY timestamp DESC LIMIT 10", (nm,), fetch_all=True)
            if rows:
                trend = [r['cpu'] for r in rows]
                trend.reverse()
                current_metrics = {'cpu': rows[0]['cpu'], 'ram': rows[0]['ram_pct'], 'ram_mb': 0}

        # Fallback: live psutil if DB has no metrics
        if current_metrics['cpu'] == 0 and current_metrics['ram'] == 0:
            live = _live_proc_metrics(nm)
            if live:
                current_metrics = live

        out.append({
            'name': nm,
            'port': s['port'],
            'domain': s.get('domain', 'localhost'),
            'status': 'online' if systemd_active(nm) else 'offline',
            'deploy_total': dep.get('total', 0) or 0,
            'deploy_ok': dep.get('ok', 0) or 0,
            'last_deploy': last_dep,
            'backup_count': bk_count,
            'trend': trend,
            'current_metrics': current_metrics,
            'created_at': s.get('created_at', '—')
        })

    return jsonify({
        'services': out,
        'global': {
            'total_services': len(svcs),
            'total_deployments': total_deploys,
            'deployment_success_rate': round(total_success / total_deploys * 100, 1) if total_deploys > 0 else 0,
            'total_backups': total_backups,
            'active_workers': sum(s.get('workers', 0) for s in svcs if s.get('workers'))
        }
    })

# ══════════════════════════════════════════════════════
#   TERMINAL
# ══════════════════════════════════════════════════════
def _close_terminal(sid):
    sess = _term_sessions.pop(sid, None)
    if not sess:
        return
    if sess.get('relay'):
        sess['relay'].close()
        return
    try:
        os.close(sess['fd'])
    except OSError:
        pass
    try:
        os.kill(sess['pid'], signal.SIGKILL)
    except ProcessLookupError:
        pass
    # Reap without blocking the gevent event loop.
    while True:
        try:
            if os.waitpid(sess['pid'], os.WNOHANG)[0]:
                break
        except ChildProcessError:
            break
        socketio.sleep(0.01)


def _terminal_authorized(auth_id):
    with app.app_context():
        return security.socket_authorized(auth_id)


def _read_pty(sid, fd):
    # The app also runs directly without monkey-patching. A native reader
    # thread cannot reliably wake gevent's Socket.IO transport queue.
    import codecs
    from gevent.select import select as cooperative_select
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    try:
        while sid in _term_sessions:
            if not _terminal_authorized(_term_sessions[sid].get('auth_id')):
                socketio.server.disconnect(sid, namespace='/terminal')
                break
            ready, _, _ = cooperative_select([fd], [], [], 0.1)
            if sid not in _term_sessions:
                break
            if not ready:
                continue
            data = os.read(fd, 8192)
            if not data:
                break
            text = decoder.decode(data)
            if text:
                socketio.emit('terminal_output', text, namespace='/terminal', to=sid)
            socketio.sleep(0)
    except OSError:
        pass  # PTYs report EIO when the child exits.
    finally:
        if sid in _term_sessions:
            tail = decoder.decode(b'', final=True)
            if tail:
                socketio.emit('terminal_output', tail, namespace='/terminal', to=sid)
            socketio.emit('terminal_output', '\r\n[Session ended]\r\n', namespace='/terminal', to=sid)
            socketio.emit('terminal_exit', {}, namespace='/terminal', to=sid)
            _close_terminal(sid)


@socketio.on('connect', namespace='/terminal')
def on_term_connect(auth=None):
    from cluster_support import configured_node
    node = configured_node()
    if node and node['role'] != 'local':
        return False
    if not security.socket_authorized(session.get('auth_id')):
        return False
    sid = request.sid
    import activity
    security.record_for_session(session.get('auth_id'), 'terminal_opened',
                                activity.describe(activity.server_label(request.args.get('server') if node else None)))
    if node and request.args.get('server') != node['id']:
        # A Global: relay this browser terminal to a session on that server over the signed channel.
        import remote_terminal
        auth_id = session.get('auth_id')
        remote_terminal.attach(socketio, _term_sessions, sid, request.args.get('server'), auth_id,
                               namespace='/terminal', output_event='terminal_output', exit_event='terminal_exit',
                               authorized=lambda: _terminal_authorized(auth_id))
        return
    # An absent legacy default must not kill an otherwise usable shell.
    cwd = ATS_HOME if os.path.isdir(ATS_HOME) and os.access(ATS_HOME, os.X_OK) else os.path.expanduser('~')
    if not os.path.isdir(cwd):
        cwd = '/'
    try:
        pid, fd = pty.fork()
    except OSError as exc:
        app.logger.warning('Terminal PTY allocation failed: %s', exc)
        return False
    if pid == 0:
        try:
            os.chdir(cwd)
            env = os.environ.copy()
            env.update(TERM='xterm-256color', COLORTERM='truecolor', FORCE_COLOR='1')
            os.execvpe('/bin/bash', ['/bin/bash', '--login'], env)
        except OSError:
            os.write(2, b'Unable to start terminal shell.\r\n')
            os._exit(1)
    _term_sessions[sid] = {'fd': fd, 'pid': pid, 'auth_id': session.get('auth_id')}
    socketio.start_background_task(_read_pty, sid, fd)


@socketio.on('terminal_input', namespace='/terminal')
def on_term_input(data=None):
    sess = _term_sessions.get(request.sid)
    if sess and not security.socket_authorized(sess.get('auth_id')):
        socketio.server.disconnect(request.sid, namespace='/terminal')
        return
    value = data.get('input') if isinstance(data, dict) else None
    if sess and sess.get('relay'):
        sess['relay'].write(value)
        return
    if sess and isinstance(value, str):
        try:
            os.write(sess['fd'], value.encode())
        except OSError:
            pass


@socketio.on('terminal_resize', namespace='/terminal')
def on_term_resize(data=None):
    sess = _term_sessions.get(request.sid)
    if sess and not security.socket_authorized(sess.get('auth_id')):
        socketio.server.disconnect(request.sid, namespace='/terminal')
        return
    if sess and isinstance(data, dict):
        try:
            rows = max(1, min(1000, int(data.get('rows', 24))))
            cols = max(1, min(1000, int(data.get('cols', 80))))
            if sess.get('relay'):
                sess['relay'].resize(rows, cols)
                return
            fcntl.ioctl(sess['fd'], termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        except (OSError, ValueError, TypeError, OverflowError):
            pass


@socketio.on('disconnect', namespace='/terminal')
def on_term_disconnect(reason=None):
    _close_terminal(request.sid)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=9998, allow_unsafe_werkzeug=True)

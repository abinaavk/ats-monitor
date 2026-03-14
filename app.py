# Run this ONLY if you are using Gunicorn with the -k gevent worker
import os
try:
    if os.environ.get('GUNICORN_WORKER') == 'gevent' or 'gevent' in os.environ.get('WORKER_CLASS', ''):
        from gevent import monkey
        monkey.patch_all()
except ImportError:
    pass

import json, sqlite3, subprocess, datetime, socket, threading, select, signal, pty, fcntl, termios, struct
from flask import Flask, render_template, session, redirect, request, jsonify, url_for
from flask_socketio import SocketIO, emit
from functools import wraps

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', 'ats_monitor_v1_secret_key_change_me')

# FORCE async_mode to gevent for stability
socketio = SocketIO(app, async_mode='gevent', cors_allowed_origins='*')

# sid → {fd, pid}
_term_sessions = {}

# ══════════════════════════════════════════════════════
#   CONFIG (Optimized for Linux)
# ══════════════════════════════════════════════════════
ATS_HOME     = os.environ.get('ATS_HOME', '/home/gaia')

def get_path(filename):
    p1 = os.path.join(ATS_HOME, filename)
    p2 = os.path.join(ATS_HOME, 'ats', filename)
    return p1 if os.path.exists(p1) or not os.path.exists(p2) else p2

DB_FILE      = get_path('ats.db')
LOG_FILE     = get_path('ats.log')
SEC_FILE     = get_path('security.log')
AUDIT_FILE   = get_path('audit.trace')
METRICS_FILE = get_path('metrics.prom')
BACKUP_DIR   = os.environ.get('BACKUP_DIR', '/opt/extra1_1tb/backups')


# ══════════════════════════════════════════════════════
#   AUTH (Bypassed)
# ══════════════════════════════════════════════════════
def auth_required(f):
    @wraps(f)
    def wrap(*a, **kw): return f(*a, **kw)
    return wrap

@app.route('/')
@auth_required
def index(): return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
def login(): return redirect(url_for('index'))

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
@app.route('/api/overview')
@auth_required
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
        'total': len(svc_list), 'cpu': cpu, 'ram': ram, 'swap': swap, 'load': load,
        'disk_root': disk_info_linux('/'), 'disk_storage': disk_info_linux('/opt/extra1_1tb'),
        'db_integrity': integrity_ok, 'db_status': db_status, 'db_exists': db_exists, 
        'db_stats': db_stats, 'db_path': DB_FILE,
        'internet': subprocess.call(['ping', '-c', '1', '-W', '1', '1.1.1.1'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0,
        'dns': subprocess.call(['ping', '-c', '1', '-W', '1', 'github.com'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0,
        'cloudflare': systemd_active('cloudflared'),
        'timestamp': datetime.datetime.now().strftime('%H:%M:%S')
    })

@app.route('/api/logs')
@auth_required
def api_logs():
    t = request.args.get('type', 'ats')
    paths = {'ats': LOG_FILE, 'security': SEC_FILE, 'metrics': METRICS_FILE}
    content = tail_file(paths.get(t, LOG_FILE), 400)
    return jsonify({'lines': content.splitlines(), 'type': t})

@app.route('/api/database')
@auth_required
def api_database():
    table = request.args.get('table', 'services')
    allowed = ['services', 'backups', 'deployments', 'metrics_history', 'remote_configs']
    if table not in allowed: return jsonify({'error': 'denied'}), 400
    rows = dbq(f'SELECT * FROM {table} ORDER BY rowid DESC LIMIT 100', fetch_all=True) or []
    cols = list(rows[0].keys()) if rows else []
    return jsonify({'table': table, 'columns': cols, 'rows': rows})

@app.route('/api/stats')
@auth_required
def api_stats():
    svcs = dbq('SELECT * FROM services ORDER BY name', fetch_all=True) or []
    out = []
    has_dep = table_exists('deployments')
    has_bk = table_exists('backups')
    for s in svcs:
        nm = s['name']
        dep = {'total': 0, 'ok': 0}
        if has_dep:
            r = dbq("SELECT COUNT(*) as total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok FROM deployments WHERE service_name=?", (nm,), fetch_one=True)
            if r: dep = r
        last_dep = dbq("SELECT status, timestamp FROM deployments WHERE service_name=? ORDER BY timestamp DESC LIMIT 1", (nm,), fetch_one=True) if has_dep else None
        bk_count = 0
        if has_bk:
            r = dbq("SELECT COUNT(*) as c FROM backups WHERE service_name=?", (nm,), fetch_one=True)
            if r: bk_count = r['c']
        out.append({
            'name': nm, 'port': s['port'], 'domain': s.get('domain', 'localhost'), 'status': 'online' if systemd_active(nm) else 'offline',
            'deploy_total': dep.get('total', 0), 'deploy_ok': dep.get('ok', 0), 'last_deploy': last_dep, 'backup_count': bk_count
        })
    return jsonify({'services': out})

# ══════════════════════════════════════════════════════
#   TERMINAL
# ══════════════════════════════════════════════════════
def _read_pty(sid, fd):
    while sid in _term_sessions:
        try:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                data = os.read(fd, 8192)
                if not data: break
                socketio.emit('terminal_output', {'data': data.decode('utf-8', errors='replace')}, namespace='/terminal', room=sid)
        except: break
    if sid in _term_sessions:
        socketio.emit('terminal_output', {'data': '\r\n[Session ended]\r\n'}, namespace='/terminal', room=sid)

@socketio.on('connect', namespace='/terminal')
def on_term_connect():
    sid = request.sid
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(ATS_HOME)
        os.execvpe('/bin/bash', ['/bin/bash', '--login'], os.environ)
    else:
        _term_sessions[sid] = {'fd': fd, 'pid': pid}
        threading.Thread(target=_read_pty, args=(sid, fd), daemon=True).start()

@socketio.on('terminal_input', namespace='/terminal')
def on_term_input(data):
    sess = _term_sessions.get(request.sid)
    if sess:
        try: os.write(sess['fd'], data['input'].encode())
        except: pass

@socketio.on('terminal_resize', namespace='/terminal')
def on_term_resize(data):
    sess = _term_sessions.get(request.sid)
    if sess:
        try: fcntl.ioctl(sess['fd'], termios.TIOCSWINSZ, struct.pack('HHHH', int(data.get('rows', 24)), int(data.get('cols', 80)), 0, 0))
        except: pass

@socketio.on('disconnect', namespace='/terminal')
def on_term_disconnect():
    sess = _term_sessions.pop(request.sid, None)
    if sess:
        try:
            os.kill(sess['pid'], signal.SIGKILL)
            os.close(sess['fd'])
        except: pass

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=9998, allow_unsafe_werkzeug=True)

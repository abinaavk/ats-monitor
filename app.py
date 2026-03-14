import os, json, sqlite3, subprocess, datetime, socket, threading, select, signal, pty, fcntl, termios, struct
from flask import Flask, render_template, session, redirect, request, jsonify, url_for
from flask_socketio import SocketIO, emit
from functools import wraps

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

app = Flask(__name__)
app.secret_key = 'ats_monitor_v1_secret_key_change_me'
socketio = SocketIO(app, async_mode='threading', cors_allowed_origins='*')

# sid → {fd, pid}
_term_sessions = {}

# ══════════════════════════════════════════════════════
#   CONFIG (Optimized for Linux)
# ══════════════════════════════════════════════════════
ATS_HOME     = '/home/gaia/ats'
DB_FILE      = os.path.join(ATS_HOME, 'ats.db')
LOG_FILE     = os.path.join(ATS_HOME, 'ats.log')
AUDIT_FILE   = os.path.join(ATS_HOME, 'audit.trace')
SEC_FILE     = os.path.join(ATS_HOME, 'security.log')
METRICS_FILE = os.path.join(ATS_HOME, 'metrics.prom')
BACKUP_DIR   = '/opt/extra1_1tb/backups'

# Ensure directories exist (Linux)
for d in [ATS_HOME, BACKUP_DIR]:
    if not os.path.exists(d):
        try: os.makedirs(d, exist_ok=True)
        except: pass

# ══════════════════════════════════════════════════════
#   AUTH (Bypassed for private use)
# ══════════════════════════════════════════════════════
def auth_required(f):
    @wraps(f)
    def wrap(*a, **kw):
        return f(*a, **kw)
    return wrap

@app.route('/')
@auth_required
def index():
    return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    return redirect(url_for('index'))

@app.route('/logout')
def logout():
    return redirect(url_for('login'))

# ══════════════════════════════════════════════════════
#   DB HELPER (Linux standard)
# ══════════════════════════════════════════════════════
def dbq(sql, args=(), fetch_all=False, fetch_one=False):
    if not os.path.exists(DB_FILE):
        return None
    try:
        conn = sqlite3.connect(f'file:{DB_FILE}?mode=ro', uri=True, timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute(sql, args)
        if fetch_all:
            res = [dict(r) for r in cur.fetchall()]
        elif fetch_one:
            row = cur.fetchone()
            res = dict(row) if row else None
        else:
            res = None
        conn.close()
        return res
    except:
        return None

# ══════════════════════════════════════════════════════
#   UTILITIES (Linux Optimized)
# ══════════════════════════════════════════════════════
def port_open(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.5)
    try:
        return s.connect_ex(('127.0.0.1', int(port))) == 0
    except:
        return False
    finally:
        try: s.close()
        except: pass

def systemd_active(name):
    try:
        # systemctl is the source of truth on Linux
        r = subprocess.run(['systemctl', 'is-active', '--quiet', name], timeout=2)
        return r.returncode == 0
    except:
        # Fallback to psutil if systemctl fails
        if HAS_PSUTIL:
            try:
                for p in psutil.process_iter(['name']):
                    if name.lower() in p.info['name'].lower(): return True
            except: pass
    return False

def tail_file(path, n=300):
    if not os.path.exists(path): return ""
    try:
        # Native Linux tail is extremely fast and robust
        r = subprocess.run(['tail', '-n', str(n), path], capture_output=True, text=True, timeout=2)
        if r.returncode == 0: return r.stdout
    except: pass
    # Python fallback if tail fails
    try:
        with open(path, 'rb') as f:
            f.seek(0, 2)
            fsize = f.tell()
            buffer_size = 4096
            data = []
            found_newlines = 0
            pos = fsize
            while pos > 0 and found_newlines <= n:
                pos = max(0, pos - buffer_size)
                f.seek(pos)
                chunk = f.read(buffer_size)
                found_newlines += chunk.count(b'\n')
                data.insert(0, chunk)
            content = b''.join(data).decode('utf-8', errors='replace')
            return '\n'.join(content.splitlines()[-n:])
    except: return ''

def get_uptime_linux():
    try:
        with open('/proc/uptime', 'r') as f:
            secs = float(f.read().split()[0])
        d = int(secs // 86400)
        h = int((secs % 86400) // 3600)
        m = int((secs % 3600) // 60)
        return f"{d}d {h}h {m}m"
    except:
        return 'N/A'

def disk_info_linux(path):
    try:
        # Standard Linux disk info using statvfs
        u = os.statvfs(path)
        total = (u.f_frsize * u.f_blocks) / 1024**3
        free  = (u.f_frsize * u.f_bfree) / 1024**3
        used  = total - free
        pct   = round((used / total * 100), 1) if total > 0 else 0
        return {'path': path, 'used': round(used, 1), 'total': round(total, 1),
                'free': round(free, 1), 'pct': pct}
    except:
        # Fallback to psutil
        if HAS_PSUTIL:
            try:
                u = psutil.disk_usage(path)
                return {'path': path, 'used': round(u.used/1024**3, 1), 'total': round(u.total/1024**3, 1),
                        'free': round(u.free/1024**3, 1), 'pct': u.percent}
            except: pass
    return None

def ping_ok_linux(host):
    try:
        # Linux standard ping
        return subprocess.call(['ping', '-c', '1', '-W', '1', host],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0
    except: return False

# ══════════════════════════════════════════════════════
#   API
# ══════════════════════════════════════════════════════
@app.route('/api/overview')
@auth_required
def api_overview():
    svcs = dbq('SELECT * FROM services ORDER BY name', fetch_all=True) or []
    svc_list = []
    for s in svcs:
        online = systemd_active(s['name']) or port_open(s['port'])
        svc_list.append({
            'name': s['name'], 'port': s['port'], 'domain': s['domain'],
            'status': 'online' if online else 'offline',
            'runtime': s.get('runtime', 'python'), 'workers': s.get('workers', 0)
        })
    
    cpu = ram = swap = None
    if HAS_PSUTIL:
        cpu = psutil.cpu_percent(interval=0.1)
        mem = psutil.virtual_memory()
        ram = {'used': round(mem.used/1024**3, 2), 'total': round(mem.total/1024**3, 2), 'pct': mem.percent}
        swp = psutil.swap_memory()
        swap = {'used': round(swp.used/1024**2), 'total': round(swp.total/1024**2), 'pct': swp.percent}

    try: load = [round(x, 2) for x in os.getloadavg()]
    except: load = [0, 0, 0]

    db_stats = {}
    for t in ['services', 'backups', 'deployments', 'metrics_history']:
        r = dbq(f'SELECT COUNT(*) as c FROM {t}', fetch_one=True)
        db_stats[t] = r['c'] if r else 0

    integrity = dbq('PRAGMA integrity_check', fetch_one=True)
    integrity_ok = bool(integrity and list(integrity.values())[0] == 'ok')

    return jsonify({
        'services': svc_list, 'online': sum(1 for s in svc_list if s['status'] == 'online'),
        'total': len(svc_list), 'cpu': cpu, 'ram': ram, 'swap': swap,
        'disk_root': disk_info_linux('/'), 'disk_storage': disk_info_linux('/opt/extra1_1tb'),
        'load': load, 'uptime': get_uptime_linux(),
        'internet': ping_ok_linux('1.1.1.1'), 'dns': ping_ok_linux('github.com'),
        'cloudflare': subprocess.call(['systemctl', 'is-active', '--quiet', 'cloudflared'],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0,
        'db_stats': db_stats, 'db_integrity': integrity_ok,
        'timestamp': datetime.datetime.now().strftime('%H:%M:%S')
    })

@app.route('/api/logs')
@auth_required
def api_logs():
    t = request.args.get('type', 'ats')
    n = min(int(request.args.get('n', 300)), 1000)
    paths = {'ats': LOG_FILE, 'security': SEC_FILE, 'metrics': METRICS_FILE}
    content = tail_file(paths.get(t, LOG_FILE), n)
    return jsonify({'lines': content.splitlines(), 'type': t})

@app.route('/api/audit')
@auth_required
def api_audit():
    n = min(int(request.args.get('n', 200)), 500)
    entries = []
    if os.path.exists(AUDIT_FILE):
        try:
            with open(AUDIT_FILE, 'r', errors='replace') as f:
                lines = f.readlines()
            for line in lines[-n:]:
                try: entries.append(json.loads(line))
                except: entries.append({'target': line.strip(), 'action': 'RAW'})
        except: pass
    entries.reverse()
    return jsonify({'entries': entries})

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
    for s in svcs:
        nm = s['name']
        dep = dbq("SELECT COUNT(*) as total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok FROM deployments WHERE service_name=?", (nm,), fetch_one=True) or {'total': 0, 'ok': 0}
        last_dep = dbq("SELECT status, timestamp FROM deployments WHERE service_name=? ORDER BY timestamp DESC LIMIT 1", (nm,), fetch_one=True)
        bk = dbq("SELECT COUNT(*) as c FROM backups WHERE service_name=?", (nm,), fetch_one=True) or {'c': 0}
        online = systemd_active(nm) or port_open(s['port'])
        out.append({
            'name': nm, 'port': s['port'], 'domain': s['domain'], 'status': 'online' if online else 'offline',
            'deploy_total': dep['total'], 'deploy_ok': dep['ok'], 'last_deploy': last_dep, 'backup_count': bk['c']
        })
    return jsonify({'services': out})

# ══════════════════════════════════════════════════════
#   LINUX PTY TERMINAL ENGINE
# ══════════════════════════════════════════════════════

def _read_pty(sid, fd):
    while sid in _term_sessions:
        try:
            r, _, _ = select.select([fd], [], [], 0.1)
            if r:
                data = os.read(fd, 8192)
                if not data: break
                socketio.emit('terminal_output', {'data': data.decode('utf-8', errors='replace')}, namespace='/terminal', room=sid)
        except: break
    socketio.emit('terminal_output', {'data': '\r\n\x1b[31m[Session ended]\x1b[0m\r\n'}, namespace='/terminal', room=sid)

@socketio.on('connect', namespace='/terminal')
def on_term_connect():
    sid = request.sid
    pid, fd = pty.fork()
    if pid == 0:
        # Child: become interactive bash
        os.execvpe('/bin/bash', ['/bin/bash', '--login'], os.environ)
    else:
        # Parent: relay IO
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
        rows = int(data.get('rows', 24))
        cols = int(data.get('cols', 80))
        try:
            # Correct fcntl call for terminal resizing on Linux
            fcntl.ioctl(sess['fd'], termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        except: pass

@socketio.on('disconnect', namespace='/terminal')
def on_term_disconnect():
    sess = _term_sessions.pop(request.sid, None)
    if sess:
        try:
            os.kill(sess['pid'], signal.SIGKILL) # Kill the bash child
            os.close(sess['fd'])
        except: pass

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=9998, allow_unsafe_werkzeug=True)

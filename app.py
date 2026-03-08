import os, json, sqlite3, subprocess, datetime, socket
from flask import Flask, render_template, session, redirect, request, jsonify, url_for
from functools import wraps

try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False

app = Flask(__name__)
app.secret_key = 'ats_monitor_v1_secret_key_change_me'

# ═════════════════════════════════════════════════════
#   CONFIG  ← edit these two lines after deploy
# ══════════════════════════════════════════════════════
MONITOR_PASSWORD = 'abi@arv'

ATS_HOME     = '/home/gaia/ats'
DB_FILE      = os.path.join(ATS_HOME, 'ats.db')
LOG_FILE     = os.path.join(ATS_HOME, 'ats.log')
AUDIT_FILE   = os.path.join(ATS_HOME, 'audit.trace')
SEC_FILE     = os.path.join(ATS_HOME, 'security.log')
METRICS_FILE = os.path.join(ATS_HOME, 'metrics.prom')
BACKUP_DIR   = '/opt/extra1_1tb/backups'

# ══════════════════════════════════════════════════════
#   AUTH
# ══════════════════════════════════════════════════════
def auth_required(f):
    @wraps(f)
    def wrap(*a, **kw):
        if not session.get('auth'):
            return redirect(url_for('login'))
        return f(*a, **kw)
    return wrap

@app.route('/')
@auth_required
def index():
    return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    err = None
    if request.method == 'POST':
        if request.form.get('password') == MONITOR_PASSWORD:
            session['auth'] = True
            return redirect(url_for('index'))
        err = 'Invalid password'
    return render_template('login.html', error=err)

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

# ══════════════════════════════════════════════════════
#   DB HELPER — read only via SQLite URI
# ══════════════════════════════════════════════════════
def dbq(sql, args=(), fetch_all=False, fetch_one=False):
    try:
        conn = sqlite3.connect(DB_FILE, timeout=5)
        conn.execute("PRAGMA query_only = ON")   # read-only enforced in-session
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
    except Exception as e:
        app.logger.error(f"DB error: {e} | SQL: {sql}")
        return None

# ══════════════════════════════════════════════════════
#   UTILITIES
# ══════════════════════════════════════════════════════
def port_open(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.0)
    try:
        return s.connect_ex(('127.0.0.1', int(port))) == 0
    except:
        return False
    finally:
        try: s.close()
        except: pass

def systemd_active(name):
    try:
        r = subprocess.run(['systemctl', 'is-active', name],
                           capture_output=True, timeout=3)
        return r.stdout.strip() == b'active'
    except:
        return False

def tail_file(path, n=300):
    try:
        r = subprocess.run(['tail', '-n', str(n), path],
                           capture_output=True, text=True, timeout=5)
        return r.stdout
    except:
        try:
            with open(path, 'r', errors='replace') as f:
                lines = f.readlines()
            return ''.join(lines[-n:])
        except:
            return ''

def get_uptime():
    if HAS_PSUTIL:
        try:
            boot  = datetime.datetime.fromtimestamp(psutil.boot_time())
            delta = datetime.datetime.now() - boot
            d = delta.days
            h = delta.seconds // 3600
            m = (delta.seconds % 3600) // 60
            return f"{d}d {h}h {m}m"
        except: pass
    try:
        with open('/proc/uptime') as f:
            secs = float(f.read().split()[0])
        return f"{int(secs//86400)}d {int((secs%86400)//3600)}h {int((secs%3600)//60)}m"
    except:
        return 'N/A'

def disk_info(path):
    try:
        u = os.statvfs(path)
        total = u.f_frsize * u.f_blocks / 1024**3
        free  = u.f_frsize * u.f_bfree  / 1024**3
        used  = total - free
        pct   = round(used / total * 100, 1) if total > 0 else 0
        return {'path': path, 'used': round(used, 1), 'total': round(total, 1),
                'free': round(free, 1), 'pct': pct}
    except:
        return None

def ping_ok(host):
    return subprocess.call(['ping', '-c', '1', '-W', '2', host],
                           stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL) == 0

# ══════════════════════════════════════════════════════
#   API /api/overview
# ══════════════════════════════════════════════════════
@app.route('/api/overview')
@auth_required
def api_overview():
    svcs = dbq('SELECT * FROM services ORDER BY name', fetch_all=True) or []
    svc_list = []
    for s in svcs:
        online = systemd_active(s['name']) and port_open(s['port'])
        svc_list.append({
            'name':       s['name'],
            'port':       s['port'],
            'domain':     s['domain'],
            'status':     'online' if online else 'offline',
            'runtime':    s.get('runtime', 'python'),
            'workers':    s.get('workers', 0),
            'created_at': s.get('created_at', ''),
        })

    cpu = ram = swap = None
    if HAS_PSUTIL:
        try:
            cpu  = psutil.cpu_percent(interval=0.3)
            mem  = psutil.virtual_memory()
            ram  = {'used': round(mem.used/1024**3, 2),
                    'total': round(mem.total/1024**3, 2),
                    'pct':   round(mem.percent, 1)}
            swp  = psutil.swap_memory()
            swap = {'used': round(swp.used/1024**2),
                    'total': round(swp.total/1024**2),
                    'pct':   round(swp.percent, 1)}
        except: pass

    try:    load = [round(x, 2) for x in os.getloadavg()]
    except: load = [0, 0, 0]

    db_stats = {}
    for t in ['services', 'backups', 'deployments', 'metrics_history']:
        r = dbq(f'SELECT COUNT(*) as c FROM {t}', fetch_one=True)
        db_stats[t] = r['c'] if r else 0

    integrity = dbq('PRAGMA integrity_check', fetch_one=True)
    integrity_ok = bool(integrity and list(integrity.values())[0] == 'ok')

    online_count = sum(1 for s in svc_list if s['status'] == 'online')

    return jsonify({
        'services':     svc_list,
        'online':       online_count,
        'offline':      len(svc_list) - online_count,
        'total':        len(svc_list),
        'cpu':          cpu,
        'ram':          ram,
        'swap':         swap,
        'disk_root':    disk_info('/'),
        'disk_storage': disk_info('/opt/extra1_1tb'),
        'load':         load,
        'uptime':       get_uptime(),
        'internet':     ping_ok('1.1.1.1'),
        'dns':          ping_ok('github.com'),
        'cloudflare':   subprocess.call(['systemctl', 'is-active', '--quiet', 'cloudflared'],
                                        stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL) == 0,
        'db_stats':     db_stats,
        'db_integrity': integrity_ok,
        'timestamp':    datetime.datetime.now().strftime('%H:%M:%S'),
        'has_psutil':   HAS_PSUTIL,
    })

# ══════════════════════════════════════════════════════
#   API /api/logs
# ══════════════════════════════════════════════════════
@app.route('/api/logs')
@auth_required
def api_logs():
    t = request.args.get('type', 'ats')
    n = min(int(request.args.get('n', 300)), 1000)
    paths = {'ats': LOG_FILE, 'security': SEC_FILE, 'metrics': METRICS_FILE}
    content = tail_file(paths.get(t, LOG_FILE), n)
    return jsonify({'lines': content.splitlines(), 'type': t})

# ══════════════════════════════════════════════════════
#   API /api/audit
# ══════════════════════════════════════════════════════
@app.route('/api/audit')
@auth_required
def api_audit():
    n = min(int(request.args.get('n', 200)), 500)
    entries = []
    try:
        with open(AUDIT_FILE, 'r', errors='replace') as f:
            lines = f.readlines()
        for line in lines[-n:]:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except:
                entries.append({'timestamp': '', 'action': 'RAW', 'target': line,
                                'user': '', 'metadata': {}})
    except:
        pass
    entries.reverse()
    return jsonify({'entries': entries})

# ══════════════════════════════════════════════════════
#   API /api/database
# ══════════════════════════════════════════════════════
@app.route('/api/database')
@auth_required
def api_database():
    table = request.args.get('table', 'services')
    allowed = ['services', 'backups', 'deployments', 'metrics_history', 'remote_configs']
    if table not in allowed:
        return jsonify({'error': 'not allowed'}), 400
    limit = min(int(request.args.get('limit', 100)), 500)
    rows  = dbq(f'SELECT * FROM {table} ORDER BY rowid DESC LIMIT ?',
                (limit,), fetch_all=True) or []
    cols  = list(rows[0].keys()) if rows else []
    return jsonify({'table': table, 'columns': cols, 'rows': rows})

# ══════════════════════════════════════════════════════
#   API /api/stats  (per-service detail)
# ══════════════════════════════════════════════════════
@app.route('/api/stats')
@auth_required
def api_stats():
    svcs = dbq('SELECT * FROM services ORDER BY name', fetch_all=True) or []
    out  = []
    for s in svcs:
        nm = s['name']
        dep = dbq(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as ok "
            "FROM deployments WHERE service_name=?", (nm,), fetch_one=True
        ) or {'total': 0, 'ok': 0}

        last_dep = dbq(
            "SELECT status, duration_seconds, timestamp FROM deployments "
            "WHERE service_name=? ORDER BY timestamp DESC LIMIT 1", (nm,), fetch_one=True
        )
        bk = dbq("SELECT COUNT(*) as c FROM backups WHERE service_name=?",
                 (nm,), fetch_one=True) or {'c': 0}
        last_bk = dbq(
            "SELECT filename, size_bytes, timestamp FROM backups "
            "WHERE service_name=? ORDER BY timestamp DESC LIMIT 1", (nm,), fetch_one=True
        )
        online = systemd_active(nm) and port_open(s['port'])
        total  = dep['total'] or 0
        ok     = dep['ok'] or 0

        out.append({
            'name':         nm,
            'port':         s['port'],
            'domain':       s['domain'],
            'runtime':      s.get('runtime', 'python'),
            'workers':      s.get('workers', 0),
            'memory_mb':    s.get('max_memory_mb', 512),
            'cpu_quota':    s.get('cpu_quota', 50),
            'branch':       s.get('branch', 'main'),
            'repo_url':     s.get('repo_url', ''),
            'status':       'online' if online else 'offline',
            'created_at':   s.get('created_at', ''),
            'deploy_total': total,
            'deploy_ok':    ok,
            'deploy_rate':  round(ok / total * 100, 1) if total > 0 else None,
            'last_deploy':  last_dep,
            'backup_count': bk['c'],
            'last_backup':  last_bk,
        })
    return jsonify({'services': out})

# ══════════════════════════════════════════════════════
#   API /api/backups
# ══════════════════════════════════════════════════════
@app.route('/api/backups')
@auth_required
def api_backups():
    rows = dbq('SELECT * FROM backups ORDER BY timestamp DESC LIMIT 100',
               fetch_all=True) or []
    for r in rows:
        fp = os.path.join(BACKUP_DIR, r.get('filename', ''))
        r['file_exists'] = os.path.exists(fp)
        r['size_mb']     = round(r['size_bytes'] / 1024 / 1024, 2) if r.get('size_bytes') else 0
    return jsonify({'backups': rows})

@app.route('/debug')
def debug():
    import traceback
    try:
        conn = sqlite3.connect('/home/gaia/ats/ats.db', timeout=5)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute('SELECT name, port FROM services')
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
        return str(rows)
    except Exception as e:
        return traceback.format_exc()

# ══════════════════════════════════════════════════════
#   ENTRY POINT
# ══════════════════════════════════════════════════════
if __name__ == '__main__':
    try:
        from waitress import serve
        serve(app, host='127.0.0.1', port=9998, threads=4)
    except ImportError:
        app.run(host='127.0.0.1', port=9998)

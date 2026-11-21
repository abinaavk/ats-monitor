"""Persistent single-administrator device/session registry.

Browser metadata is descriptive only. Authentication requires random bearer
credentials, stored only as SHA-256 digests. No IP/fingerprint authentication.
"""
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from urllib.parse import urlsplit
from flask import current_app, g, jsonify, redirect, render_template, request, session
from werkzeug.security import check_password_hash, generate_password_hash

STANDARD_SECONDS = 600
TRUST_SECONDS = 30 * 86400
SESSION_COOKIE = 'ats_session'
DEVICE_COOKIE = 'ats_device'


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


@contextmanager
def database():
    conn = sqlite3.connect(current_app.config['ATS_SECURITY_DB'], timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute('PRAGMA foreign_keys=ON')
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def audit(db, action, device=None):
    db.execute('INSERT INTO security_audit(at,action,device_id,ip) VALUES(?,?,?,?)',
               (time.time(), action, device, request.remote_addr or 'Unavailable'))


def same_origin():
    origin = request.headers.get('Origin')
    # Never trust forwarded host/IP headers unless the operator configures a
    # trusted proxy upstream. ProxyFix is deliberately not installed here.
    expected_scheme = 'https' if current_app.config['SESSION_COOKIE_SECURE'] else request.scheme
    return request.headers.get('Sec-Fetch-Site') != 'cross-site' and (not origin or (urlsplit(origin).netloc == request.host and urlsplit(origin).scheme == expected_scheme))


def valid_session(token):
    if not isinstance(token, str) or len(token) > 200:
        return None
    with database() as db:
        row = db.execute('''SELECT s.*,d.trusted_until,d.revoked_at,d.name FROM auth_sessions s
            JOIN devices d ON d.id=s.device_id WHERE s.token_hash=?''', (digest(token),)).fetchone()
        if not row or row['revoked_at'] or row['revoked'] or row['expires_at'] <= time.time():
            return None
        return dict(row)


def socket_authorized(auth_id):
    """Check server state independently of the stale Socket.IO Flask snapshot."""
    if not auth_id:
        return False
    with database() as db:
        return bool(db.execute('''SELECT 1 FROM auth_sessions s JOIN devices d ON d.id=s.device_id
            WHERE s.token_hash=? AND s.revoked=0 AND d.revoked_at IS NULL AND s.expires_at>?''',
            (auth_id, time.time())).fetchone())


def metadata():
    ua = request.headers.get('User-Agent', '')[:512]
    os_name = next((name for pattern, name in [('Android','Android'),('iPhone|iPad','iOS / iPadOS'),('Windows','Windows'),('CrOS','ChromeOS'),('Macintosh','macOS'),('Linux','Linux')] if re.search(pattern, ua)), 'Unknown')
    browser = 'Unknown'
    for pattern, label in [(r'Edg/([\d.]+)','Edge'),(r'Firefox/([\d.]+)','Firefox'),(r'Chrome/([\d.]+)','Chrome'),(r'Version/([\d.]+).*Safari','Safari')]:
        match = re.search(pattern, ua)
        if match:
            browser = label + ' ' + match[1]
            break
    kind = 'Tablet' if re.search('iPad|Tablet', ua) else 'Mobile' if re.search('Mobile|Android|iPhone', ua) else 'Desktop' if ua else 'Unknown'
    return os_name, browser, kind, request.remote_addr or 'Unavailable'


def issue_session(db, device):
    token = secrets.token_urlsafe(32)
    now = time.time()
    expires = device['trusted_until'] if device['trusted_until'] and device['trusted_until'] > now else now + STANDARD_SECONDS
    db.execute('INSERT INTO auth_sessions(token_hash,device_id,created_at,expires_at) VALUES(?,?,?,?)',
               (digest(token), device['id'], now, expires))
    g.new_session = (token, expires)
    session.clear()
    session['authenticated'] = True  # compatibility for existing API modules
    session['auth_id'] = digest(token)
    return token


def init_app(app, legacy_password):
    path = app.config.get('ATS_SECURITY_DB') or os.environ.get('ATS_SECURITY_DB') or os.path.join(app.instance_path, 'security.sqlite3')
    path = os.path.abspath(path)
    app.config['ATS_SECURITY_DB'] = path
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    os.close(fd)
    os.chmod(path, 0o600)
    with app.app_context(), database() as db:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS security_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,credential_hash TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,os TEXT,browser TEXT,device_type TEXT,ip TEXT,first_login REAL,last_active REAL,
          trusted_until REAL,revoked_at REAL);
        CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),
          created_at REAL NOT NULL,expires_at REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS auth_device ON auth_sessions(device_id);
        CREATE TABLE IF NOT EXISTS security_audit(id INTEGER PRIMARY KEY,at REAL,action TEXT,device_id TEXT,ip TEXT);
        CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT,at REAL);
        PRAGMA user_version=1;
        ''')
        db.execute('INSERT OR IGNORE INTO security_meta VALUES(?,?)', ('secret_key', secrets.token_hex(32)))
        db.execute('INSERT OR IGNORE INTO security_meta VALUES(?,?)', ('password_hash', generate_password_hash(os.environ.get('ATS_ACCESS_PASSWORD', legacy_password))))
        db.execute('INSERT OR IGNORE INTO security_meta VALUES(?,?)', ('display_name','Administrator'))
        app.secret_key = os.environ.get('SECRET_KEY') or db.execute("SELECT value FROM security_meta WHERE key='secret_key'").fetchone()[0]
    app.config.update(SESSION_COOKIE_SECURE=os.environ.get('ATS_COOKIE_SECURE', 'true').lower() != 'false',
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', SESSION_REFRESH_EACH_REQUEST=False)
    if app.config.get('MAX_CONTENT_LENGTH') is None:
        app.config['MAX_CONTENT_LENGTH'] = 1024 * 1024
    app.extensions['device_security'] = {'socket_authorized': socket_authorized}

    def password_ok(value):
        if not isinstance(value,str) or len(value) > 1024:
            return False
        with database() as db:
            ip = request.remote_addr or 'unknown'
            now = time.time()
            db.execute('DELETE FROM login_attempts WHERE at<?', (now-900,))
            if db.execute('SELECT count(*) FROM login_attempts WHERE ip=?', (ip,)).fetchone()[0] >= 10:
                return False
            hashed = db.execute("SELECT value FROM security_meta WHERE key='password_hash'").fetchone()[0]
            ok = check_password_hash(hashed,value)
            if not ok:
                db.execute('INSERT INTO login_attempts VALUES(?,?)',(ip,now))
                audit(db,'authentication_failed')
            return ok

    def require_change():
        data = request.get_json(silent=True)
        if not same_origin() or not hmac.compare_digest(request.headers.get('X-CSRF-Token',''), digest('csrf:'+g.auth_token)):
            return None, (jsonify(error='Security token invalid. Refresh Settings and try again.'),403)
        if not isinstance(data,dict):
            return None,(jsonify(error='Expected a JSON object'),400)
        if not password_ok(data.get('password')):
            return None,(jsonify(error='Password incorrect or too many attempts. Try again later.'),403)
        return data,None

    @app.before_request
    def authenticate():
        g.auth = None
        g.auth_token = request.cookies.get(SESSION_COOKIE,'')
        token = request.cookies.get(DEVICE_COOKIE,'')
        row = valid_session(g.auth_token)
        with database() as db:
            device = db.execute('SELECT * FROM devices WHERE credential_hash=? AND revoked_at IS NULL',(digest(token),)).fetchone() if token else None
            if row and device and row['device_id'] == device['id']:
                g.auth = row
            elif device and device['trusted_until'] and device['trusted_until'] > time.time():
                g.auth_token = issue_session(db,device)
                g.auth = {'device_id':device['id'],'expires_at':device['trusted_until'],'trusted_until':device['trusted_until'],'token_hash':digest(g.auth_token)}
                audit(db,'trusted_authentication',device['id'])
            if g.auth:
                session['authenticated'] = True
                session['auth_id'] = digest(g.auth_token)
                if time.time()-device['last_active'] >= 30:
                    os_name,browser,kind,ip = metadata()
                    db.execute('UPDATE devices SET last_active=?,ip=?,os=?,browser=?,device_type=? WHERE id=?',(time.time(),ip,os_name,browser,kind,device['id']))
            else:
                session.pop('authenticated',None)
                session.pop('auth_id',None)
        public = request.endpoint in ('login','static','pwa_worker')
        if not g.auth and not public:
            return (jsonify(error='unauthorized'),401) if request.path.startswith('/api/') else redirect('/login')

    @app.after_request
    def security_headers(response):
        if request.endpoint != 'static':
            response.headers['Cache-Control']='no-store'
            response.headers['X-Content-Type-Options']='nosniff'
            response.headers['Referrer-Policy']='same-origin'
            response.headers['X-Frame-Options']='SAMEORIGIN'
        secure = app.config['SESSION_COOKIE_SECURE']
        if getattr(g,'new_device',None):
            response.set_cookie(DEVICE_COOKIE,g.new_device,max_age=TRUST_SECONDS,secure=secure,httponly=True,samesite='Lax')
        if getattr(g,'new_session',None):
            raw,expires = g.new_session
            response.set_cookie(SESSION_COOKIE,raw,max_age=max(0,int(expires-time.time())),secure=secure,httponly=True,samesite='Lax')
        if getattr(g,'clear_auth',False) or getattr(g,'clear_session',False):
            for name in ((SESSION_COOKIE,DEVICE_COOKIE) if getattr(g,'clear_auth',False) else (SESSION_COOKIE,)):
                response.delete_cookie(name,secure=secure,httponly=True,samesite='Lax')
        return response

    def login_form(error=None, status=200, *, renew=False):
        # Keep open tabs valid and give rejected submissions a usable retry form.
        if renew or not session.get('login_csrf'):
            session['login_csrf'] = secrets.token_urlsafe(32)
        return render_template('login.html', error=error), status

    @app.route('/login',methods=['GET','POST'])
    def login():
        if request.method == 'POST':
            expected = session.get('login_csrf','')
            if not same_origin() or not expected or not hmac.compare_digest(request.form.get('csrf_token',''),expected):
                return login_form('Sign-in form refreshed. Enter your password and try again.', 403, renew=True)
            if password_ok(request.form.get('password','')):
                with database() as db:
                    raw = request.cookies.get(DEVICE_COOKIE,'')
                    device = db.execute('SELECT * FROM devices WHERE credential_hash=? AND revoked_at IS NULL',(digest(raw),)).fetchone() if raw else None
                    if not device:
                        raw = secrets.token_urlsafe(32)
                        did = secrets.token_urlsafe(18)
                        os_name,browser,kind,ip = metadata()
                        db.execute('INSERT INTO devices(id,credential_hash,name,os,browser,device_type,ip,first_login,last_active) VALUES(?,?,?,?,?,?,?,?,?)',
                                   (did,digest(raw),browser.split(' ')[0]+' on '+os_name,os_name,browser,kind,ip,time.time(),time.time()))
                        device=db.execute('SELECT * FROM devices WHERE id=?',(did,)).fetchone()
                        audit(db,'device_registered',did)
                    # Reauthentication rotates the session; previously copied session tokens die.
                    db.execute('UPDATE auth_sessions SET revoked=1 WHERE device_id=?',(device['id'],))
                    issue_session(db,device)
                    audit(db,'password_login',device['id'])
                    g.new_device=raw
                return redirect('/')
            return login_form('Invalid password or too many attempts', 401)
        if g.auth:
            return redirect('/')
        return login_form()

    @app.route('/logout',methods=['GET','POST'])
    def logout():
        if not same_origin():
            return jsonify(error='Cross-site logout rejected'),403
        with database() as db:
            db.execute('UPDATE auth_sessions SET revoked=1 WHERE device_id=?',(g.auth['device_id'],))
            db.execute('UPDATE devices SET trusted_until=NULL WHERE id=?',(g.auth['device_id'],))
            audit(db,'logout',g.auth['device_id'])
        session.clear()
        g.clear_session=True
        return redirect('/login')

    @app.post('/api/session-keepalive')
    def keepalive():
        return jsonify(ok=True,expires_at=g.auth['expires_at'])

    @app.get('/api/auth/status')
    def auth_status():
        return jsonify(authenticated=True,trusted=bool(g.auth['trusted_until'] and g.auth['trusted_until']>time.time()),expires_at=g.auth['expires_at'])

    @app.route('/api/settings',methods=['GET','PATCH'])
    def settings():
        if request.method == 'PATCH':
            data,error=require_change()
            if error: return error
            name=data.get('display_name')
            if not isinstance(name,str) or not 1 <= len(name.strip()) <= 80:
                return jsonify(error='Display name must contain 1–80 characters'),400
            with database() as db:
                db.execute("UPDATE security_meta SET value=? WHERE key='display_name'",(name.strip(),))
                audit(db,'profile_updated',g.auth['device_id'])
        with database() as db:
            name=db.execute("SELECT value FROM security_meta WHERE key='display_name'").fetchone()[0]
        return jsonify(profile={'display_name':name},security={'standard_minutes':10,'trusted_days':30},csrf_token=digest('csrf:'+g.auth_token),current_device_id=g.auth['device_id'])

    @app.get('/api/settings/devices')
    def devices():
        with database() as db:
            rows=db.execute('''SELECT d.id,d.name,d.os,d.browser,d.device_type,d.ip,d.first_login,d.last_active,d.trusted_until,d.revoked_at,
                (SELECT count(*) FROM auth_sessions s WHERE s.device_id=d.id AND s.revoked=0 AND s.expires_at>?) AS active_sessions
                FROM devices d ORDER BY last_active DESC''',(time.time(),)).fetchall()
            entries=[dict(r) for r in db.execute('SELECT at,action,device_id,ip FROM security_audit ORDER BY id DESC LIMIT 100')]
        result=[]
        for row in rows:
            item=dict(row); item.update(current=item['id']==g.auth['device_id'],mac=None,location=None)
            result.append(item)
        return jsonify(devices=result,audit=entries)

    @app.post('/api/settings/devices/<device_id>/<action>')
    def device_action(device_id,action):
        if action not in ('trust','untrust','revoke','logout'):
            return jsonify(error='Unknown action'),404
        data,error=require_change()
        if error: return error
        with database() as db:
            row=db.execute('SELECT * FROM devices WHERE id=?',(device_id,)).fetchone()
            if not row or row['revoked_at']:
                return jsonify(error='Device no longer registered'),404
            if action=='trust':
                # Remote trust changes require a device that has completed password registration.
                until=time.time()+TRUST_SECONDS
                db.execute('UPDATE devices SET trusted_until=? WHERE id=?',(until,device_id))
                # Extend only current active sessions; never resurrect revoked/expired sessions.
                db.execute('UPDATE auth_sessions SET expires_at=? WHERE device_id=? AND revoked=0 AND expires_at>?',(until,device_id,time.time()))
                if device_id==g.auth['device_id']:
                    g.new_session=(g.auth_token,until)
                    raw=request.cookies.get(DEVICE_COOKIE)
                    if raw:g.new_device=raw
            else:
                db.execute('UPDATE devices SET trusted_until=NULL,revoked_at=? WHERE id=?',(time.time() if action=='revoke' else None,device_id))
                db.execute('UPDATE auth_sessions SET revoked=1 WHERE device_id=?',(device_id,))
            audit(db,'device_'+action,device_id)
        if device_id==g.auth['device_id'] and action!='trust':
            session.clear()
            if action=='revoke':g.clear_auth=True
            else:g.clear_session=True
        return jsonify(ok=True,reauthenticate=device_id==g.auth['device_id'] and action!='trust')

    @app.post('/api/settings/password')
    def change_password():
        data,error=require_change()  # verifies the CSRF token, same origin and the CURRENT password
        if error: return error
        new=data.get('new_password')
        if not isinstance(new,str) or not 10 <= len(new) <= 1024:
            return jsonify(error='The new password must be 10–1024 characters long'),400
        if new == data.get('password'):
            return jsonify(error='Choose a password different from the current one'),400
        with database() as db:
            db.execute("UPDATE security_meta SET value=? WHERE key='password_hash'",(generate_password_hash(new),))
            # Everything signed in with the old password, except this device, must sign in again.
            db.execute('UPDATE auth_sessions SET revoked=1 WHERE device_id!=?',(g.auth['device_id'],))
            db.execute('UPDATE devices SET trusted_until=NULL WHERE id!=?',(g.auth['device_id'],))
            audit(db,'password_changed',g.auth['device_id'])
        return jsonify(ok=True)

    @app.post('/api/settings/logout-others')
    def logout_others():
        data,error=require_change()
        if error:return error
        with database() as db:
            db.execute('UPDATE auth_sessions SET revoked=1 WHERE device_id!=?',(g.auth['device_id'],))
            db.execute('UPDATE devices SET trusted_until=NULL WHERE id!=?',(g.auth['device_id'],))
            audit(db,'logout_other_devices',g.auth['device_id'])
        return jsonify(ok=True)

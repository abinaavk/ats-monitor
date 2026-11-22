"""The Local terminal exactly as a configured Local Monitor serves it: registry present, browser sends ?server=<local id>.

Real gunicorn + gevent + Socket.IO + bash, over both transports. Needs psutil, requests, python-socketio[client] and
websocket-client, plus an ATS checkout (ATS_MODULE_DIR, default ../ats). Starts nothing outside a temporary directory.
Exit status: 0 all checks passed, 1 a check failed, 77 skipped because a dependency is missing.

    PYTHONPATH=. python3 tests/local_terminal_integration.py
"""
import os, re, shutil, socket, subprocess, sys, tempfile, time
from pathlib import Path
try:
    import psutil, requests, socketio
except ImportError as missing:
    print(f'SKIPPED: {missing.name} is not installed'); sys.exit(77)
repo = str(Path(__file__).resolve().parents[1])
ats = os.environ.get('ATS_MODULE_DIR') or str(Path(repo).parent / 'ats')
if not (Path(ats) / 'ats_cluster.py').is_file():
    print(f'SKIPPED: no ATS checkout at {ats}; set ATS_MODULE_DIR'); sys.exit(77)
sys.path.insert(0, ats); import ats_cluster
tmp = tempfile.mkdtemp(prefix='ats-local-terminal-'); db = tmp + '/c.db'
store = ats_cluster.Store(db); lid = store.configure('local', 'Primary', webhook='hooks.example.com')['id']
s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close(); url = f'http://127.0.0.1:{port}'
log = open(tmp + '/monitor.log', 'w')
proc = subprocess.Popen([sys.executable, '-m', 'gunicorn', '--config', 'gunicorn.conf.py', '--graceful-timeout', '2', 'app:app'], cwd=repo, stdout=log, stderr=log,
    env=dict(os.environ, ATS_CLUSTER_DB=db, ATS_MODULE_DIR=ats, ATS_HOME=tmp + '/home', MONITOR_BIND=f'127.0.0.1:{port}', ATS_COOKIE_SECURE='false',
             ATS_SECURITY_DB=tmp + '/sec.db', ATS_ACCESS_PASSWORD='pw', GUNICORN_WORKER='gevent'))
failures = []
def check(ok, msg):
    print(('PASS ' if ok else 'FAIL ') + msg, flush=True)
    if not ok: failures.append(msg)
def wait(cond, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        if cond(): return True
        time.sleep(0.05)
    return False
def shells():
    try: return [c for c in psutil.Process(proc.pid).children(recursive=True) if c.name() == 'bash']
    except psutil.Error: return []
try:
    for _ in range(200):
        try: requests.get(url + '/login', timeout=1); break
        except requests.RequestException: time.sleep(0.1)
    def session():
        http = requests.Session(); form = http.get(url + '/login').text
        http.post(url + '/login', data={'password': 'pw', 'csrf_token': re.search(r'name="csrf_token" value="([^"]+)"', form)[1]}); return http
    def connect(transport, target):
        out, exits = [], []
        c = socketio.Client(http_session=session())
        c.on('terminal_output', lambda d: out.append(d), namespace='/terminal'); c.on('terminal_exit', lambda d: exits.append(d), namespace='/terminal')
        c.connect(f'{url}/?server={target}', namespaces=['/terminal'], transports=[transport]); return c, out, exits
    for transport in ('polling', 'websocket'):
        c, out, exits = connect(transport, lid); text = lambda: ''.join(out)
        c.emit('terminal_resize', {'rows': 31, 'cols': 93}, namespace='/terminal')
        c.emit('terminal_input', {'input': 'echo local-$((6*7)); whoami; stty size; echo $PPID\r'}, namespace='/terminal')
        check(wait(lambda: 'local-42' in text() and '31 93' in text()), f'{transport}: Local shell runs commands and honours resize (output: {text()[-120:]!r})')
        check(psutil.Process(proc.pid).username() in text(), f'{transport}: the shell runs as the Monitor user ({psutil.Process(proc.pid).username()})')
        c.emit('terminal_input', {'input': 'sleep 30\r'}, namespace='/terminal'); time.sleep(0.5)
        c.emit('terminal_input', {'input': '\x03'}, namespace='/terminal'); c.emit('terminal_input', {'input': 'echo int-$?\r'}, namespace='/terminal')
        check(wait(lambda: 'int-130' in text()), f'{transport}: Ctrl-C interrupts the running job')
        before = len(shells())
        c.emit('terminal_input', {'input': 'exit\r'}, namespace='/terminal')
        check(wait(lambda: exits), f'{transport}: exit ends the session'); c.disconnect()
    # closing the tab without typing exit must not leave a shell behind
    check(wait(lambda: len(shells()) == 0, 15), 'earlier sessions are fully cleaned up before the next check'); base = len(shells())
    c, out, exits = connect('websocket', lid); c.emit('terminal_input', {'input': 'echo up-$((1+1))\r'}, namespace='/terminal')
    check(wait(lambda: 'up-2' in ''.join(out)) and len(shells()) == base + 1, f'exactly one shell exists while the tab is open ({len(shells())} found)')
    c.disconnect(); check(wait(lambda: len(shells()) == base, 15), 'closing the tab ends the Local shell (no leftover process)')
    # an unknown target must never get a Local shell
    base = len(shells()); c, out, exits = connect('polling', 'f' * 32)
    check(wait(lambda: exits) and 'Unknown server' in ''.join(out) and len(shells()) == base, f'an unknown target is refused and gets no shell: {"".join(out).strip()!r}')
    c.disconnect()
    # anonymous connections are still rejected
    try:
        socketio.Client().connect(f'{url}/?server={lid}', namespaces=['/terminal']); check(False, 'anonymous connection must be rejected')
    except socketio.exceptions.ConnectionError: check(True, 'anonymous connection is rejected')
finally:
    proc.terminate(); proc.wait(10)
    shutil.rmtree(tmp, ignore_errors=True)
print('\nALL LOCAL TERMINAL CHECKS PASSED' if not failures else f'{len(failures)} FAILED')
sys.exit(1 if failures else 0)

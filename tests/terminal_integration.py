"""Real gevent + Socket.IO + Bash regression checks (no host operations).
Run with Python dependencies from requirements.txt plus requests/websocket-client.
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
import requests
import socketio

repo = str(Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]).resolve())
sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
log = tempfile.TemporaryFile(mode='w+')
proc = subprocess.Popen([sys.executable, '-c', f'import app; app.socketio.run(app.app,host="127.0.0.1",port={port})'], cwd=repo, env=dict(os.environ, ATS_HOME='/nonexistent-terminal-check'), stdout=log, stderr=log)
url = f'http://127.0.0.1:{port}'

def wait_for(condition, seconds=5):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if condition(): return
        time.sleep(.03)
    raise AssertionError('Timed out waiting for real shell response')

try:
    for _ in range(100):
        try: requests.get(url+'/login', timeout=1); break
        except requests.RequestException: time.sleep(.05)
    anon = socketio.Client()
    try:
        anon.connect(url, namespaces=['/terminal'])
        raise AssertionError('anonymous shell accepted')
    except socketio.exceptions.ConnectionError:
        pass
    finally:
        if anon.connected: anon.disconnect()
    print('PASS anonymous connection rejected')
    for transport in ['polling', 'websocket']:
        http = requests.Session(); http.post(url+'/login', data={'password':'abi@arv'})
        client = socketio.Client(http_session=http); output = []; exits = []
        client.on('terminal_output', lambda data: output.append(data), namespace='/terminal')
        client.on('terminal_exit', lambda data: exits.append(data), namespace='/terminal')
        client.connect(url, namespaces=['/terminal'], transports=[transport])
        client.emit('terminal_resize', {'rows':31, 'cols':93}, namespace='/terminal')
        client.emit('terminal_input', {'input':"printf 'REAL_%s\\n' SHELL; stty size; echo $$\r"}, namespace='/terminal')
        wait_for(lambda: 'REAL_SHELL' in ''.join(output) and '31 93' in ''.join(output))
        for invalid in [None, [], {'rows':'NaN'}, {'rows':-1,'cols':100000}]:
            client.emit('terminal_resize', invalid, namespace='/terminal')
            client.emit('terminal_input', invalid, namespace='/terminal')
        client.emit('terminal_input', {'input':r"printf '\342'; sleep .1; printf '\202\254\n'" + "\r"}, namespace='/terminal')
        wait_for(lambda: '€' in ''.join(output))
        client.emit('terminal_input', {'input':'exit\r'}, namespace='/terminal')
        wait_for(lambda: exits)
        client.disconnect()
        print(f'PASS {transport}: missing-home startup, command output, resize, invalid payloads, split UTF-8, shell exit')
    wait_for(lambda: not Path(f'/proc/{proc.pid}/task/{proc.pid}/children').read_text().strip())
    print('PASS shell processes reaped after exit; real terminal integration')
finally:
    proc.terminate(); proc.wait(timeout=5)
    log.seek(0); text=log.read()
    if 'Traceback' in text: print(text); raise AssertionError('server exception')

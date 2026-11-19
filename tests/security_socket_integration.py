"""Real Bash sockets stop on remote revocation and server-side expiry."""
import os,re,socket,sqlite3,subprocess,sys,tempfile,time
from pathlib import Path
import requests,socketio
repo=Path(__file__).resolve().parents[1]
tmp=tempfile.TemporaryDirectory(prefix='device-socket-');db=tmp.name+'/security.sqlite3'
s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
log=tempfile.TemporaryFile(mode='w+')
proc=subprocess.Popen([sys.executable,'-c',f'import app;app.socketio.run(app.app,host="127.0.0.1",port={port})'],cwd=repo,env=dict(os.environ,ATS_COOKIE_SECURE='false',ATS_SECURITY_DB=db,ATS_HOME=tmp.name),stdout=log,stderr=log)
base=f'http://127.0.0.1:{port}'
def wait(condition):
 until=time.monotonic()+8
 while time.monotonic()<until:
  if condition():return
  time.sleep(.03)
 raise AssertionError('Timed out')
def login():
 c=requests.Session();form=c.get(base+'/login').text;csrf=re.search(r'name="csrf_token" value="([^"]+)"',form)[1]
 assert c.post(base+'/login',data={'password':'abi@arv','csrf_token':csrf}).status_code==200
 return c
clients=[]
try:
 for _ in range(100):
  try:requests.get(base+'/login',timeout=.2);break
  except requests.RequestException:time.sleep(.05)
 a=login();b=login();aid=a.get(base+'/api/settings').json()['current_device_id']
 for transport,action in [('polling','revoke'),('websocket','expire')]:
  if action=='expire':a=login()
  client=socketio.Client(http_session=a);clients.append(client);output=[]
  client.on('terminal_output',lambda data:output.append(data),namespace='/terminal')
  client.connect(base,namespaces=['/terminal'],transports=[transport])
  client.emit('terminal_input',{'input':"printf 'SECURE_%s\\n' SHELL\r"},namespace='/terminal')
  wait(lambda:'SECURE_SHELL' in ''.join(output))
  if action=='revoke':
   csrf=b.get(base+'/api/settings').json()['csrf_token']
   assert b.post(base+'/api/settings/devices/'+aid+'/revoke',json={'password':'abi@arv'},headers={'X-CSRF-Token':csrf}).status_code==200
  else:
   with sqlite3.connect(db) as conn:conn.execute('UPDATE auth_sessions SET expires_at=? WHERE device_id=?',(time.time()-1,a.get(base+'/api/settings').json()['current_device_id']))
  wait(lambda:'/terminal' not in client.namespaces)
  assert a.get(base+'/api/settings').status_code==401
  assert b.get(base+'/api/settings').status_code==200
  wait(lambda:not Path(f'/proc/{proc.pid}/task/{proc.pid}/children').read_text().strip())
  client.disconnect()
  print('PASS',transport,action,'disconnect, old HTTP credentials denied, other device preserved, shell reaped',flush=True)
finally:
 for client in clients:
  if client.connected:client.disconnect()
 proc.terminate();proc.wait(timeout=5);log.seek(0);text=log.read();tmp.cleanup()
 if 'Traceback' in text:print(text);raise AssertionError('Server traceback')

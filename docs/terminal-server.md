# Terminal server deployment

The monitor uses Flask-SocketIO/gevent and keeps PTYs in process memory. Its
Gunicorn server must have **one WebSocket-capable gevent worker**. This worker
handles concurrent browser requests cooperatively; eight sync workers are not
a supported substitute.

Install requirements into the service virtualenv, then run from the repository:

```sh
venv/bin/gunicorn --config gunicorn.conf.py app:app
```

The config binds to `127.0.0.1:9998`. Set `MONITOR_BIND` if a different local
address/port is required. Keep the existing service user, working directory,
environment, resource limits and Cloudflare tunnel upstream.

For an existing ATS-generated systemd unit, replace its complete `ExecStart`
with the virtualenv Gunicorn executable, the **absolute** path to this config
and `app:app`. Remove the generated `--workers 8` and `--worker-class sync`
arguments: command-line options override the config. Set WorkingDirectory to
the repository. Review the actual unit with `systemctl cat <unit>` first; after
an approved change run daemon-reload and restart that unit. This interrupts
active shell sessions. Do not change other hosted services' worker counts.

ATS may regenerate the unit when saving resources or redeploying. Check and
reapply this monitor-specific startup command after those operations. The
repository merge alone does not rewrite or restart the installed unit.

Cloudflare must forward `/socket.io/` to this same server. Any additional proxy
must preserve WebSocket Upgrade/Connection headers and permit long-lived
connections. Do not cache Socket.IO requests.

## Verification

1. A polling handshake at `/socket.io/?EIO=4&transport=polling` returns an open
   packet. Its subsequent requests must not return `Invalid session`.
2. A WebSocket connection to the same path with `transport=websocket` returns
   HTTP 101, not HTTP 500.
3. Sign in, open Terminal and run a harmless print command. Verify output and
   connection stability for more than 45 seconds, then close the session.
4. Check Docker Shell too: it shares the same Socket.IO server.

Local integration: install `requirements.txt`, `requests` and `websocket-client`,
then run `python tests/terminal_integration.py --gunicorn --heartbeat`. This starts an
isolated server and disposable Bash shells without host service operations.

References: [Flask-SocketIO deployment](https://flask-socketio.readthedocs.io/en/latest/deployment.html)
and [Socket.IO session affinity](https://socket.io/docs/v4/using-multiple-nodes/).

"""Relay one browser terminal to an interactive session on a Global, over the signed request channel.

The browser keeps talking Socket.IO to this (Local) Monitor. For a remote target the Monitor opens a session
on the Global (``term.open``), long-polls its output (``term.read``) and forwards keystrokes (``term.input``)
and size changes (``term.resize``). Everything uses the same authenticated HTTPS route as other host calls.

Keystrokes and output are relayed in memory only: nothing is logged or stored. The relay stops when the
browser disconnects, the administrator signs out, or the Global ends the session.
"""
import base64
import codecs
import collections

from cluster_support import TransportError, remote

POLL_WAIT = 15            # seconds the Global holds a read open; below any proxy timeout
READ_TIMEOUT = POLL_WAIT + 15
MAX_BATCH = 48 * 1024
GENERIC = 'Global operation failed'


def offload(function, *args, **kwargs):
    """Run a blocking call without stalling the gevent event loop that serves every browser."""
    try:
        from gevent import get_hub
    except ImportError:
        return function(*args, **kwargs)
    return get_hub().threadpool.apply(function, args, kwargs)


def reason(exc):
    """Operator-facing text for a failure. Transport and Global messages are written by ATS and safe to show."""
    text = str(exc) if isinstance(exc, (TransportError, ValueError)) else ''
    if not text or GENERIC in text:
        return 'This Global could not run the terminal request. Update ATS on it (terminals need the current version) and run "server doctor" there.'
    return text


class Relay:
    def __init__(self, server, emit, finished, authorized, *, target='shell', container=None, spawn, sleep,
                 call=remote, run=offload):
        self.server, self.emit, self.finished, self.authorized = server, emit, finished, authorized
        self.target, self.container = target, container
        self.spawn, self.sleep, self.call, self.run = spawn, sleep, call, run
        self.sid = None
        self.closed = False
        self.ended = False
        self.pending = collections.deque()
        self.size = (24, 80)
        self.size_changed = False

    # ── called from the browser's socket handlers ──
    def start(self, rows=24, cols=80):
        self.size = (rows, cols)
        self.spawn(self._run)

    def write(self, text):
        if isinstance(text, str) and text and not self.closed:
            self.pending.append(text.encode('utf-8'))

    def resize(self, rows, cols):
        self.size, self.size_changed = (rows, cols), True

    def close(self):
        if self.closed:
            return
        self.closed = True
        sid, server = self.sid, self.server

        def tell_global():
            try:
                self.run(self.call, server, {'kind': 'term.close', 'sid': sid}, timeout=10)
            except (TransportError, ValueError, OSError):
                pass   # the Global also closes idle sessions on its own
        if sid:
            self.spawn(tell_global)

    # ── background loops ──
    def _say(self, message):
        self.emit(f'\r\n[{message}]\r\n')

    def _end(self, message=None):
        if self.ended:
            return
        self.ended = True
        if message:
            self._say(message)
        self.finished()

    def _run(self):
        rows, cols = self.size
        payload = {'kind': 'term.open', 'rows': rows, 'cols': cols, 'target': self.target}
        if self.container:
            payload['container'] = self.container
        try:
            self.sid = self.run(self.call, self.server, payload, timeout=20)['sid']
        except (TransportError, ValueError, OSError, KeyError) as exc:
            self._end('Could not open a terminal on ' + self.server['name'] + ': ' + reason(exc))
            return
        if self.closed:
            self.close_after_late_open()
            return
        self.spawn(self._writer)
        decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
        since, failures = 0, 0
        while not self.closed:
            if not self.authorized():
                self._end('Signed out; the terminal was closed')
                break
            try:
                result = self.run(self.call, self.server, {'kind': 'term.read', 'sid': self.sid, 'since': since, 'wait': POLL_WAIT},
                                  timeout=READ_TIMEOUT)
                failures = 0
            except (TransportError, ValueError, OSError) as exc:
                if self.closed:
                    break
                failures += 1
                if 'no longer exists' in str(exc) or failures > 4:
                    self._end('Lost the terminal on ' + self.server['name'] + ': ' + reason(exc))
                    break
                self.sleep(min(2 ** failures, 8))       # transient network trouble: the Global kept our output
                continue
            try:
                chunk = base64.b64decode(result.get('data', ''))
            except ValueError:
                self._end('The Global sent an invalid terminal response')
                break
            if result.get('lost'):
                self.emit('\r\n[some output was missed]\r\n')
            text = decoder.decode(chunk)
            if text:
                self.emit(text)
            since = result.get('next', since)
            if result.get('exited'):
                tail = decoder.decode(b'', final=True)
                if tail:
                    self.emit(tail)
                self._end('Session ended')
                break
        if self.closed and not self.ended:
            self.ended = True

    def close_after_late_open(self):
        self.closed = False
        self.close()

    def _writer(self):
        while not self.closed and not self.ended:
            sent = False
            if self.pending:
                data = bytearray()
                while self.pending and len(data) + len(self.pending[0]) <= MAX_BATCH:
                    data += self.pending.popleft()
                if not data:                      # a single oversized item: send its first slice
                    data = bytearray(self.pending.popleft()[:MAX_BATCH])
                try:
                    self.run(self.call, self.server, {'kind': 'term.input', 'sid': self.sid, 'data': base64.b64encode(bytes(data)).decode()},
                             timeout=15)
                except (TransportError, ValueError, OSError) as exc:
                    if not self.closed:
                        self._say('Input was not delivered: ' + reason(exc))
                sent = True
            if self.size_changed and not self.closed:
                self.size_changed = False
                rows, cols = self.size
                try:
                    self.run(self.call, self.server, {'kind': 'term.resize', 'sid': self.sid, 'rows': rows, 'cols': cols}, timeout=10)
                except (TransportError, ValueError, OSError):
                    pass
                sent = True
            if not sent:
                self.sleep(0.02)


MAX_RELAYS = 6


def attach(socketio, sessions, sid, server_id, auth_id, *, namespace, output_event, exit_event, authorized,
           target='shell', container=None, rows=24, cols=80):
    """Bind a browser socket to a session on the Global `server_id`; every failure is shown in the terminal itself."""
    from cluster_support import Store, registry

    def emit(text):
        socketio.emit(output_event, text, namespace=namespace, to=sid)

    def finished():
        socketio.emit(exit_event, {}, namespace=namespace, to=sid)
        sessions.pop(sid, None)

    def refuse(message):
        def tell():
            emit(f'\r\n[{message}]\r\n')
            socketio.emit(exit_event, {}, namespace=namespace, to=sid)
        socketio.start_background_task(tell)

    try:
        store = registry(Store)
        server = store.server(server_id) if store else None
    except Exception:
        server = None
    if not server or server['local']:
        return refuse('Unknown server: no terminal was opened')
    if not server['secret'] or not server['connected']:
        return refuse(f"{server['name']} is disconnected or revoked: reconnect it in Settings → Servers")
    if sum(1 for item in sessions.values() if item.get('relay')) >= MAX_RELAYS:
        return refuse('Too many remote terminals are open; close one first')
    relay = Relay(server, emit, finished, authorized, target=target, container=container,
                  spawn=socketio.start_background_task, sleep=socketio.sleep)
    sessions[sid] = {'relay': relay, 'auth_id': auth_id}
    relay.start(rows, cols)
    return relay

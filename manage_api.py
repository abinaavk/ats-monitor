"""Manage API for ATS Monitor: a thin bridge to the `ats` CLI headless mode.

The monitor never re-implements ats logic. It validates the *shape* of the
input, runs `<ATS_CLI> --api <op>` with the arguments as JSON on stdin, parses
the NDJSON the CLI prints and relays the result. See docs/manage.md.

Safety rules kept throughout this module:
  * subprocesses are always started with an argument list, never a shell;
  * the only thing that ever reaches argv is the fixed `--api <op>` pair, where
    <op> is a literal from this file; user data travels as JSON on stdin;
  * every identifier is validated against a strict pattern before use;
  * state-changing requests need `X-Requested-With: ats-monitor` (same CSRF
    guard as docker_api.py); session auth is the app-wide check in app.py.

Long operations (deploy, update, backups, ...) run as detached jobs
(`start_new_session=True`) whose output goes straight to a file under
ATS_MONITOR_JOBS_DIR, so they survive a monitor restart and any worker change.
No threads are used: status is derived by reading the files on each poll.
"""
import fcntl
import json
import os
import re
import shlex
import subprocess
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request

bp = Blueprint('manage_api', __name__, url_prefix='/api/manage')

DEFAULT_ATS_CLI = 'sudo -n python3 /home/gaia/ats/app.py'
SYNC_TIMEOUT = 60
JOB_TTL = 24 * 3600
JOB_LIST_LIMIT = 30
MAX_BODY = 256 * 1024
MAX_LOG_BYTES = 4 * 1024 * 1024
MAX_POLL_LINES = 2000

# ── validation tables (mirror the ats rules, spec section 2/3) ────────────
NAME_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
ENV_KEY_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,127}$')
HOST_RE = re.compile(r'^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$', re.I)
BRANCH_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$')
FILENAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$')
BACKUP_ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$')
UNIT_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$')
JOB_ID_RE = re.compile(r'^[0-9a-f]{16}$')
REPO_RE = re.compile(r'^(?:https://|git@)[^\s\x00-\x1f\x7f]{1,2040}$')

RUNTIMES = ('python', 'node', 'docker')
ACTIONS = ('start', 'stop', 'restart', 'update', 'reinstall_deps', 'rebuild')
JOB_ACTIONS = ('update', 'reinstall_deps', 'rebuild')
LOG_SOURCES = ('stdout', 'stderr', 'access', 'error', 'journal')
BACKUP_SOURCES = ('local', 'gdrive')

RANGES = {
    'port': (1, 65535),
    'container_port': (1, 65535),
    'workers': (1, 32),
    'max_memory_mb': (64, 65536),
    'cpu_quota': (5, 800),
}
DEPLOY_KEYS = {'name', 'domain', 'port', 'repo_url', 'branch', 'runtime', 'storage_root', 'workers',
               'max_memory_mb', 'cpu_quota', 'container_port', 'env', 'auto_update'}
PATCH_KEYS = {'domain', 'port', 'branch', 'repo_url', 'workers', 'max_memory_mb', 'cpu_quota',
              'container_port', 'env', 'auto_update'}
DEFAULTS_KEYS = {'runtime', 'branch', 'workers', 'max_memory_mb', 'cpu_quota', 'container_port'}
SETTINGS_KEYS = {'storage_root', 'domains', 'main_domain', 'defaults', 'cloudflare_config', 'cloudflared_service'}
SETTINGS_READONLY = {'service_user', 'ats_home', 'webhook', 'gdrive', 'limits'}

HTTP_STATUS = {
    'validation': 400, 'forbidden': 403, 'notfound': 404, 'conflict': 409, 'busy': 409,
    'unsupported': 422, 'not_configured': 503, 'unreachable': 503, 'failed': 500,
}

_CRED_RE = re.compile(r'(https?://)[^/\s@]+@')


# ── helpers ────────────────────────────────────────────────────────────────
class ApiError(Exception):
    def __init__(self, error, code='validation', **extra):
        super().__init__(error)
        self.error = error
        self.code = code
        self.extra = extra


def _fail(error, code='validation', status=None, **extra):
    body = {'ok': False, 'error': error, 'code': code}
    body.update(extra)
    return jsonify(body), status or HTTP_STATUS.get(code, 500)


def _ok(data=None, status=200):
    return jsonify({'ok': True, 'data': data if data is not None else {}}), status


@bp.errorhandler(ApiError)
def _on_api_error(e):
    return _fail(e.error, e.code, **e.extra)


def _redact(s):
    """Never echo URL credentials, even if a CLI line contains one."""
    return _CRED_RE.sub(r'\1***@', s) if isinstance(s, str) else s


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def ats_command():
    raw = os.environ.get('ATS_CLI') or DEFAULT_ATS_CLI
    try:
        argv = shlex.split(raw)
    except ValueError:
        argv = []
    return raw, argv


@bp.before_request
def _guard():
    if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        if request.headers.get('X-Requested-With') != 'ats-monitor':
            return _fail('missing X-Requested-With header', 'forbidden')
    if request.content_length and request.content_length > MAX_BODY:
        return _fail('request body too large', 'validation', 413)


def _body():
    if not request.data:
        return {}
    d = request.get_json(silent=True, force=True)
    if not isinstance(d, dict):
        raise ApiError('request body must be a JSON object')
    return d


def _name(value, field='name'):
    if not isinstance(value, str) or not NAME_RE.match(value):
        raise ApiError(f'{field} must match [A-Za-z0-9_-], 1-64 characters')
    return value


def _int(value, field, lo=None, hi=None):
    if isinstance(value, bool):
        raise ApiError(f'{field} must be an integer')
    if isinstance(value, str) and re.fullmatch(r'\d{1,9}', value.strip()):
        value = int(value.strip())
    if not isinstance(value, int):
        raise ApiError(f'{field} must be an integer')
    lo, hi = (lo, hi) if lo is not None else RANGES.get(field, (None, None))
    if lo is not None and not (lo <= value <= hi):
        raise ApiError(f'{field} must be between {lo} and {hi}')
    return value


def _bool(value, field):
    if not isinstance(value, bool):
        raise ApiError(f'{field} must be true or false')
    return value


def _host(value, field='domain'):
    if not isinstance(value, str) or not HOST_RE.match(value.strip()):
        raise ApiError(f'{field} must be a valid hostname such as app.example.com')
    return value.strip().lower()


def _repo(value):
    if not isinstance(value, str) or not REPO_RE.match(value.strip()):
        raise ApiError('repo_url must start with https:// or git@ and contain no spaces')
    return value.strip()


def _branch(value):
    if not isinstance(value, str) or not BRANCH_RE.match(value) or '..' in value or value.endswith(('/', '.lock')):
        raise ApiError('branch contains characters that are not allowed')
    return value


def _runtime(value, field='runtime'):
    if value not in RUNTIMES:
        raise ApiError(f'{field} must be one of: ' + ', '.join(RUNTIMES))
    return value


def _abs_path(value, field):
    if (not isinstance(value, str) or not value.startswith('/') or len(value) > 255
            or '\x00' in value or '\n' in value or '\r' in value
            or any(seg == '..' for seg in value.split('/'))):
        raise ApiError(f'{field} must be an absolute path without ".." segments')
    return value


def _env(value):
    if not isinstance(value, dict):
        raise ApiError('env must be an object of KEY: value strings')
    if len(value) > 200:
        raise ApiError('env has too many entries (max 200)')
    out = {}
    for k, v in value.items():
        if not isinstance(k, str) or not ENV_KEY_RE.match(k):
            raise ApiError(f'env key {str(k)[:40]!r} must match [A-Za-z_][A-Za-z0-9_]*')
        if not isinstance(v, str) or len(v) > 4096 or any(c in v for c in '\x00\r\n'):
            raise ApiError(f'env value for {k} must be a single-line string (max 4096 characters)')
        out[k] = v
    return out


def _resource_fields(src, out, keys):
    for k in keys:
        if k in src:
            out[k] = _int(src[k], k)


def _reject_unknown(src, allowed, what):
    extra = sorted(set(src) - allowed)
    if extra:
        raise ApiError(f'unknown {what} field: ' + ', '.join(str(x)[:40] for x in extra))


def _validate_deploy(src):
    _reject_unknown(src, DEPLOY_KEYS, 'deploy')
    out = {'name': _name(src.get('name'))}
    if not src.get('repo_url'):
        raise ApiError('repo_url is required')
    out['repo_url'] = _repo(src['repo_url'])
    if not src.get('domain'):
        raise ApiError('domain is required')
    out['domain'] = _host(src['domain'])
    if src.get('port') not in (None, ''):
        out['port'] = _int(src['port'], 'port')
    if src.get('branch') not in (None, ''):
        out['branch'] = _branch(src['branch'])
    if src.get('runtime') not in (None, ''):
        out['runtime'] = _runtime(src['runtime'])
    if src.get('storage_root') not in (None, ''):
        out['storage_root'] = _abs_path(src['storage_root'], 'storage_root')
    _resource_fields(src, out, ('workers', 'max_memory_mb', 'cpu_quota', 'container_port'))
    if 'env' in src:
        out['env'] = _env(src['env'])
    if 'auto_update' in src:
        out['auto_update'] = _bool(src['auto_update'], 'auto_update')
    return out


def _validate_patch(src):
    if 'runtime' in src:
        raise ApiError('runtime cannot be changed here; redeploy the service instead', 'unsupported')
    _reject_unknown(src, PATCH_KEYS, 'configuration')
    out = {}
    if 'domain' in src:
        out['domain'] = _host(src['domain'])
    if 'repo_url' in src:
        out['repo_url'] = _repo(src['repo_url'])
    if 'branch' in src:
        out['branch'] = _branch(src['branch'])
    _resource_fields(src, out, ('port', 'workers', 'max_memory_mb', 'cpu_quota', 'container_port'))
    if 'env' in src:
        out['env'] = _env(src['env'])
    if 'auto_update' in src:
        out['auto_update'] = _bool(src['auto_update'], 'auto_update')
    if not out:
        raise ApiError('nothing to change')
    return out


def _validate_settings(src):
    ro = sorted(set(src) & SETTINGS_READONLY)
    if ro:
        raise ApiError('read-only setting: ' + ', '.join(ro))
    _reject_unknown(src, SETTINGS_KEYS, 'setting')
    out = {}
    if 'storage_root' in src:
        out['storage_root'] = _abs_path(src['storage_root'], 'storage_root')
    if 'domains' in src:
        d = src['domains']
        if not isinstance(d, list) or len(d) > 50:
            raise ApiError('domains must be a list of at most 50 hostnames')
        hosts = [_host(x, 'domains entry') for x in d]
        if len(set(hosts)) != len(hosts):
            raise ApiError('domains contains duplicates')
        out['domains'] = hosts
    if 'main_domain' in src:
        out['main_domain'] = None if src['main_domain'] in (None, '') else _host(src['main_domain'], 'main_domain')
        if out['main_domain'] and 'domains' in out and out['main_domain'] not in out['domains']:
            raise ApiError('main_domain must be one of the saved domains')
    if 'defaults' in src:
        d = src['defaults']
        if not isinstance(d, dict):
            raise ApiError('defaults must be an object')
        _reject_unknown(d, DEFAULTS_KEYS, 'defaults')
        dd = {}
        if 'runtime' in d:
            dd['runtime'] = _runtime(d['runtime'], 'defaults.runtime')
        if 'branch' in d:
            dd['branch'] = _branch(d['branch'])
        _resource_fields(d, dd, ('workers', 'max_memory_mb', 'cpu_quota', 'container_port'))
        out['defaults'] = dd
    if 'cloudflare_config' in src:
        out['cloudflare_config'] = _abs_path(src['cloudflare_config'], 'cloudflare_config')
    if 'cloudflared_service' in src:
        v = src['cloudflared_service']
        if not isinstance(v, str) or not UNIT_RE.match(v):
            raise ApiError('cloudflared_service must be a systemd unit name')
        out['cloudflared_service'] = v
    if not out:
        raise ApiError('nothing to change')
    return out


# ── bridge to the ats CLI ──────────────────────────────────────────────────
def _tail(text, n=800):
    text = _redact((text or '').strip())
    return text[-n:]


def _parse_events(text):
    """NDJSON -> list of dict events. Non-JSON lines are ignored (ats must not print them)."""
    events = []
    for line in (text or '').splitlines():
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev, dict):
            events.append(ev)
    return events


def _final_result(events):
    for ev in reversed(events):
        if ev.get('t') == 'result':
            return ev
    return None


def _bridge_error(error, code='failed', **extra):
    raw, _ = ats_command()
    return ApiError(error, code, bridge=True, command=raw, **extra)


def ats_call(op, args=None, timeout=SYNC_TIMEOUT):
    """Run one ats op synchronously. Returns `data` or raises ApiError."""
    raw, argv = ats_command()
    if not argv:
        raise _bridge_error('ATS_CLI is empty or malformed', 'unreachable')
    payload = json.dumps(args or {})
    try:
        r = subprocess.run(argv + ['--api', op], input=payload, capture_output=True, text=True,
                           timeout=timeout)
    except subprocess.TimeoutExpired:
        raise _bridge_error(f'ats {op} timed out after {timeout}s')
    except (FileNotFoundError, PermissionError, OSError) as e:
        raise _bridge_error(f'ats CLI could not be started: {e.strerror or e}', 'unreachable')
    res = _final_result(_parse_events(r.stdout))
    if res is None:
        detail = _tail(r.stderr) or _tail(r.stdout)
        raise _bridge_error('ats CLI returned no result' + (f' (exit {r.returncode})' if r.returncode else ''),
                            detail=detail)
    if res.get('ok') and r.returncode:
        raise _bridge_error('ats CLI exited unsuccessfully after reporting success', detail=_tail(r.stderr) or f'exit {r.returncode}')
    if res.get('ok'):
        data = res.get('data')
        return data if data is not None else {}
    code = res.get('code') if res.get('code') in HTTP_STATUS else 'failed'
    raise ApiError(_redact(str(res.get('error') or 'operation failed')), code)


def _sync(op, args=None, timeout=SYNC_TIMEOUT):
    return _ok(ats_call(op, args, timeout))


# ── detached jobs ──────────────────────────────────────────────────────────
_procs = {}  # job id -> Popen, only to reap children started by this worker


def jobs_dir():
    base = os.environ.get('ATS_MONITOR_JOBS_DIR') or os.path.join(tempfile.gettempdir(), 'ats-monitor-jobs')
    for candidate in ([base] if os.environ.get('ATS_MONITOR_JOBS_DIR') else [base, f'{base}-{os.geteuid()}']):
        os.makedirs(candidate, mode=0o700, exist_ok=True)
        st = os.stat(candidate)
        if st.st_uid == os.geteuid():
            os.chmod(candidate, 0o700)
            return candidate
    raise ApiError('jobs directory is not owned by the monitor user', 'failed')


@contextmanager
def _jobs_lock():
    fd = os.open(os.path.join(jobs_dir(), '.lock'), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)  # closing releases the flock


def _job_path(job_id, *parts):
    return os.path.join(jobs_dir(), job_id, *parts)


def _write_json(path, obj):
    tmp = f'{path}.{os.getpid()}.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _read_meta(job_id):
    try:
        with open(_job_path(job_id, 'meta.json')) as f:
            m = json.load(f)
        return m if isinstance(m, dict) else None
    except (OSError, ValueError):
        return None


def _proc_state(pid, started_ticks=None):
    """Return True if pid is a live (non-zombie) process, and, when known, the same one we started."""
    try:
        with open(f'/proc/{int(pid)}/stat') as f:
            stat = f.read()
    except (OSError, ValueError, TypeError):
        return False
    fields = stat.rsplit(')', 1)[-1].split()
    if not fields or fields[0] in ('Z', 'X'):
        return False
    if started_ticks is not None:
        try:
            if int(fields[19]) != int(started_ticks):
                return False  # pid was recycled
        except (IndexError, ValueError):
            pass
    return True


def _start_ticks(pid):
    try:
        with open(f'/proc/{int(pid)}/stat') as f:
            return int(f.read().rsplit(')', 1)[-1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def _reap_children():
    for jid, p in list(_procs.items()):
        if p.poll() is not None:
            _procs.pop(jid, None)


def _read_log(job_id):
    """Bound displayed output while retaining a terminal result after large logs."""
    path = _job_path(job_id, 'log.ndjson')
    try:
        with open(path, 'rb') as f:
            size = os.fstat(f.fileno()).st_size
            data = f.read(MAX_LOG_BYTES)
            tail = b''
            if size > MAX_LOG_BYTES:
                f.seek(size - MAX_LOG_BYTES - 1)
                if f.read(1) != b'\n':
                    f.readline(MAX_LOG_BYTES)
                tail = f.read(MAX_LOG_BYTES)
    except OSError:
        return []
    text = data.decode('utf-8', 'replace')
    if size > MAX_LOG_BYTES:
        text = text.rsplit('\n', 1)[0]
    events = []
    for line in text.splitlines():
        if not line.strip(): continue
        try:
            ev = json.loads(line)
            if not isinstance(ev, dict): raise ValueError('Expected object')
        except ValueError:
            ev = {'t': 'log', 'm': line[:2000], 'lvl': 'warn'}
        if ev.get('t') == 'log': ev['m'] = _redact(str(ev.get('m', ''))[:8000])
        events.append(ev)
    if tail:
        result = None
        for line in tail.decode('utf-8', 'replace').splitlines():
            try: ev = json.loads(line)
            except ValueError: continue
            if isinstance(ev, dict) and ev.get('t') == 'result': result = ev
        if result is not None: events.append(result)
    return events


def _refresh(meta):
    """Settle a running job from its files. Idempotent and safe across workers."""
    if meta.get('status') != 'running':
        return meta
    jid = meta['id']
    _reap_children()
    alive = _proc_state(meta.get('pid'), meta.get('ticks'))
    res = _final_result(_read_log(jid))  # read after the liveness check: no lost-result race
    if res is None and alive:
        return meta
    if res is None:
        err = _tail(_read_text(_job_path(jid, 'stderr.log')))
        res = {'t': 'result', 'ok': False, 'code': 'failed',
               'error': 'ats process ended without a result' + (f': {err}' if err else '')}
    meta = dict(meta, status='done' if res.get('ok') else 'failed', finished=_now(), result=_clean_result(res))
    _write_json(_job_path(jid, 'meta.json'), meta)
    return meta


def _clean_result(res):
    out = {'ok': bool(res.get('ok'))}
    if res.get('ok'):
        out['data'] = res.get('data') if res.get('data') is not None else {}
    else:
        out['code'] = res.get('code') if res.get('code') in HTTP_STATUS else 'failed'
        out['error'] = _redact(str(res.get('error') or 'operation failed'))
    return out


def _read_text(path, limit=8000):
    try:
        with open(path, 'rb') as f:
            return f.read(limit).decode('utf-8', 'replace')
    except OSError:
        return ''


def _steps(events, failed):
    order, state = [], {}
    for ev in events:
        if ev.get('t') == 'step' and isinstance(ev.get('id'), str):
            if ev['id'] not in state:
                order.append(ev['id'])
            state[ev['id']] = ev.get('state') if ev.get('state') in ('start', 'done', 'fail') else 'start'
    out = []
    for sid in order:
        st = state[sid]
        if failed and st == 'start':
            st = 'fail'
        out.append({'id': sid, 'state': st})
    return out


def _reap_old_jobs():
    root = jobs_dir()
    cutoff = time.time() - JOB_TTL
    for entry in os.listdir(root):
        if not JOB_ID_RE.match(entry):
            continue
        d = os.path.join(root, entry)
        try:
            if os.path.getmtime(os.path.join(d, 'meta.json')) < cutoff and \
               os.path.getmtime(d) < cutoff:
                meta = _read_meta(entry)
                if meta and meta.get('status') == 'running' and _proc_state(meta.get('pid'), meta.get('ticks')):
                    continue
                for f in os.listdir(d):
                    os.unlink(os.path.join(d, f))
                os.rmdir(d)
        except OSError:
            continue


def start_job(op, name, args):
    """Spawn `<ATS_CLI> --api op` detached; returns the new job id. 409 if one is running for `name`."""
    raw, argv = ats_command()
    if not argv:
        raise _bridge_error('ATS_CLI is empty or malformed', 'unreachable')
    _reap_old_jobs()
    _reap_children()
    with _jobs_lock():
        for entry in os.listdir(jobs_dir()):
            if not JOB_ID_RE.match(entry):
                continue
            m = _read_meta(entry)
            if m and m.get('name') == name:
                m = _refresh(m)
                if m.get('status') == 'running':
                    raise ApiError(f'a job is already running for {name} ({m.get("op")})', 'busy', job_id=entry)
        jid = uuid.uuid4().hex[:16]
        d = _job_path(jid)
        os.makedirs(d, mode=0o700)
        args_path = os.path.join(d, 'args.json')
        fd = os.open(args_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(args, f)
        meta = {'id': jid, 'op': op, 'name': name, 'status': 'running', 'started': _now(),
                'finished': None, 'pid': None, 'ticks': None, 'result': None}
        try:
            with open(args_path, 'rb') as stdin, \
                 open(os.path.join(d, 'log.ndjson'), 'ab') as out, \
                 open(os.path.join(d, 'stderr.log'), 'ab') as err:
                proc = subprocess.Popen(argv + ['--api', op], stdin=stdin, stdout=out, stderr=err,
                                        close_fds=True, start_new_session=True)
        except (FileNotFoundError, PermissionError, OSError) as e:
            _write_json(os.path.join(d, 'meta.json'), dict(meta, status='failed', finished=_now(), result={
                'ok': False, 'code': 'unreachable', 'error': f'ats CLI could not be started: {e.strerror or e}'}))
            raise _bridge_error(f'ats CLI could not be started: {e.strerror or e}', 'unreachable')
        finally:
            try:
                os.unlink(args_path)  # the child holds its own fd; do not leave env/secrets on disk
            except OSError:
                pass
        _procs[jid] = proc
        meta['pid'] = proc.pid
        meta['ticks'] = _start_ticks(proc.pid)
        _write_json(os.path.join(d, 'meta.json'), meta)
    return jid


def _job_response(meta, since):
    meta = _refresh(meta)
    events = _read_log(meta['id'])
    window = events[since:since + MAX_POLL_LINES]
    failed = meta.get('status') == 'failed'
    return {'id': meta['id'], 'op': meta['op'], 'name': meta['name'], 'status': meta['status'],
            'started': meta['started'], 'finished': meta.get('finished'),
            'lines': window, 'next': since + len(window), 'steps': _steps(events, failed),
            'result': meta.get('result')}


def _job_accepted(jid, op, name):
    return _ok({'job_id': jid, 'op': op, 'name': name}, 202)


# ── settings, dependencies, helpers ────────────────────────────────────────
@bp.route('/settings', methods=['GET'])
def settings_get():
    return _sync('settings.get')


@bp.route('/settings', methods=['PUT'])
def settings_put():
    return _sync('settings.set', _validate_settings(_body()))


@bp.route('/dependencies')
def dependencies():
    deps = ats_call('system.dependencies')
    try:
        docker = ats_call('docker.info')
    except ApiError:
        docker = None
    return _ok({'dependencies': deps, 'docker': docker})


@bp.route('/domains/check')
def domains_check():
    return _sync('domains.check', {'domain': _host(request.args.get('domain', ''))})


@bp.route('/ports/suggest')
def ports_suggest():
    return _sync('ports.suggest')


# ── services ───────────────────────────────────────────────────────────────
@bp.route('/services', methods=['GET'])
def services_list():
    return _sync('services.list')


@bp.route('/services', methods=['POST'])
def services_deploy():
    args = _validate_deploy(_body())
    return _job_accepted(start_job('services.deploy', args['name'], args), 'services.deploy', args['name'])


@bp.route('/services/<name>', methods=['GET'])
def service_get(name):
    return _sync('services.get', {'name': _name(name)})


@bp.route('/services/<name>', methods=['PATCH'])
def service_patch(name):
    patch = _validate_patch(_body())
    return _sync('services.config.set', dict(patch, name=_name(name)))


@bp.route('/services/<name>', methods=['DELETE'])
def service_delete(name):
    name = _name(name)
    src = _body()
    _reject_unknown(src, {'confirm', 'delete_files', 'delete_backups', 'backup_first'}, 'delete')
    if src.get('confirm') != name:
        raise ApiError('type the service name to confirm deletion')
    args = {'name': name, 'confirm': name, 'delete_files': True, 'delete_backups': False, 'backup_first': False}
    for k in ('delete_files', 'delete_backups', 'backup_first'):
        if k in src:
            args[k] = _bool(src[k], k)
    if args['backup_first']:
        return _job_accepted(start_job('services.delete', name, args), 'services.delete', name)
    return _sync('services.delete', args, timeout=300)


@bp.route('/services/<name>/redeploy', methods=['POST'])
def service_redeploy(name):
    name = _name(name)
    src = _body()
    _reject_unknown(src, {'repo_url', 'branch'}, 'redeploy')
    if not src.get('repo_url'):
        raise ApiError('repo_url is required')
    args = {'name': name, 'repo_url': _repo(src['repo_url'])}
    if src.get('branch') not in (None, ''):
        args['branch'] = _branch(src['branch'])
    return _job_accepted(start_job('services.redeploy', name, args), 'services.redeploy', name)


@bp.route('/services/<name>/action', methods=['POST'])
def service_action(name):
    name = _name(name)
    src = _body()
    _reject_unknown(src, {'action'}, 'action')
    action = src.get('action')
    if action not in ACTIONS:
        raise ApiError('action must be one of: ' + ', '.join(ACTIONS))
    args = {'name': name, 'action': action}
    if action in JOB_ACTIONS:
        return _job_accepted(start_job('services.action', name, args), 'services.action', name)
    return _sync('services.action', args)


@bp.route('/services/<name>/logs', methods=['GET'])
def service_logs(name):
    name = _name(name)
    source = request.args.get('source', 'stdout')
    if source not in LOG_SOURCES:
        raise ApiError('source must be one of: ' + ', '.join(LOG_SOURCES))
    args = {'name': name, 'source': source, 'lines': _int(request.args.get('lines', '300'), 'lines', 1, 5000)}
    grep = request.args.get('grep', '')
    if len(grep) > 200 or '\x00' in grep:
        raise ApiError('grep filter is too long')
    if grep:
        args['grep'] = grep
    return _sync('services.logs', args)


@bp.route('/services/<name>/logs/clear', methods=['POST'])
def service_logs_clear(name):
    name = _name(name)
    source = _body().get('source')
    if source not in LOG_SOURCES or source == 'journal':
        raise ApiError('source must be one of: ' + ', '.join(s for s in LOG_SOURCES if s != 'journal'))
    return _sync('services.logs.clear', {'name': name, 'source': source})


@bp.route('/services/<name>/status')
def service_status(name):
    return _sync('services.status_text', {'name': _name(name)})


@bp.route('/services/<name>/resources')
def service_resources(name):
    return _sync('services.resources', {'name': _name(name)})


# ── backups ────────────────────────────────────────────────────────────────
@bp.route('/backups', methods=['GET'])
def backups_list():
    n = request.args.get('name')
    return _sync('backups.list', {'name': _name(n)} if n else {})


@bp.route('/backups', methods=['POST'])
def backups_create():
    src = _body()
    _reject_unknown(src, {'name', 'gdrive'}, 'backup')
    name = _name(src.get('name'))
    args = {'name': name, 'gdrive': _bool(src.get('gdrive', False), 'gdrive')}
    return _job_accepted(start_job('backups.create', name, args), 'backups.create', name)


@bp.route('/backups/restore', methods=['POST'])
def backups_restore():
    src = _body()
    _reject_unknown(src, {'name', 'filename', 'source'}, 'restore')
    name = _name(src.get('name'))
    if not isinstance(src.get('filename'), str) or not FILENAME_RE.match(src['filename']):
        raise ApiError('filename is not valid')
    if src.get('source') not in BACKUP_SOURCES:
        raise ApiError('source must be local or gdrive')
    args = {'name': name, 'filename': src['filename'], 'source': src['source']}
    return _job_accepted(start_job('backups.restore', name, args), 'backups.restore', name)


@bp.route('/backups', methods=['DELETE'])
def backups_delete():
    src = _body()
    _reject_unknown(src, {'id', 'filename', 'source'}, 'backup delete')
    if 'id' in src:
        bid = src['id']
        if isinstance(bid, bool) or not (isinstance(bid, int) or (isinstance(bid, str) and BACKUP_ID_RE.match(bid))):
            raise ApiError('id is not valid')
        return _sync('backups.delete', {'id': bid})
    if not isinstance(src.get('filename'), str) or not FILENAME_RE.match(src['filename']):
        raise ApiError('filename is not valid')
    if src.get('source') not in BACKUP_SOURCES:
        raise ApiError('source must be local or gdrive')
    return _sync('backups.delete', {'filename': src['filename'], 'source': src['source']})


# ── webhook ────────────────────────────────────────────────────────────────
@bp.route('/services/<name>/webhook', methods=['GET'])
def webhook_get(name):
    return _sync('webhook.get', {'name': _name(name)})


@bp.route('/services/<name>/webhook', methods=['POST'])
def webhook_set(name):
    name = _name(name)
    src = _body()
    _reject_unknown(src, {'auto_update', 'rotate_secret'}, 'webhook')
    args = {'name': name}
    for k in ('auto_update', 'rotate_secret'):
        if k in src:
            args[k] = _bool(src[k], k)
    if len(args) == 1:
        raise ApiError('nothing to change')
    return _sync('webhook.set', args)


@bp.route('/services/<name>/webhook/test', methods=['POST'])
def webhook_test(name):
    name = _name(name)
    return _job_accepted(start_job('webhook.test', name, {'name': name}), 'webhook.test', name)


# ── cloudflare ─────────────────────────────────────────────────────────────
@bp.route('/cloudflare', methods=['GET'])
def cloudflare_status():
    return _sync('cloudflare.status')


@bp.route('/cloudflare/sync', methods=['POST'])
def cloudflare_sync():
    src = _body()
    _reject_unknown(src, {'remove_orphans'}, 'sync')
    args = {'remove_orphans': _bool(src['remove_orphans'], 'remove_orphans')} if 'remove_orphans' in src else {}
    return _sync('cloudflare.sync', args, timeout=120)


@bp.route('/cloudflare/restart', methods=['POST'])
def cloudflare_restart():
    return _sync('cloudflare.restart', timeout=120)


# ── jobs ───────────────────────────────────────────────────────────────────
@bp.route('/jobs/<job_id>')
def job_get(job_id):
    if not JOB_ID_RE.match(job_id):
        raise ApiError('invalid job id')
    since = _int(request.args.get('since', '0'), 'since', 0, 10 ** 9)
    meta = _read_meta(job_id)
    if not meta:
        raise ApiError('job not found', 'notfound')
    return _ok(_job_response(meta, since))


@bp.route('/jobs')
def jobs_list():
    _reap_old_jobs()
    rows = []
    for entry in os.listdir(jobs_dir()):
        if JOB_ID_RE.match(entry):
            m = _read_meta(entry)
            if m:
                m = _refresh(m)
                rows.append({k: m.get(k) for k in ('id', 'op', 'name', 'status', 'started', 'finished')})
    rows.sort(key=lambda r: r.get('started') or '', reverse=True)
    return _ok({'jobs': rows[:JOB_LIST_LIMIT]})

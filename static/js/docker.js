'use strict';

// Docker tab. Relies on esc(), termPalette() and refreshActive() from main.js.

const dk = {
    pane: 'containers',
    containers: [],
    stats: {},
    project: '',
    query: '',
    available: true,
    busy: new Set(),
    logTimer: null,
    shell: { term: null, fit: null, sock: null, timer: null }
};

const $ = id => document.getElementById(id);

// ── API ────────────────────────────────────────────────────
async function dkApi(url, opts = {}) {
    const o = { method: 'GET', ...opts };
    if (o.method !== 'GET') {
        o.headers = { 'X-Requested-With': 'ats-monitor', ...(o.headers || {}) };
        if (o.json !== undefined) {
            o.headers['Content-Type'] = 'application/json';
            o.body = JSON.stringify(o.json);
        }
    }
    try {
        const r = await fetch(url, o);
        if (r.status === 401) { window.location.href = '/login'; return { ok: false, error: 'signed out' }; }
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return { ok: false, error: d.error || `HTTP ${r.status}` };
        return { ok: true, ...d };
    } catch (e) {
        return { ok: false, error: 'network error' };
    }
}

let toastTimer = null;
function toast(msg, bad) {
    const el = $('dkToast');
    el.textContent = msg;
    el.className = 'dk-toast' + (bad ? ' bad' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 7000 : 3000);
}

// ── POLLING ENTRY (called from refreshActive) ──────────────
async function fetchDocker() {
    const banner = $('dkBanner');
    const st = await dkApi('/api/docker/status');
    dk.available = !!st.available;
    if (!dk.available) {
        banner.hidden = false;
        banner.textContent = 'Docker is not reachable from the monitor: ' + (st.error || 'unknown error') +
            '. The app user needs access to the Docker socket (e.g. member of the "docker" group).';
        ['containers', 'images', 'volumes', 'networks'].forEach(k => { $('dkc-' + k).textContent = ''; });
        $('dkGrid').innerHTML = '<div class="empty-note">Docker unavailable.</div>';
        return;
    }
    banner.hidden = true;
    stamp();
    if (dk.pane === 'containers') await loadContainers();
    else if (dk.pane === 'images') await loadImages();
    else if (dk.pane === 'volumes') await loadVolumes();
    else if (dk.pane === 'networks') await loadNetworks();
}

// ── SUB-TABS ───────────────────────────────────────────────
document.querySelectorAll('.dk-tabs .dk-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        dk.pane = btn.dataset.dk;
        document.querySelectorAll('.dk-tabs .dk-tab').forEach(b => {
            b.classList.toggle('active', b === btn);
            b.setAttribute('aria-selected', String(b === btn));
        });
        document.querySelectorAll('.dk-pane').forEach(p => p.classList.toggle('active', p.id === 'dk-' + dk.pane));
        fetchDocker();
    });
});

// ── CONTAINERS ─────────────────────────────────────────────
async function loadContainers() {
    const [list, stats] = await Promise.all([dkApi('/api/docker/containers'), dkApi('/api/docker/stats')]);
    if (!list.ok) { $('dkGrid').innerHTML = `<div class="empty-note">${esc(list.error)}</div>`; return; }
    dk.containers = list.containers;
    dk.stats = stats.ok ? stats.stats : {};
    $('dkc-containers').textContent = dk.containers.length;
    renderChips();
    renderContainers();
}

function renderChips() {
    const counts = {};
    dk.containers.forEach(c => { const p = c.project || 'standalone'; counts[p] = (counts[p] || 0) + 1; });
    if (dk.project && !counts[dk.project]) dk.project = '';
    const chip = (key, label, n) =>
        `<button class="dk-chip${dk.project === key ? ' active' : ''}" data-project="${esc(key)}" aria-pressed="${dk.project === key}">${esc(label)} <b>${n}</b></button>`;
    $('dkChips').innerHTML = chip('', 'All', dk.containers.length) +
        Object.keys(counts).sort().map(p => chip(p, p, counts[p])).join('');
}

$('dkChips').addEventListener('click', e => {
    const b = e.target.closest('[data-project]');
    if (!b) return;
    dk.project = b.dataset.project;
    renderChips();
    renderContainers();
});

$('dkSearch').addEventListener('input', e => { dk.query = e.target.value.trim().toLowerCase(); renderContainers(); });
$('dkRefresh').addEventListener('click', () => fetchDocker());

function stateInfo(c) {
    const s = (c.state || '').toLowerCase();
    if (s === 'running') return ['running', 'Running'];
    if (s === 'paused') return ['paused', 'Paused'];
    if (s === 'restarting') return ['warn', 'Restarting'];
    if (s === 'created') return ['stopped', 'Created'];
    if (s === 'exited') return ['stopped', 'Exited'];
    return ['stopped', c.state || 'Unknown'];
}

function pctNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : Math.max(0, Math.min(100, n)); }

function statCell(label, val, pct) {
    const bar = pct == null ? '' : `<span class="dk-bar"><i class="${pct > 90 ? 'crit' : pct > 75 ? 'warn' : ''}" style="width:${pct}%"></i></span>`;
    return `<div><span class="dk-st-l">${label}</span><span class="dk-st-v">${esc(val)}</span>${bar}</div>`;
}

function containerCard(c) {
    const [cls, label] = stateInfo(c);
    const run = cls === 'running' || cls === 'warn';
    const paused = cls === 'paused';
    const s = dk.stats[c.id];
    const sub = c.project ? `${esc(c.project)} / ${esc(c.service || c.name)}` : 'standalone';
    const busy = dk.busy.has(c.id);
    const stats = (run || paused) && s
        ? `<div class="dk-stats">${statCell('CPU', s.cpu || '—', pctNum(s.cpu))}${statCell('Memory', s.mem_pct || '—', pctNum(s.mem_pct))}${statCell('Network', s.net || '—')}${statCell('PIDs', s.pids || '—')}</div>`
        : '';
    return `<article class="dk-card ${cls}${busy ? ' busy' : ''}" data-id="${esc(c.id)}">
        <header>
            <div class="dk-title"><h3>${esc(c.name)}</h3><div class="dk-sub">${sub}</div></div>
            <span class="dk-badge ${cls}">${busy ? 'Working…' : label}</span>
            <button class="dk-kebab" aria-label="Actions for ${esc(c.name)}" aria-haspopup="menu" aria-expanded="false" data-menu="${esc(c.id)}">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="3" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>
            </button>
        </header>
        <dl class="dk-meta">
            <dt>ID</dt><dd>${esc(c.id)}</dd>
            <dt>Image</dt><dd>${esc(c.image)}</dd>
            <dt>Command</dt><dd>${esc(c.command)}</dd>
            <dt>Created</dt><dd>${esc(c.created)}</dd>
            <dt>Status</dt><dd>${esc(c.status)}</dd>
            <dt>Ports</dt><dd>${esc(c.ports) || '—'}</dd>
        </dl>
        ${stats}
    </article>`;
}

function renderContainers() {
    if (document.querySelector('.dk-menu')) return; // don't yank an open menu away
    const q = dk.query;
    const rows = dk.containers.filter(c =>
        (!dk.project || (c.project || 'standalone') === dk.project) &&
        (!q || [c.name, c.image, c.id, c.ports, c.project, c.status].join(' ').toLowerCase().includes(q)));
    $('dkGrid').innerHTML = rows.length
        ? rows.map(containerCard).join('')
        : `<div class="empty-note">${dk.containers.length ? 'No containers match.' : 'No containers on this host.'}</div>`;
}

// ── ACTION MENU ────────────────────────────────────────────
function closeMenu(refocus) {
    const m = document.querySelector('.dk-menu');
    if (!m) return;
    const btn = document.querySelector(`.dk-kebab[aria-expanded="true"]`);
    m.remove();
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
}

function openMenu(btn) {
    closeMenu();
    const c = dk.containers.find(x => x.id === btn.dataset.menu);
    if (!c) return;
    const [cls] = stateInfo(c);
    const run = cls === 'running' || cls === 'warn';
    const items = [
        ['logs', 'Logs'], ['inspect', 'Inspect'],
        ...(run ? [['stop', 'Stop', 'bad'], ['restart', 'Restart', 'warn'], ['shell', 'Shell']]
                : cls === 'paused' ? [['unpause', 'Resume', 'ok']]
                : [['start', 'Start', 'ok']]),
        ...(run ? [['pause', 'Pause']] : []),
        ['remove', 'Remove', 'bad']
    ];
    const m = document.createElement('div');
    m.className = 'dk-menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = items.map(([k, l, t]) => `<button role="menuitem" class="${t || ''}" data-act="${k}" data-id="${esc(c.id)}">${l}</button>`).join('');
    btn.after(m);
    btn.setAttribute('aria-expanded', 'true');
    m.querySelector('button').focus();
}

document.addEventListener('click', e => {
    const kebab = e.target.closest('.dk-kebab');
    if (kebab) {
        e.stopPropagation();
        const open = kebab.getAttribute('aria-expanded') === 'true';
        open ? closeMenu() : openMenu(kebab);
        return;
    }
    const act = e.target.closest('.dk-menu [data-act]');
    if (act) {
        const { act: a, id } = act.dataset;
        closeMenu();
        containerAction(a, id);
        return;
    }
    if (!e.target.closest('.dk-menu')) closeMenu();
});

document.addEventListener('keydown', e => {
    const m = document.querySelector('.dk-menu');
    if (!m) return;
    const items = [...m.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') closeMenu();
});

async function containerAction(act, id) {
    const c = dk.containers.find(x => x.id === id);
    const name = c ? c.name : id;
    if (act === 'logs') return openLogs(id, name);
    if (act === 'inspect') return openInspect(id, name);
    if (act === 'shell') return openShell(id, name);
    if (act === 'remove') {
        const running = c && ['running', 'warn', 'paused'].includes(stateInfo(c)[0]);
        return confirmDialog(`Remove container "${name}"?`, 'This deletes the container. Volumes are kept.', running, async force => {
            await runOp(id, `Removed ${name}`, () => dkApi(`/api/docker/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}`, { method: 'DELETE' }));
        });
    }
    if (act === 'stop') {
        return confirmDialog(`Stop "${name}"?`, 'The container will receive SIGTERM, then SIGKILL after the grace period.', false, async () => {
            await runOp(id, `Stopped ${name}`, () => dkApi(`/api/docker/containers/${encodeURIComponent(id)}/stop`, { method: 'POST' }));
        }, 'Stop');
    }
    const past = { start: 'Started', restart: 'Restarted', pause: 'Paused', unpause: 'Resumed' }[act];
    await runOp(id, `${past} ${name}`, () => dkApi(`/api/docker/containers/${encodeURIComponent(id)}/${act}`, { method: 'POST' }));
}

async function runOp(id, okMsg, fn) {
    dk.busy.add(id);
    renderContainers();
    const r = await fn();
    dk.busy.delete(id);
    toast(r.ok ? okMsg : (r.error || 'Failed'), !r.ok);
    await loadContainers();
}

// ── DIALOG HELPERS ─────────────────────────────────────────
document.querySelectorAll('.dk-dialog').forEach(d => {
    d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) d.close(); });
});

function confirmDialog(title, msg, offerForce, onGo, verb) {
    $('dkConfirmTitle').textContent = title;
    $('dkConfirmMsg').textContent = msg;
    $('dkForceWrap').hidden = !offerForce;
    $('dkForce').checked = !!offerForce;
    const go = $('dkConfirmGo');
    go.textContent = verb || 'Remove';
    go.onclick = async () => { const f = $('dkForce').checked; $('dkConfirm').close(); await onGo(f); };
    $('dkConfirm').showModal();
}

// ── LOGS / INSPECT ─────────────────────────────────────────
function openText(title, tools) {
    $('dkTextTitle').textContent = title;
    $('dkTextTools').innerHTML = tools || '';
    $('dkTextBody').textContent = 'Loading…';
    $('dkText').showModal();
}
$('dkText').addEventListener('close', () => { clearInterval(dk.logTimer); dk.logTimer = null; });

async function openLogs(id, name) {
    openText(`Logs · ${name}`,
        `<select class="filter-input" id="dkTail" aria-label="Lines"><option>100</option><option selected>300</option><option>1000</option><option>5000</option></select>
         <label class="toggle-label"><input type="checkbox" id="dkFollow"><span>Follow</span></label>
         <button class="term-btn" id="dkLogCopy">Copy</button>`);
    const load = async () => {
        const body = $('dkTextBody');
        const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        const r = await dkApi(`/api/docker/containers/${encodeURIComponent(id)}/logs?tail=${$('dkTail').value}`);
        if (!$('dkText').open) return;
        body.textContent = r.ok ? (r.lines.join('\n') || '(no output)') : r.error;
        if (atEnd || body.dataset.first !== id) { body.scrollTop = body.scrollHeight; body.dataset.first = id; }
    };
    $('dkTextBody').dataset.first = '';
    $('dkTail').addEventListener('change', load);
    $('dkFollow').addEventListener('change', e => {
        clearInterval(dk.logTimer);
        dk.logTimer = e.target.checked ? setInterval(load, 3000) : null;
    });
    $('dkLogCopy').addEventListener('click', () => navigator.clipboard?.writeText($('dkTextBody').textContent).then(() => toast('Copied')));
    load();
}

async function openInspect(id, name) {
    openText(`Inspect · ${name}`, '<button class="term-btn" id="dkInspCopy">Copy JSON</button>');
    const r = await dkApi(`/api/docker/containers/${encodeURIComponent(id)}/inspect`);
    $('dkTextBody').textContent = r.ok ? JSON.stringify(r.data, null, 2) : r.error;
    $('dkInspCopy').addEventListener('click', () => navigator.clipboard?.writeText($('dkTextBody').textContent).then(() => toast('Copied')));
}

// ── CREATE ─────────────────────────────────────────────────
$('dkNew').addEventListener('click', () => {
    $('dkCreateForm').reset();
    $('dkCreateErr').hidden = true;
    $('dkCreate').showModal();
    $('dkCreateForm').elements.image.focus();
});

$('dkCreateForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target.elements;
    const lines = v => v.value.split('\n').map(s => s.trim()).filter(Boolean);
    const btn = $('dkCreateGo');
    btn.disabled = true; btn.textContent = 'Creating… (may pull image)';
    const r = await dkApi('/api/docker/containers', { method: 'POST', json: {
        image: f.image.value.trim(), name: f.name.value.trim(), restart: f.restart.value,
        ports: lines(f.ports), env: lines(f.env), volumes: lines(f.volumes)
    }});
    btn.disabled = false; btn.textContent = 'Create and start';
    if (!r.ok) { const el = $('dkCreateErr'); el.textContent = r.error; el.hidden = false; return; }
    $('dkCreate').close();
    toast('Container created');
    loadContainers();
});

// ── IMAGES / VOLUMES / NETWORKS ────────────────────────────
function delBtn(kind, id, label, disabled, why) {
    return `<button class="term-btn dk-del" data-del="${kind}" data-id="${esc(id)}" data-label="${esc(label)}" ${disabled ? `disabled title="${esc(why)}"` : ''}>Remove</button>`;
}

async function loadImages() {
    const r = await dkApi('/api/docker/images');
    if (!r.ok) { $('dkImages').innerHTML = `<tr><td colspan="6">${esc(r.error)}</td></tr>`; return; }
    $('dkc-images').textContent = r.images.length;
    $('dkImages').innerHTML = r.images.map(i => `<tr><td>${esc(i.repo)}</td><td>${esc(i.tag)}</td><td class="mono">${esc(i.id)}</td><td>${esc(i.size)}</td><td>${esc(i.created)}</td>
        <td class="dk-act">${i.in_use ? '<span class="dk-badge running">In use</span>' : ''}${delBtn('images', i.id, `${i.repo}:${i.tag}`, i.in_use, 'Used by a container')}</td></tr>`).join('')
        || '<tr><td colspan="6" class="empty-note">No images.</td></tr>';
}

async function loadVolumes() {
    const r = await dkApi('/api/docker/volumes');
    if (!r.ok) { $('dkVolumes').innerHTML = `<tr><td colspan="5">${esc(r.error)}</td></tr>`; return; }
    $('dkc-volumes').textContent = r.volumes.length;
    $('dkVolumes').innerHTML = r.volumes.map(v => `<tr><td class="mono">${esc(v.name)}</td><td>${esc(v.driver)}</td><td>${esc(v.scope)}</td>
        <td>${v.in_use ? '<span class="dk-badge running">In use</span>' : '<span class="dk-sub">unused</span>'}</td>
        <td class="dk-act">${delBtn('volumes', v.name, v.name, v.in_use, 'Mounted by a container')}</td></tr>`).join('')
        || '<tr><td colspan="5" class="empty-note">No volumes.</td></tr>';
}

async function loadNetworks() {
    const r = await dkApi('/api/docker/networks');
    if (!r.ok) { $('dkNetworks').innerHTML = `<tr><td colspan="5">${esc(r.error)}</td></tr>`; return; }
    $('dkc-networks').textContent = r.networks.length;
    $('dkNetworks').innerHTML = r.networks.map(n => `<tr><td>${esc(n.name)}</td><td class="mono">${esc(n.id)}</td><td>${esc(n.driver)}</td><td>${esc(n.scope)}</td>
        <td class="dk-act">${delBtn('networks', n.id, n.name, n.builtin, 'Built-in network')}</td></tr>`).join('')
        || '<tr><td colspan="5" class="empty-note">No networks.</td></tr>';
}

document.addEventListener('click', e => {
    const b = e.target.closest('.dk-del');
    if (!b || b.disabled) return;
    const { del, id, label } = b.dataset;
    confirmDialog(`Remove ${del.slice(0, -1)} "${label}"?`, 'This cannot be undone.', false, async () => {
        const r = await dkApi(`/api/docker/${del}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        toast(r.ok ? `Removed ${label}` : r.error, !r.ok);
        fetchDocker();
    });
});

async function pullImage() {
    const input = $('dkPullRef'), ref = input.value.trim();
    if (!ref) return;
    const btn = $('dkPull');
    btn.disabled = true; btn.textContent = 'Pulling…';
    const r = await dkApi('/api/docker/images/pull', { method: 'POST', json: { image: ref } });
    btn.disabled = false; btn.textContent = 'Pull';
    toast(r.ok ? `Pulled ${ref}` : r.error, !r.ok);
    if (r.ok) { input.value = ''; loadImages(); }
}
$('dkPull').addEventListener('click', pullImage);
$('dkPullRef').addEventListener('keydown', e => { if (e.key === 'Enter') pullImage(); });

// ── CONTAINER SHELL (docker exec -it over Socket.IO) ───────
const SHELL_IDLE = 10 * 60 * 1000;

function shellStatus(text, on) {
    const el = $('dkShellStatus');
    el.textContent = text;
    el.className = 'term-status' + (on ? ' connected' : '');
}

function shellTouch() {
    clearTimeout(dk.shell.timer);
    dk.shell.timer = setTimeout(() => {
        if (dk.shell.sock && dk.shell.sock.connected) {
            dk.shell.term.write('\r\n\x1b[31m[Session timed out due to 10m inactivity]\x1b[0m\r\n');
            dk.shell.sock.disconnect();
        }
    }, SHELL_IDLE);
}

function openShell(id, name) {
    if (typeof Terminal === 'undefined' || typeof io === 'undefined') {
        toast('Terminal libraries failed to load (CDN blocked?)', true);
        return;
    }
    const sh = dk.shell;
    $('dkShellTitle').textContent = `Shell · ${name}`;
    shellStatus('CONNECTING', false);
    $('dkShell').showModal();

    sh.term = new Terminal({ cursorBlink: true, fontSize: 13, theme: termPalette(),
        fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace" });
    sh.fit = new FitAddon.FitAddon();
    sh.term.loadAddon(sh.fit);
    sh.term.open($('dkShellTerm'));
    const fit = () => { try { sh.fit.fit(); } catch { /* not laid out yet */ } };
    setTimeout(fit, 60);
    sh.term.focus();

    sh.sock = io('/docker-shell', { query: { container: id, server: window.atsTarget.id }, reconnection: false });
    sh.sock.on('connect', () => {
        shellStatus('CONNECTED', true);
        fit();
        sh.sock.emit('shell_resize', { cols: sh.term.cols, rows: sh.term.rows });
        shellTouch();
    });
    sh.sock.on('connect_error', () => { shellStatus('REFUSED', false); sh.term.write('\r\n\x1b[31m[Connection refused. Are you signed in?]\x1b[0m\r\n'); });
    sh.sock.on('shell_output', d => sh.term.write(String(d)));
    sh.sock.on('disconnect', () => shellStatus('DISCONNECTED', false));
    sh.term.onData(d => { if (sh.sock.connected) { sh.sock.emit('shell_input', { input: d }); shellTouch(); } });
    sh.term.onResize(({ cols, rows }) => { if (sh.sock.connected) sh.sock.emit('shell_resize', { cols, rows }); });
    sh.onResize = () => { fit(); };
    window.addEventListener('resize', sh.onResize);
}

$('dkShell').addEventListener('close', () => {
    const sh = dk.shell;
    clearTimeout(sh.timer);
    window.removeEventListener('resize', sh.onResize || (() => {}));
    if (sh.sock) sh.sock.disconnect();
    if (sh.term) sh.term.dispose();
    sh.sock = sh.term = sh.fit = null;
    $('dkShellTerm').innerHTML = '';
});

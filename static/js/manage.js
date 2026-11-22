'use strict';

// Manage tab: service list, service panel, deploy, settings and the Cloudflare panel.
// Talks to /api/manage/* (manage_api.py). Relies on esc() and stamp() from main.js.
// Everything lives inside this IIFE so it cannot collide with main.js / docker.js globals.
(() => {

const API = '/api/manage';
const $ = id => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
const POLL_MS = 10000;
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENVKEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const DEFAULT_LIMITS = { workers: [1, 32], max_memory_mb: [64, 65536], cpu_quota: [5, 800] };

const mg = {
    loaded: false, loading: false, err: null, last: 0, depsAt: 0,
    services: [], settings: null, deps: null, docker: null,
    jobs: new Map(),            // id -> tracked job (running ones are polled)
    history: [],                // recent job summaries from /jobs
    filter: 'all', runtime: 'all', query: '', sort: { key: 'name', dir: 1 },
    sig: ''
};

// ── API ─────────────────────────────────────────────────────
async function call(method, path, json) {
    const o = { method, headers: {} };
    if (method !== 'GET') {
        o.headers['X-Requested-With'] = 'ats-monitor';
        if (json !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(json); }
    }
    try {
        const r = await fetch(API + path, o);
        if (r.status === 401) { window.location.href = '/login'; return { ok: false, error: 'Signed out', code: 'unauthorized' }; }
        const d = await r.json().catch(() => null);
        if (!d) return { ok: false, error: 'Unexpected response (HTTP ' + r.status + ')', code: 'http', status: r.status };
        if (!r.ok || d.ok === false) return { ...d, ok: false, status: r.status, error: d.error || 'HTTP ' + r.status };
        return { ok: true, data: d.data, status: r.status };
    } catch {
        return { ok: false, error: 'The monitor did not respond (network error)', code: 'network' };
    }
}
const GET = p => call('GET', p);
const POST = (p, j = {}) => call('POST', p, j);
const PUT = (p, j) => call('PUT', p, j);
const PATCH = (p, j) => call('PATCH', p, j);
const DEL = (p, j) => call('DELETE', p, j);
const svcPath = (name, rest = '') => '/services/' + encodeURIComponent(name) + rest;

// ── formatting ──────────────────────────────────────────────
const num = v => (v == null || v === '' ? '—' : String(v));
function fmtBytes(n) {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = Number(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
}
function fmtMem(mb) { return mb >= 1024 && mb % 1024 === 0 ? (mb / 1024) + ' GB' : mb + ' MB'; }
function fmtAgo(iso) {
    if (!iso) return 'never';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return String(iso);
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDate(iso) {
    const d = new Date(iso);
    return isNaN(d) ? String(iso || '—') : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtUptime(s) {
    s = Math.max(0, Math.round(s || 0));
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m ? m + 'm' : s + 's';
}
function fmtDur(s) { return s == null ? '' : s >= 60 ? Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's' : Math.round(s * 10) / 10 + 's'; }
function repoShort(url) {
    return String(url || '').replace(/^https?:\/\/(?:[^@/]*@)?/, '').replace(/^git@([^:]+):/, '$1/').replace(/\.git$/, '');
}
const RT = { python: 'Python', node: 'Node', docker: 'Docker' };
const rtBadge = r => `<span class="mg-rt">${esc(RT[r] || r || '—')}</span>`;

function stInfo(s) {
    switch (s.status) {
        case 'active': return s.healthy === false ? ['warn', 'Unhealthy'] : ['ok', 'Running'];
        case 'activating': return ['warn', 'Starting'];
        case 'failed': return ['bad', 'Failed'];
        case 'inactive': return ['off', 'Stopped'];
        default: return ['off', 'Unknown'];
    }
}
const stHtml = s => { const [c, l] = stInfo(s); return `<span class="mg-st ${c}">${l}</span>`; };
const groupOf = s => (s.status === 'active' || s.status === 'activating') ? 'running' : s.status === 'failed' ? 'failed' : 'stopped';
const needsAttention = s => s.status === 'failed' || (s.status === 'active' && s.healthy === false);
const isRunning = s => s && (s.status === 'active' || s.status === 'activating');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── toast (popover => stays above open modal dialogs) ───────
let toastTimer = null;
function toast(msg, bad) {
    const el = $('mgToast');
    el.textContent = msg;
    el.classList.toggle('bad', !!bad);
    el.hidden = false;
    if (el.showPopover) { try { el.hidePopover(); } catch { /* not open */ } try { el.showPopover(); } catch { /* unsupported */ } }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; try { el.hidePopover(); } catch { /* ignore */ } }, bad ? 8000 : 3200);
}

function copyText(text, what) {
    const done = () => toast((what || 'Value') + ' copied');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
    } else legacyCopy(text, done);
}
function legacyCopy(text, done) {
    const t = document.createElement('textarea');
    t.value = text; t.setAttribute('readonly', ''); t.style.cssText = 'position:fixed;top:0;opacity:0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); done(); } catch { toast('Copy failed', true); }
    t.remove();
}

// ── dialog helpers ──────────────────────────────────────────
const openDlg = d => { if (!d.open) d.showModal(); };
const closeDlg = d => { if (d.open) d.close(); };
document.addEventListener('click', e => {
    const dlg = e.target.closest('dialog.mg-panel, dialog.mg-wide, dialog.mg-confirm');
    if (!dlg) return;
    if (e.target.closest('[data-close]')) { closeDlg(dlg); }
});
// the service panel is a drawer: a click on its backdrop closes it (forms in other dialogs must not)
$('mgPanel').addEventListener('click', e => { if (e.target === $('mgPanel')) requestClosePanel(); });

// on phones the visual viewport shrinks when the keyboard opens; keep sheets inside it
function syncSheets() {
    const vv = window.visualViewport;
    const r = document.documentElement.style;
    if (!vv) return;
    r.setProperty('--mg-vh', vv.height + 'px');
    r.setProperty('--mg-vt', vv.offsetTop + 'px');
}
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncSheets);
    window.visualViewport.addEventListener('scroll', syncSheets);
}
syncSheets();
document.addEventListener('focusin', e => {
    if (!e.target.matches('input, textarea, select') || !e.target.closest('dialog.mg-panel, dialog.mg-wide')) return;
    const vv = window.visualViewport;
    if (vv && vv.height < window.innerHeight * 0.8) setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 250);
});

// generic confirm. Resolves null when cancelled, else { checks: {id: bool} }.
function confirmDlg({ title, body, confirm = 'Confirm', danger = false, type = null, checks = [], cancel = 'Cancel', fields = [], validate = null }) {
    const d = $('mgConfirm');
    return new Promise(resolve => {
        let result = null;
        d.innerHTML = `<form method="dialog" id="mgConfirmForm" autocomplete="off">
            <div class="dk-dhead"><h2 id="mgConfirmTitle">${esc(title)}</h2></div>
            <div class="mg-cbody">
                <div class="mg-cmsg">${body || ''}</div>
                ${checks.map(c => `<label class="toggle-label mg-ccheck"><input type="checkbox" data-check="${esc(c.id)}"${c.checked ? ' checked' : ''}><span>${esc(c.label)}</span></label>`).join('')}
                ${fields.map((f, i) => `<div class="mg-f"><label for="mgcf-${i}">${esc(f.label)}</label><input class="filter-input" id="mgcf-${i}" data-field="${esc(f.id)}" value="${esc(f.value || '')}" spellcheck="false" autocapitalize="off" autocomplete="off"${f.inputmode ? ` inputmode="${f.inputmode}"` : ''}${i === 0 ? ' autofocus' : ''}></div>`).join('')}
                <p class="mg-form-err" id="mgConfirmErr" role="alert" hidden></p>
                ${type ? `<label class="mg-ctype" for="mgConfirmType">Type <b>${esc(type)}</b> to confirm</label>
                <input class="filter-input" id="mgConfirmType" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="mgConfirmTitle" autofocus>` : ''}
            </div>
            <div class="dk-form-actions">
                <button type="button" class="term-btn mg-lg" data-close${!type && danger && !fields.length ? ' autofocus' : ''}>${esc(cancel)}</button>
                <button type="submit" class="${danger ? 'dk-danger' : 'dk-primary'} mg-lg" id="mgConfirmGo"${type ? ' disabled' : ''}${!type && !danger && !fields.length ? ' autofocus' : ''}>${esc(confirm)}</button>
            </div></form>`;
        const go = qs('#mgConfirmGo', d), input = qs('#mgConfirmType', d);
        if (input) input.addEventListener('input', () => { go.disabled = input.value !== type; });
        qs('form', d).addEventListener('submit', e => {
            e.preventDefault();
            if (go.disabled) return;
            const values = Object.fromEntries(qsa('[data-field]', d).map(c => [c.dataset.field, c.value.trim()]));
            const problem = validate ? validate(values) : '';
            if (problem) { const er = qs('#mgConfirmErr', d); er.textContent = problem; er.hidden = false; return; }
            result = { checks: Object.fromEntries(qsa('[data-check]', d).map(c => [c.dataset.check, c.checked])), values };
            d.close();
        });
        d.addEventListener('close', () => resolve(result), { once: true });
        d.showModal();
    });
}

// ── error / empty / skeleton blocks ─────────────────────────
function errBlock(r, retry) {
    const bridge = r && (r.code === 'unreachable' || r.bridge);
    if (bridge) {
        const cmd = r.command ? `<dt>Configured command</dt><dd><code>${esc(r.command)} --api &lt;op&gt;</code></dd>` : '';
        const out = r.detail ? `<dt>Last output</dt><dd><pre class="mg-pre mg-pre-sm">${esc(r.detail)}</pre></dd>` : '';
        return `<div class="mg-state bad" role="alert">
            <h3>ats CLI not reachable</h3>
            <p>The monitor could not get an answer from the ats command line, so nothing can be listed or changed yet. ${esc(r.error || '')}</p>
            <dl class="mg-dl mg-dl-wide">${cmd}${out}</dl>
            <p class="mg-muted">Set <code>ATS_CLI</code> for the monitor and allow it in sudoers. Setup steps are in <code>docs/manage.md</code>.</p>
            ${retry ? `<div class="mg-state-act"><button class="term-btn mg-lg" data-act="${retry}">Retry</button></div>` : ''}
        </div>`;
    }
    if (r && r.code === 'not_configured') {
        return `<div class="mg-state bad" role="alert"><h3>ats is not configured on this host</h3>
            <p>${esc(r.error || 'Run the ats first-time setup, then reload this page.')}</p>
            ${retry ? `<div class="mg-state-act"><button class="term-btn mg-lg" data-act="${retry}">Retry</button></div>` : ''}</div>`;
    }
    return `<div class="mg-state bad" role="alert"><h3>Could not load this</h3><p>${esc((r && r.error) || 'Unknown error')}</p>
        ${retry ? `<div class="mg-state-act"><button class="term-btn mg-lg" data-act="${retry}">Retry</button></div>` : ''}</div>`;
}
const emptyBlock = (title, text, act) => `<div class="mg-state"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${act ? `<div class="mg-state-act">${act}</div>` : ''}</div>`;
const skelRows = (n, cls = '') => Array.from({ length: n }, (_, i) => `<div class="mg-skel mg-skel-line ${cls}" style="width:${[92, 78, 86, 64, 80, 70][i % 6]}%"></div>`).join('');

// ═══════════════════════════════════════════════════════════
//   HEADER: dependencies, hints, running jobs
// ═══════════════════════════════════════════════════════════
const dockerState = () => {
    const dk = mg.docker, dep = mg.deps && mg.deps.docker, acc = mg.deps && mg.deps.docker_access;
    if (!dk && !dep) return null;
    const installed = dk ? !!dk.available : !!(dep && dep.ok);
    const access = dk ? !!dk.access : !!(acc && acc.ok);
    return { installed, access, usable: installed && access, version: (dk && dk.version) || (dep && dep.version) || '',
        hint: (dk && dk.hint) || (acc && acc.hint) || (dep && dep.hint) || '', installable: !!(dep && dep.installable) };
};
const dockerUsable = () => { const d = dockerState(); return !!(d && d.usable); };

$('mgToolsToggle').addEventListener('click', () => {
    const button = $('mgToolsToggle');
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    $('mgHostTools').classList.toggle('expanded', expanded);
});

function renderDeps() {
    const box = $('mgDeps'), hints = $('mgHints');
    if (!mg.deps) {
        if (mg.err) { $('mgToolsToggle').textContent = 'Host tools · status unavailable'; box.innerHTML = '<span class="mg-muted">Dependency status unavailable</span>'; hints.hidden = true; }
        return;
    }
    const d = mg.deps, dk = dockerState();
    const items = [
        ['git', d.git, true], ['docker', dk ? { ok: dk.usable, version: dk.version, hint: dk.hint || (dk.installed ? 'The service user cannot reach the Docker socket.' : 'Docker is not installed.'),
            label: dk.installed && !dk.access ? 'no access' : '', installable: !dk.installed && dk.installable } : null, false],
        ['cloudflared', d.cloudflared, true], ['rclone', d.rclone, false]
    ];
    const missing = items.filter(([, x]) => x && !x.ok);
    $('mgToolsToggle').textContent = missing.length ? `Host tools · ${missing.length} unavailable` : 'Host tools · all available';
    $('mgToolsToggle').classList.toggle('mg-warn', missing.some(([, , required]) => required));
    const hl = [];
    box.innerHTML = items.map(([name, x, required]) => {
        if (!x) return '';
        const cls = x.ok ? 'ok' : required ? 'fail' : 'warn';
        if (!x.ok && x.hint) hl.push(`<b>${esc(name)}</b> ${esc(x.hint)}`);
        const meta = x.ok ? (x.version ? esc(String(x.version).replace(/^v/, '')) : 'ok') : (x.label || (required ? 'missing' : 'optional, unavailable'));
        const install = !x.ok && x.installable ? ` <button class="term-btn mg-mini" data-act="dep-install" data-dep="${esc(name)}" aria-label="Install ${esc(name)} on this server">Install</button>` : '';
        return `<span class="pill ${cls}" role="listitem" tabindex="0" title="${esc(x.hint || (x.ok ? name + ' is available' : name + ' is not available'))}">${esc(name)} <span class="mg-pill-v">${meta}</span>${install}</span>`;
    }).join('');
    hints.hidden = !hl.length;
    hints.innerHTML = hl.map(h => `<p>${h}</p>`).join('');
}

function renderJobStrip() {
    const box = $('mgJobs');
    const run = [...mg.jobs.values()].filter(j => j.status === 'running');
    box.hidden = !run.length;
    box.innerHTML = run.map(j => {
        const cur = [...j.steps].reverse().find(s => s.state === 'start');
        return `<div class="mg-job-pill"><span class="mg-spin" aria-hidden="true"></span><span><b>${esc(jobLabel(j))}</b> ${esc(j.name)}${cur ? ' <span class="mg-muted">· ' + esc(stepLabel(cur.id)) + '</span>' : ''}</span>
            <button class="term-btn" data-act="job-view" data-job="${esc(j.id)}">View</button></div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════
//   SERVICE LIST
// ═══════════════════════════════════════════════════════════
const COLS = [['status', 'Status'], ['name', 'Service'], ['runtime', 'Runtime'], ['domain', 'Domain'], ['port', 'Port'], ['res', 'Resources'], ['dep', 'Last deploy'], ['auto', 'Updates']];
const ST_ORDER = { failed: 0, activating: 1, active: 2, inactive: 3, unknown: 4 };

function sortVal(s, k) {
    switch (k) {
        case 'status': return ST_ORDER[s.status] ?? 9;
        case 'dep': return s.last_deploy ? new Date(s.last_deploy.timestamp).getTime() || 0 : 0;
        case 'auto': return s.auto_update ? 1 : 0;
        default: return s[k] == null ? '' : s[k];
    }
}

function visibleServices() {
    const q = mg.query.toLowerCase();
    const rows = mg.services.filter(s =>
        (mg.filter === 'all' || (mg.filter === 'attention' ? needsAttention(s) : groupOf(s) === mg.filter)) &&
        (mg.runtime === 'all' || s.runtime === mg.runtime) &&
        (!q || [s.name, s.domain, s.repo_url, s.port, s.runtime, s.branch].join(' ').toLowerCase().includes(q)));
    const { key, dir } = mg.sort;
    rows.sort((a, b) => {
        const x = sortVal(a, key), y = sortVal(b, key);
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return (c || a.name.localeCompare(b.name)) * dir;
    });
    return rows;
}

function renderChips() {
    const c = { all: mg.services.length, running: 0, stopped: 0, failed: 0 };
    mg.services.forEach(s => { c[groupOf(s)]++; });
    const chip = (k, l) => `<button class="dk-chip${mg.filter === k ? ' active' : ''}" data-filter="${k}" aria-pressed="${mg.filter === k}">${l} <b>${c[k]}</b></button>`;
    $('mgChips').innerHTML = chip('all', 'All') + chip('running', 'Running') + chip('stopped', 'Stopped') + chip('failed', 'Failed');
}

function lastDeployCell(s) {
    const d = s.last_deploy;
    if (!d) return '<span class="mg-muted">never</span>';
    const cls = d.status === 'success' ? 'ok' : d.status === 'failed' ? 'bad' : 'warn';
    return `<span class="mg-dep ${cls}" title="${esc(d.status + (d.duration_seconds != null ? ', took ' + fmtDur(d.duration_seconds) : '') + ', ' + fmtDate(d.timestamp))}">${esc(fmtAgo(d.timestamp))}</span>`;
}

function rowHtml(s) {
    const link = s.domain ? `<a href="https://${esc(s.domain)}" target="_blank" rel="noopener noreferrer" class="mg-dom" title="Open ${esc(s.domain)}">${esc(s.domain)}</a>` : '<span class="mg-muted">none</span>';
    return `<tr class="mg-row${needsAttention(s) ? ' mg-attention' : ''}" data-name="${esc(s.name)}">
        <td class="c-status" data-label="Status">${stHtml(s)}</td>
        <td class="c-name" data-label="Service"><button class="mg-name" data-open="${esc(s.name)}" aria-label="Open ${esc(s.name)}">${esc(s.name)}</button><span class="mg-sub">${esc(repoShort(s.repo_url))} · ${esc(s.branch)}</span><div class="mg-shortcuts"><button class="term-btn" data-service-tab="logs" aria-label="View logs for ${esc(s.name)}">Logs</button><button class="term-btn" data-service-tab="resources" aria-label="Edit resources for ${esc(s.name)}">Resources</button></div></td>
        <td class="c-rt" data-label="Runtime">${rtBadge(s.runtime)}</td>
        <td class="c-dom" data-label="Domain">${link}</td>
        <td class="c-port" data-label="Port">${num(s.port)}</td>
        <td class="c-res" data-label="Resources">${s.workers}w · ${fmtMem(s.max_memory_mb)} · ${s.cpu_quota}%</td>
        <td class="c-dep" data-label="Last deploy">${lastDeployCell(s)}</td>
        <td class="c-auto" data-label="Updates">${s.auto_update ? '<span class="mg-auto on" title="Redeploys on every push to the tracked branch">auto</span>' : '<span class="mg-auto" title="Updates only when you trigger them">manual</span>'}</td>
    </tr>`;
}

function renderList() {
    const el = $('mgList');
    if (!mg.loaded && !mg.err) {
        el.innerHTML = `<div class="mg-tablewrap" aria-busy="true">${Array.from({ length: 5 }, () => '<div class="mg-skel-row"><span class="mg-skel" style="width:9%"></span><span class="mg-skel" style="width:22%"></span><span class="mg-skel" style="width:8%"></span><span class="mg-skel" style="width:24%"></span><span class="mg-skel" style="width:12%"></span></div>').join('')}</div>`;
        return;
    }
    if (mg.err && !mg.loaded) { $('mgChips').innerHTML = ''; el.innerHTML = errBlock(mg.err, 'retry'); return; }
    renderChips();
    const rows = visibleServices();
    const filtered = mg.filter !== 'all' || mg.runtime !== 'all' || !!mg.query;
    const attention = mg.services.filter(needsAttention).length;
    $('mgResultCount').textContent = `${rows.length} of ${mg.services.length} services`;
    $('mgClearFilters').hidden = !filtered;
    $('mgAttention').textContent = `Needs attention · ${attention}`;
    $('mgAttention').hidden = !attention && mg.filter !== 'attention';
    $('mgAttention').setAttribute('aria-pressed', String(mg.filter === 'attention'));
    const banner = mg.err ? `<div class="mg-note bad" role="alert">Last refresh failed: ${esc(mg.err.error)}. Showing the previous data. <button class="mg-link" data-act="retry">Retry</button></div>` : '';
    if (!mg.services.length) {
        el.innerHTML = banner + emptyBlock('No services yet', 'Deploy a service from a Git repository. The monitor will pick it up here once ats has created it.',
            '<button class="dk-primary mg-lg" data-act="deploy">Deploy service</button>');
        return;
    }
    if (!rows.length) {
        el.innerHTML = banner + emptyBlock('No services match', 'Nothing matches the current search and filters.', '<button class="term-btn mg-lg" data-act="clear-filters">Clear filters</button>');
        return;
    }
    const th = COLS.map(([k, l]) => k === 'res'
        ? `<th scope="col" class="c-res">${l}</th>`
        : `<th scope="col" class="c-${k === 'runtime' ? 'rt' : k === 'domain' ? 'dom' : k}" aria-sort="${mg.sort.key === k ? (mg.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button class="mg-th" data-sort="${k}">${l}<i aria-hidden="true">${mg.sort.key === k ? (mg.sort.dir > 0 ? '&#9650;' : '&#9660;') : ''}</i></button></th>`).join('');
    el.innerHTML = banner + `<div class="mg-tablewrap"><table class="mg-table"><thead><tr>${th}</tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table></div>`;
}

// list toolbar + delegation
$('mgSearch').addEventListener('input', e => { mg.query = e.target.value.trim(); renderList(); });
$('mgSortSel').addEventListener('change', e => { mg.sort = { key: e.target.value, dir: e.target.value === 'dep' ? -1 : 1 }; renderList(); });
$('mgRuntime').addEventListener('change', e => { mg.runtime = e.target.value; renderList(); });
$('tab-manage').addEventListener('click', e => {
    const t = e.target;
    let b;
    if ((b = t.closest('[data-filter]'))) { mg.filter = b.dataset.filter; renderList(); qs(`[data-filter="${mg.filter}"]`, $('tab-manage'))?.focus({ preventScroll: true }); return; }
    if ((b = t.closest('[data-sort]'))) {
        const k = b.dataset.sort;
        mg.sort = { key: k, dir: mg.sort.key === k ? -mg.sort.dir : 1 };
        renderList();
        qs(`[data-sort="${k}"]`, $('mgList'))?.focus();
        return;
    }
    if ((b = t.closest('[data-act]'))) {
        const a = b.dataset.act;
        if (a === 'retry') { fetchManage(true); return; }
        if (a === 'deploy') { openDeploy(); return; }
        if (a === 'clear-filters') { mg.filter = 'all'; mg.runtime = 'all'; mg.query = ''; $('mgSearch').value = ''; $('mgRuntime').value = 'all'; renderList(); $('mgSearch').focus({ preventScroll: true }); return; }
        if (a === 'job-view') { const j = mg.jobs.get(b.dataset.job); if (j) openJob(j); return; }
    }
    if (t.closest('a')) return;
    const row = t.closest('.mg-row');
    if (row) openPanel(row.dataset.name, t.closest('[data-service-tab]')?.dataset.serviceTab || 'overview');
});
$('mgSettingsBtn').addEventListener('click', () => openSettings());
$('mgDeployBtn').addEventListener('click', () => openDeploy());

// ── data loading (called from main.js refreshActive every 5 s, throttled to POLL_MS) ──
async function loadDeps() {
    const r = await GET('/dependencies');
    if (r.ok) { mg.deps = r.data.dependencies; mg.docker = r.data.docker; mg.depsAt = Date.now(); renderDeps(); }
    else if (!mg.deps) renderDeps();
}
async function loadSettings() {
    const r = await GET('/settings');
    if (r.ok) mg.settings = r.data;
    return r;
}

async function fetchManage(force) {
    if (mg.loading || (document.hidden && !force)) return;
    if (!force && mg.loaded && Date.now() - mg.last < POLL_MS) return;
    mg.loading = true;
    const first = !mg.loaded;
    if (first || force && mg.err) renderList();
    const [svc, jobs] = await Promise.all([GET('/services'), GET('/jobs')]);
    if (svc.ok) {
        mg.err = null; mg.loaded = true;
        mg.services = svc.data.services || [];
        $('mgSettingsBtn').disabled = false; $('mgDeployBtn').disabled = false;
        if (!mg.settings) loadSettings();
        if (!mg.deps || Date.now() - mg.depsAt > 60000) loadDeps();
    } else {
        mg.err = svc;
        if (!mg.loaded) { renderDeps(); }
    }
    if (jobs.ok) {
        mg.history = jobs.data.jobs || [];
        mg.history.filter(j => j.status === 'running' && !mg.jobs.has(j.id)).forEach(j => trackJob(j.id, j.op, j.name));
    }
    mg.last = Date.now();
    mg.loading = false;
    const sig = JSON.stringify([mg.services, mg.err && mg.err.error, mg.filter, mg.runtime, mg.sort, mg.history.map(j => j.id + j.status)]);
    if (sig !== mg.sig || first) { mg.sig = sig; renderList(); }
    stamp();
    onListRefreshed();
}
window.fetchManage = fetchManage;

// ═══════════════════════════════════════════════════════════
//   JOBS (deploy, update, backups ... run detached on the server)
// ═══════════════════════════════════════════════════════════
const STEP_LABELS = {
    clone: 'Clone repository', build: 'Dependencies and build', deps: 'Dependencies', unit: 'Systemd unit', cloudflare: 'Cloudflare route',
    start: 'Start service', health: 'Health check', fetch: 'Fetch source', restart: 'Restart service', stop: 'Stop service',
    archive: 'Archive files', checksum: 'Checksum', upload: 'Upload to Google Drive', verify: 'Verify', extract: 'Extract archive',
    backup: 'Backup', remove: 'Remove', deliver: 'Deliver test push', update: 'Run update',
    disable: 'Disable at boot', container: 'Remove container and image', files: 'Delete service files', backups: 'Delete backups',
    record: 'Remove from ATS', reload: 'Reload systemd', validate: 'Validate config', write: 'Write config file',
    prepare: 'Update package lists', install: 'Install packages', enable: 'Start the service', access: 'Grant the service user access'
};
const DEPLOY_STEPS = ['clone', 'build', 'unit', 'cloudflare', 'start', 'health'];
const stepLabel = id => STEP_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1).replace(/[_-]/g, ' ');
const OP_LABELS = {
    'services.deploy': 'Deploying', 'services.redeploy': 'Redeploying', 'services.delete': 'Deleting', 'services.action': 'Updating',
    'backups.create': 'Backing up', 'backups.restore': 'Restoring', 'webhook.test': 'Testing webhook',
    'cloudflare.config.set': 'Saving Cloudflare config', 'system.install': 'Installing'
};
const JOB_NOUN = { 'services.deploy': 'Deploy', 'services.redeploy': 'Redeploy', 'services.delete': 'Delete', 'services.action': 'Update', 'backups.create': 'Backup', 'backups.restore': 'Restore', 'webhook.test': 'Webhook test', 'deployments.rollback': 'Rollback', 'backups.verify': 'Backup verification' };
const jobLabel = j => j.label || OP_LABELS[j.op] || j.op;

function trackJob(id, op, name, label) {
    let j = mg.jobs.get(id);
    if (j) { if (label) j.label = label; return j; }
    j = { id, op, name, label, status: 'running', lines: [], steps: [], next: 0, result: null, subs: new Set(), timer: null, started: null, finished: null, done: false };
    mg.jobs.set(id, j);
    pollJob(j);
    renderJobStrip();
    return j;
}

async function pollJob(j) {
    const r = await GET('/jobs/' + j.id + '?since=' + j.next);
    if (r.ok) {
        const d = r.data;
        j.lines.push(...d.lines); j.next = d.next; j.steps = d.steps; j.status = d.status;
        j.result = d.result; j.started = d.started; j.finished = d.finished; j.op = d.op; j.name = d.name;
    } else if (r.code === 'notfound') {
        j.status = 'failed'; j.result = { ok: false, code: 'notfound', error: 'The job record is gone (it may have been cleaned up).' };
    }
    j.subs.forEach(fn => fn(j));
    renderJobStrip();
    if (j.status === 'running') j.timer = setTimeout(() => pollJob(j), r.ok ? 1000 : 2500);
    else onJobDone(j);
}

function onJobDone(j) {
    if (j.done) return;
    j.done = true;
    const ok = j.status === 'done';
    const noun = JOB_NOUN[j.op] || 'Operation';
    toast(ok ? `${noun} of ${j.name} finished` : `${noun} of ${j.name} failed: ${(j.result && j.result.error) || 'see the log'}`, !ok);
    renderJobStrip();
    fetchManage(true);
    afterJob(j);
    setTimeout(() => { if (j.status !== 'running') { mg.jobs.delete(j.id); mg.history.unshift({ id: j.id, op: j.op, name: j.name, status: j.status, started: j.started, finished: j.finished }); } }, 60000);
}

function jobStepsHtml(j, deploy) {
    let list = j.steps.slice();
    if (deploy) {
        const seen = new Set(list.map(s => s.id));
        const base = DEPLOY_STEPS.filter(id => !seen.has(id)).map(id => ({ id, state: 'pending' }));
        list = list.concat(base);
        list.sort((a, b) => (DEPLOY_STEPS.indexOf(a.id) + 99 * (DEPLOY_STEPS.indexOf(a.id) < 0)) - (DEPLOY_STEPS.indexOf(b.id) + 99 * (DEPLOY_STEPS.indexOf(b.id) < 0)));
    }
    if (!list.length) return `<li class="pending"><span class="mg-mk" aria-hidden="true"></span>${j.status === 'running' ? 'Waiting for the first step...' : 'No steps reported'}</li>`;
    return list.map(s => {
        const st = s.state === 'start' ? 'run' : s.state;
        const word = { run: 'running', done: 'done', fail: 'failed', pending: 'pending' }[st];
        return `<li class="${st}"><span class="mg-mk" aria-hidden="true"></span><span class="mg-sl">${esc(stepLabel(s.id))}</span><span class="mg-sw">${word}</span></li>`;
    }).join('');
}

function jobLogHtml(j) {
    const lines = j.lines.filter(l => l.t === 'log');
    if (!lines.length) return '<span class="mg-muted">Waiting for output...</span>';
    return lines.map(l => `<div class="${l.lvl === 'error' ? 'l-err' : l.lvl === 'warn' ? 'l-warn' : ''}">${esc(l.m)}</div>`).join('');
}

// compact inline job progress (backups tab, webhook tab)
function jobBoxHtml(j) {
    const running = j.status === 'running';
    const last = j.lines.filter(l => l.t === 'log').slice(-4);
    return `<div class="mg-jobbox ${running ? 'run' : j.status === 'done' ? 'ok' : 'bad'}">
        <div class="mg-jb-h"><span>${running ? '<span class="mg-spin" aria-hidden="true"></span>' : ''}<b>${esc(jobLabel(j))}</b> ${esc(j.name)}</span>
        <span class="mg-st ${running ? 'warn' : j.status === 'done' ? 'ok' : 'bad'}">${running ? 'Running' : j.status === 'done' ? 'Done' : 'Failed'}</span></div>
        <ol class="mg-steps mg-steps-h">${jobStepsHtml(j, false)}</ol>
        ${last.length ? `<pre class="mg-joblog mg-joblog-sm">${last.map(l => esc(l.m)).join('\n')}</pre>` : ''}
        ${!running && j.result && !j.result.ok ? `<p class="mg-form-err" role="alert">${esc(j.result.error)}</p>` : ''}
        <div class="mg-jb-f"><button class="term-btn" data-act="job-view" data-job="${esc(j.id)}">Full log</button></div>
    </div>`;
}

function resultSummary(j) {
    const d = (j.result && j.result.data) || {};
    switch (j.op) {
        case 'services.action': return d.message || 'Completed';
        case 'backups.create': return `${d.filename || 'Backup'} (${fmtBytes(d.size_bytes)}, ${d.location || 'local'})`;
        case 'backups.restore': return 'Backup restored and the service started again.';
        case 'webhook.test': return `${d.message || (d.ok ? 'Accepted' : 'Rejected')}${d.status ? ' (HTTP ' + d.status + ')' : ''}`;
        case 'services.delete': return 'Service deleted.';
        case 'system.install': return d.already ? `${esc(d.name)} was already installed.` : `${d.name} ${d.version ? '(' + d.version + ') ' : ''}was installed.`;
        case 'cloudflare.config.set': return d.restarted ? 'Saved, and cloudflared restarted with the new config.' : 'Saved. cloudflared was not restarted.';
        default: return 'Completed';
    }
}

// ── job dialog (any job; deploy gets the result card with URL + webhook secret) ──
const J = { job: null, sub: null, opts: {}, reveal: false };

function openJob(job, opts = {}) {
    if (J.job && J.sub) J.job.subs.delete(J.sub);
    J.job = job; J.opts = opts; J.reveal = false;
    const d = $('mgJob');
    d.innerHTML = `<div class="dk-dhead"><h2 id="mgJobTitle"></h2><span class="mg-st" id="mgJobSt"></span><button class="term-btn" data-close id="mgJobClose">Close</button></div>
        <div class="mg-jbody">
            <p class="mg-muted mg-jnote" id="mgJobNote"></p>
            <ol class="mg-steps" id="mgJobSteps" aria-label="Progress"></ol>
            <div class="mg-logbar"><span>Log</span><button class="mg-link" data-act="job-copylog">Copy log</button></div>
            <div class="mg-joblog" id="mgJobLog" tabindex="0" role="log" aria-label="Job output"></div>
            <div id="mgJobResult"></div>
        </div>`;
    J.sub = () => paintJob();
    job.subs.add(J.sub);
    paintJob(true);
    openDlg(d);
}

const isDeployOp = j => j.op === 'services.deploy' || j.op === 'services.redeploy';

function paintJob(first) {
    const j = J.job, d = $('mgJob');
    if (!j || !d.open && !first) return;
    const running = j.status === 'running';
    $('mgJobTitle').textContent = `${jobLabel(j)} ${j.name}`;
    const st = $('mgJobSt');
    st.className = 'mg-st ' + (running ? 'warn' : j.status === 'done' ? 'ok' : 'bad');
    st.textContent = running ? 'Running' : j.status === 'done' ? 'Done' : 'Failed';
    $('mgJobNote').textContent = running ? 'This keeps running on the server if you close this window.' : '';
    $('mgJobSteps').innerHTML = jobStepsHtml(j, isDeployOp(j));
    const log = $('mgJobLog');
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = jobLogHtml(j);
    if (atEnd || first) log.scrollTop = log.scrollHeight;
    const had = $('mgJobResult').firstChild;
    $('mgJobResult').innerHTML = running ? '' : jobResultHtml(j);
    if (!running && !had) $('mgJobResult').scrollIntoView({ block: 'nearest' });
}

function jobResultHtml(j) {
    if (j.status !== 'done') {
        const r = j.result || {};
        return `<div class="mg-final bad" role="alert"><h3>${esc(jobLabel(j).replace(/ing$/, 'ing'))} failed</h3><p>${esc(r.error || 'The operation did not finish.')}</p>
            <div class="mg-final-act">${J.opts.retry ? '<button class="dk-primary mg-lg" data-act="job-retry">Edit and retry</button>' : ''}<button class="term-btn mg-lg" data-close>Close</button></div></div>`;
    }
    const d = (j.result && j.result.data) || {};
    if (isDeployOp(j) && d.webhook) {
        const mask = '&bull;'.repeat(20);
        return `<div class="mg-final ok"><h3>${j.op === 'services.deploy' ? 'Deployed' : 'Redeployed'}</h3>
            <dl class="mg-dl mg-dl-wide">
                <dt>URL</dt><dd><a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">${esc(d.url)}</a></dd>
                <dt>Port</dt><dd>${esc(d.port)} <span class="mg-muted">${esc(RT[d.runtime] || d.runtime)}</span></dd>
                <dt>Webhook URL</dt><dd class="mg-copyrow"><code>${esc(d.webhook.url)}</code><button class="term-btn" data-act="job-copy" data-v="url">Copy</button></dd>
                <dt>Webhook secret</dt><dd class="mg-copyrow"><code id="mgJobSecret">${J.reveal ? esc(d.webhook.secret) : mask}</code>
                    <button class="term-btn" data-act="job-reveal">${J.reveal ? 'Hide' : 'Reveal'}</button><button class="term-btn" data-act="job-copy" data-v="secret">Copy</button></dd>
            </dl>
            <p class="mg-muted">Add the webhook in GitHub under Settings, Webhooks: content type <code>application/json</code>, this secret, push events only. The secret is also available later on the service's Git and webhook tab.</p>
            <div class="mg-final-act"><button class="dk-primary mg-lg" data-act="job-open" data-name="${esc(d.name || j.name)}">Open service</button><button class="term-btn mg-lg" data-close>Close</button></div></div>`;
    }
    const notes = Array.isArray(d.warnings) ? d.warnings : [];
    return `<div class="mg-final ${notes.length ? 'warn' : 'ok'}"><h3>${notes.length ? 'Finished with notes' : 'Finished'}</h3><p>${esc(resultSummary(j))}</p>
        ${d.next ? `<p>${esc(d.next)}</p>` : ''}
        ${notes.length ? `<ul class="mg-final-notes">${notes.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        <div class="mg-final-act"><button class="term-btn mg-lg" data-close>Close</button></div></div>`;
}

$('mgJob').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || !J.job) return;
    const j = J.job, d = (j.result && j.result.data) || {};
    switch (b.dataset.act) {
        case 'job-copylog': copyText(j.lines.filter(l => l.t === 'log').map(l => l.m).join('\n'), 'Log'); break;
        case 'job-reveal': J.reveal = !J.reveal; $('mgJobResult').innerHTML = jobResultHtml(j); break;
        case 'job-copy': copyText(b.dataset.v === 'secret' ? d.webhook.secret : d.webhook.url, b.dataset.v === 'secret' ? 'Secret' : 'Webhook URL'); break;
        case 'job-open': closeDlg($('mgJob')); closeDlg($('mgDeploy')); openPanel(b.dataset.name); break;
        case 'job-retry': closeDlg($('mgJob')); if (J.opts.retry) J.opts.retry(); break;
    }
});
$('mgJob').addEventListener('close', () => { if (J.job && J.sub) J.job.subs.delete(J.sub); J.sub = null; });

// ═══════════════════════════════════════════════════════════
//   SHARED FORM COMPONENTS
// ═══════════════════════════════════════════════════════════
function fieldErr(input, msg) {
    const f = input.closest('.mg-f, .mg-res, fieldset') || input.parentElement;
    let p = qs(':scope > .mg-ferr', f);
    if (!msg) { if (p) p.hidden = true; input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); return; }
    if (!p) { p = document.createElement('p'); p.className = 'mg-ferr'; p.setAttribute('role', 'alert'); f.appendChild(p); }
    p.textContent = msg; p.hidden = false;
    input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true');
}

// -- domain picker: saved domain + subdomain, or typed manually --
function splitDomain(full, doms) {
    const f = (full || '').toLowerCase();
    let best = null;
    doms.forEach(d => { if ((f === d || f.endsWith('.' + d)) && (!best || d.length > best.length)) best = d; });
    return best ? { base: best, sub: f === best ? '' : f.slice(0, f.length - best.length - 1) } : { base: '', sub: f };
}

function domainFieldHtml(ns, current) {
    const doms = (mg.settings && mg.settings.domains) || [];
    const main = mg.settings && mg.settings.main_domain;
    const sp = splitDomain(current, doms);
    const mode = doms.length && (sp.base || !current) ? 'saved' : 'manual';
    return `<fieldset class="mg-fs" id="${ns}-dom">
        <legend>Domain</legend>
        ${doms.length ? `<div class="mg-seg" role="radiogroup" aria-label="How to enter the domain">
            <label><input type="radio" name="${ns}-mode" value="saved"${mode === 'saved' ? ' checked' : ''}><span>Saved domain</span></label>
            <label><input type="radio" name="${ns}-mode" value="manual"${mode === 'manual' ? ' checked' : ''}><span>Enter manually</span></label></div>` : ''}
        <div class="mg-dom-saved"${mode === 'saved' ? '' : ' hidden'}>
            <input class="filter-input" id="${ns}-sub" aria-label="Subdomain" placeholder="subdomain, blank for the root" value="${esc(sp.sub)}" autocapitalize="off" autocomplete="off" spellcheck="false">
            <span class="mg-dot-sep" aria-hidden="true">.</span>
            <select class="filter-input" id="${ns}-base" aria-label="Saved domain">${doms.map(d => `<option${(sp.base ? d === sp.base : d === main) ? ' selected' : ''}>${esc(d)}</option>`).join('')}</select>
        </div>
        <div class="mg-dom-manual"${mode === 'manual' ? '' : ' hidden'}>
            <input class="filter-input" id="${ns}-manual" aria-label="Full domain" placeholder="app.example.com" value="${mode === 'manual' ? esc(current || '') : ''}" autocapitalize="off" autocomplete="off" spellcheck="false">
        </div>
        ${doms.length ? '' : '<p class="mg-hint">No saved domains yet. Add some in Settings to pick them from a list.</p>'}
        <p class="mg-dom-prev" id="${ns}-prev" aria-live="polite"></p>
    </fieldset>`;
}

function readDomain(root, ns) {
    const mode = qs(`input[name="${ns}-mode"]:checked`, root);
    if (mode && mode.value === 'saved') {
        const sub = qs('#' + ns + '-sub', root).value.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
        const base = qs('#' + ns + '-base', root).value;
        return sub ? sub + '.' + base : base;
    }
    return (qs('#' + ns + '-manual', root).value || '').trim().toLowerCase();
}

// state: empty | bad | checking | ok | taken | unknown
function bindDomain(root, ns, current, onChange) {
    const fs = qs('#' + ns + '-dom', root), prev = qs('#' + ns + '-prev', root);
    const dp = { state: 'empty', value: '', msg: '' };
    let timer = null, waiters = [];
    const paint = (state, html) => {
        dp.state = state; prev.innerHTML = html; onChange && onChange(dp);
        if (state !== 'checking') { waiters.forEach(r => r()); waiters = []; }
    };
    dp.settled = () => dp.state !== 'checking' ? Promise.resolve() : new Promise(r => waiters.push(r));
    const update = () => {
        const v = dp.value = readDomain(root, ns);
        clearTimeout(timer);
        if (!v) return paint('empty', '<span class="mg-muted">Pick or type a domain.</span>');
        if (!HOST_RE.test(v)) return paint('bad', `<span class="mg-bad">Not a valid hostname:</span> <code>${esc(v)}</code>`);
        if (v === (current || '').toLowerCase()) return paint('ok', `<code>https://${esc(v)}</code> <span class="mg-muted">current domain</span>`);
        paint('checking', `<code>https://${esc(v)}</code> <span class="mg-muted">checking...</span>`);
        timer = setTimeout(async () => {
            const r = await GET('/domains/check?domain=' + encodeURIComponent(v));
            if (readDomain(root, ns) !== v) return;
            const url = `<code>https://${esc(v)}</code>`;
            if (!r.ok) paint('unknown', `${url} <span class="mg-muted">could not be checked (${esc(r.error)}); ats will validate it</span>`);
            else if (!r.data.valid) paint('bad', `<span class="mg-bad">Not a valid hostname:</span> <code>${esc(v)}</code>`);
            else if (r.data.taken_by) paint('taken', `${url} <span class="mg-bad">already used by ${esc(r.data.taken_by)}</span>`);
            else paint('ok', `${url} <span class="mg-ok">available</span>${r.data.in_cloudflare ? ' <span class="mg-warn">a Cloudflare route already exists for it</span>' : ''}`);
        }, 350);
    };
    fs.addEventListener('input', update);
    fs.addEventListener('change', e => {
        if (e.target.name === ns + '-mode') {
            const saved = e.target.value === 'saved';
            qs('.mg-dom-saved', fs).hidden = !saved;
            qs('.mg-dom-manual', fs).hidden = saved;
            // carry the current value across when switching modes
            if (!saved) { const m = qs('#' + ns + '-manual', fs); if (!m.value) m.value = dp.value; }
        }
        update();
    });
    update();
    dp.refresh = update;
    return dp;
}

// -- environment variable editor (values masked unless revealed) --
const envRow = (k, v, reveal) => `<div class="mg-env-row" role="group" aria-label="Environment variable">
    <input class="filter-input mg-env-k" aria-label="Name" placeholder="KEY" value="${esc(k)}" autocapitalize="off" autocomplete="off" spellcheck="false">
    <input class="filter-input mg-env-v" type="${reveal ? 'text' : 'password'}" aria-label="Value" placeholder="value" value="${esc(v)}" autocomplete="new-password" data-1p-ignore data-lpignore="true" spellcheck="false">
    <button type="button" class="term-btn mg-env-rm" data-env-rm aria-label="Remove variable">Remove</button></div>`;

function envEditorHtml(ns, env) {
    return `<div class="mg-env" id="${ns}-env">
        <div class="mg-env-bar"><span class="mg-muted" data-env-n></span><label class="toggle-label"><input type="checkbox" data-env-reveal><span>Show values</span></label></div>
        <div class="mg-env-rows">${Object.entries(env || {}).map(([k, v]) => envRow(k, v, false)).join('')}</div>
        <p class="mg-env-empty mg-muted" data-env-empty>No variables set.</p>
        <button type="button" class="term-btn" data-env-add>Add variable</button></div>`;
}

function readEnv(root, ns) {
    const box = qs('#' + ns + '-env', root), env = {}, errors = [], seen = new Set();
    qsa('.mg-env-row', box).forEach(row => {
        const kI = qs('.mg-env-k', row), vI = qs('.mg-env-v', row);
        const k = kI.value.trim(), v = vI.value;
        let err = '';
        if (!k && !v) { kI.classList.remove('invalid'); return; }
        if (!ENVKEY_RE.test(k)) err = k ? `"${k}" is not a valid name (letters, digits, underscore; cannot start with a digit)` : 'A value needs a name';
        else if (seen.has(k)) err = `"${k}" is listed twice`;
        kI.classList.toggle('invalid', !!err);
        if (err) errors.push(err); else { env[k] = v; seen.add(k); }
    });
    return { env, errors };
}

function bindEnv(root, ns, onChange) {
    const box = qs('#' + ns + '-env', root), rows = qs('.mg-env-rows', box);
    const sync = () => {
        const n = qsa('.mg-env-row', box).length;
        qs('[data-env-n]', box).textContent = n + (n === 1 ? ' variable' : ' variables');
        qs('[data-env-empty]', box).hidden = n > 0;
        onChange && onChange();
    };
    box.addEventListener('click', e => {
        if (e.target.closest('[data-env-add]')) {
            rows.insertAdjacentHTML('beforeend', envRow('', '', qs('[data-env-reveal]', box).checked));
            qs('.mg-env-row:last-child .mg-env-k', rows).focus();
            sync();
        } else if (e.target.closest('[data-env-rm]')) {
            e.target.closest('.mg-env-row').remove(); sync();
        }
    });
    box.addEventListener('change', e => {
        if (e.target.matches('[data-env-reveal]')) qsa('.mg-env-v', box).forEach(i => { i.type = e.target.checked ? 'text' : 'password'; });
    });
    box.addEventListener('input', () => onChange && onChange());
    sync();
}

// -- resource field: slider + number, default shown beside the field, reset control --
const RES = {
    workers:       { label: 'Workers',    unit: 'workers', log: false, step: 1 },
    max_memory_mb: { label: 'Max memory', unit: 'MB',      log: true,  step: 64 },
    cpu_quota:     { label: 'CPU quota',  unit: '%',       log: true,  step: 5 }
};
// sliders map 0..N onto the allowed range (log scale for memory and CPU so the default is not squeezed to the left edge)
const slMax = (key, [lo, hi]) => RES[key].log ? 100 : hi - lo;
const toT = (key, v, lim) => (RES[key].log ? Math.log(clamp(v, lim[0], lim[1]) / lim[0]) / Math.log(lim[1] / lim[0]) : (clamp(v, lim[0], lim[1]) - lim[0]) / (lim[1] - lim[0])) * slMax(key, lim);
const fromT = (key, t, [lo, hi]) => {
    const f = t / slMax(key, [lo, hi]);
    const v = RES[key].log ? lo * Math.pow(hi / lo, f) : lo + f * (hi - lo);
    const st = RES[key].step;
    return clamp(st > 1 ? Math.max(lo, Math.round(v / st) * st) : Math.round(v), lo, hi);
};
const tickLeft = p => `calc(${p.toFixed(2)}% + ${(7 - p * 0.14).toFixed(2)}px)`;

function resFieldHtml(ns, key, value, def, lim, hint) {
    const r = RES[key], id = `${ns}-${key}`;
    return `<div class="mg-res" data-key="${key}">
        <div class="mg-res-top">
            <label for="${id}">${r.label}</label>
            <span class="mg-def">default <b>${def}${r.unit === '%' ? '%' : ' ' + (r.unit === 'workers' ? '' : r.unit)}</b></span>
            <button type="button" class="mg-reset" data-reset="${key}" aria-label="Reset ${r.label.toLowerCase()} to default (${def}${r.unit === '%' ? '%' : r.unit === 'workers' ? '' : ' ' + r.unit})">Reset to default</button>
        </div>
        <div class="mg-res-ctl">
            <div class="mg-slider"><input type="range" min="0" max="${slMax(key, lim)}" step="1" value="${Math.round(toT(key, value, lim))}" aria-label="${r.label} slider" data-slider="${key}">
                <i class="mg-tick" style="left:${tickLeft(toT(key, def, lim) / slMax(key, lim) * 100)}" title="default ${def}" aria-hidden="true"></i></div>
            <div class="mg-num"><input class="filter-input" id="${id}" type="number" inputmode="numeric" min="${lim[0]}" max="${lim[1]}" step="1" value="${value}" data-num="${key}"><span class="mg-unit">${r.unit}</span></div>
        </div>
        <p class="mg-hint">${hint || ''}<span class="mg-range">allowed ${lim[0]} to ${lim[1]}</span></p>
    </div>`;
}

function readRes(root, ns, key, lim) {
    const inp = qs(`#${ns}-${key}`, root), raw = inp.value.trim();
    const v = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    let err = '';
    if (isNaN(v)) err = `${RES[key].label} must be a whole number`;
    else if (v < lim[0] || v > lim[1]) err = `${RES[key].label} must be between ${lim[0]} and ${lim[1]}`;
    fieldErr(inp, err);
    return { value: v, err };
}

function bindRes(root, ns, defs, lims, onChange) {
    qsa('.mg-res', root).forEach(box => {
        const key = box.dataset.key, num = qs('[data-num]', box), sl = qs('[data-slider]', box), rs = qs('[data-reset]', box);
        const refresh = () => {
            const v = parseInt(num.value, 10);
            rs.disabled = v === defs[key];
            rs.setAttribute('aria-disabled', String(v === defs[key]));
            if (!isNaN(v)) sl.value = Math.round(toT(key, v, lims[key]));
        };
        num.addEventListener('input', () => { refresh(); onChange && onChange(); });
        sl.addEventListener('input', () => { num.value = fromT(key, +sl.value, lims[key]); refresh(); onChange && onChange(); });
        rs.addEventListener('click', () => { num.value = defs[key]; refresh(); fieldErr(num, ''); onChange && onChange(); num.focus(); });
        refresh();
    });
}

// ═══════════════════════════════════════════════════════════
//   SERVICE PANEL (drawer on desktop, full-screen sheet on phone)
// ═══════════════════════════════════════════════════════════
const TABS = [['overview', 'Overview'], ['config', 'Configuration'], ['resources', 'Resources'], ['logs', 'Logs'], ['backups', 'Backups'], ['hook', 'Git &amp; Webhook'], ['operations', 'Operations']];
const P = { name: null, gen: 0, tab: 'overview', d: null, busy: null, inited: new Set(), dirty: {}, timers: {}, logs: null, bk: null, hook: null, dp: null };
let panelReturn = null;
const panelOpen = () => !!P.name && $('mgPanel').open;
const curSvc = () => {
    const s = mg.services.find(x => x.name === P.name) || {};
    return Object.assign({}, P.d || {}, s.status ? { status: s.status, healthy: s.healthy, pid: s.pid } : {}, { name: P.name });
};
const svcJob = () => [...mg.jobs.values()].find(j => j.name === P.name && j.status === 'running');

async function openPanel(name, tab = 'overview') {
    panelReturn = { name, tab, fromList: !!document.activeElement?.closest('.mg-row') };
    clearPanelTimers();
    P.gen++; P.name = name; P.tab = tab; P.d = null; P.busy = null; P.inited = new Set(); P.dirty = {};
    P.logs = { source: 'stdout', lines: 300, grep: '', follow: false, data: null, busy: false, first: true };
    P.bk = null; P.hook = null; P.res = null;
    const dlg = $('mgPanel');
    dlg.innerHTML = `<header class="mg-ph">
            <div class="mg-ph-top">
                <button class="mg-back" data-close aria-label="Close service panel"><svg class="mg-ico-back" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M12.5 4 6.5 10l6 6"/></svg><svg class="mg-ico-x" viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>
                <div class="mg-ph-title"><h2 id="mgPanelTitle">${esc(name)}</h2><div class="mg-ph-sub" id="mgPhSub"></div></div>
                <span id="mgPhSt"></span>
            </div>
            <div class="mg-acts" id="mgActs" role="group" aria-label="Service actions"></div>
            <div id="mgOpNote"></div>
            <div class="mg-ptabs" role="tablist" aria-label="Service sections">${TABS.map(([k, l]) =>
                `<button role="tab" class="mg-ptab" id="mgt-${k}" data-tab="${k}" aria-controls="mgp-${k}" aria-selected="${k === tab}" tabindex="${k === tab ? 0 : -1}">${l}</button>`).join('')}</div>
        </header>
        <div class="mg-pbody" id="mgPBody">${TABS.map(([k]) =>
            `<section class="mg-pane" id="mgp-${k}" role="tabpanel" aria-labelledby="mgt-${k}" tabindex="0"${k === tab ? '' : ' hidden'}><div class="mg-pane-skel">${skelRows(5)}</div></section>`).join('')}</div>`;
    renderPanelHead();
    openDlg(dlg);
    await loadDetail();
}

async function loadDetail() {
    const gen = P.gen, name = P.name;
    const r = await GET(svcPath(name));
    if (gen !== P.gen) return null;
    if (!r.ok) {
        if (!P.d) TABS.forEach(([k]) => { $('mgp-' + k).innerHTML = errBlock(r, 'panel-retry'); });
        else toast('Could not refresh ' + name + ': ' + r.error, true);
        return null;
    }
    P.d = r.data;
    renderPanelHead();
    // rebuild panes whose forms are pristine; overview always refreshes
    ['config', 'resources'].forEach(k => { if (!P.dirty[k]) P.inited.delete(k); });
    P.inited.delete('overview');
    showTab(P.tab, true);
    return r.data;
}

function renderPanelHead() {
    if (!panelOpen()) return;
    const s = curSvc(), run = isRunning(s), busy = P.busy, job = svcJob(), off = !!busy || !!job;
    const dom = s.domain ? `<a href="https://${esc(s.domain)}" target="_blank" rel="noopener noreferrer">${esc(s.domain)}</a>` : '<span class="mg-muted">no domain</span>';
    $('mgPhSub').innerHTML = `${dom}<span class="mg-sep" aria-hidden="true">/</span>${rtBadge(s.runtime)}${s.branch ? `<span class="mg-sep" aria-hidden="true">/</span><span class="mg-mono">${esc(s.branch)}</span>` : ''}`;
    $('mgPhSt').innerHTML = s.status ? stHtml(s) : '';
    const label = (k, idle, doing) => busy === k ? doing : idle;
    const btn = (k, cls, text, dis, why) => `<button class="${cls} mg-lg" data-pa="${k}"${dis ? ' disabled' : ''}${dis && why ? ` title="${esc(why)}"` : ''}>${text}</button>`;
    $('mgActs').innerHTML =
        btn('start', run ? 'term-btn' : 'dk-primary', label('start', 'Start', 'Starting...'), off || run, run ? 'Already running' : job ? 'An operation is running' : '') +
        btn('stop', 'term-btn', label('stop', 'Stop', 'Stopping...'), off || !run, !run ? 'Not running' : '') +
        btn('restart', 'term-btn', label('restart', 'Restart', 'Restarting...'), off || !run, !run ? 'Not running' : '') +
        '<span class="mg-actsep" aria-hidden="true"></span>' +
        btn('update', 'term-btn', 'Update now', off, job ? 'An operation is running' : '') +
        btn('redeploy', 'term-btn', 'Redeploy', off, job ? 'An operation is running' : '') +
        btn('delete', 'mg-btn-danger', 'Delete', off, job ? 'An operation is running' : '');
    $('mgOpNote').innerHTML = job ? `<div class="mg-opnote"><span class="mg-spin" aria-hidden="true"></span><span><b>${esc(jobLabel(job))}</b> is running for this service.</span><button class="mg-link" data-pa="viewjob">View log</button></div>` : '';
}

function onListRefreshed() { if (panelOpen()) renderPanelHead(); }

function afterJob(j) {
    if (j.op === 'system.install') { mg.depsAt = 0; loadDeps(); }
    if (j.op === 'cloudflare.config.set' && $('mgSettings').open && S.tab === 'cf') loadCloudflare();
    if (j.op === 'services.delete' && j.status === 'done') fetchManage(true);
    if (j.op === 'services.deploy' && j.status === 'done' && D.v && D.v.name === j.name) D.v = null;
    if (panelOpen() && P.name === j.name) {
        if (j.op === 'services.delete' && j.status === 'done') { closeDlg($('mgPanel')); return; }
        loadDetail();
        if (['backups.create', 'backups.restore'].includes(j.op)) loadBackups();
        if (j.op === 'webhook.test') loadHook();
        if (P.tab === 'logs') loadLogs();
        if (P.tab === 'operations' && !P.dirty.operations) loadOperations();
        renderPanelHead();
    }
}

// tabs
function showTab(tab, rerender) {
    const changed = P.tab !== tab;
    P.tab = tab;
    qsa('.mg-ptab', $('mgPanel')).forEach(b => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    qsa('.mg-pane', $('mgPanel')).forEach(p => { p.hidden = p.id !== 'mgp-' + tab; });
    if (changed) $('mgPanel').querySelector('.mg-pbody').scrollTop = 0;
    stopLive(); stopFollow();
    if (!P.d) return;
    const pane = PANES[tab];
    if (!P.inited.has(tab)) { P.inited.add(tab); pane.init(); }
    if (pane.show) pane.show();
}

$('mgPanel').addEventListener('click', e => {
    const t = e.target.closest('.mg-ptab');
    if (t) { showTab(t.dataset.tab); return; }
    const a = e.target.closest('[data-pa]');
    if (a) { panelAction(a.dataset.pa); return; }
    const r = e.target.closest('[data-act="panel-retry"]');
    if (r) loadDetail();
});
$('mgPanel').addEventListener('keydown', e => {
    const t = e.target.closest('.mg-ptab');
    if (!t || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const tabs = qsa('.mg-ptab', $('mgPanel')), i = tabs.indexOf(t);
    const n = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[tabs.length - 1] : tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    n.focus(); showTab(n.dataset.tab);
});

async function requestClosePanel() {
    const dirty = Object.keys(P.dirty).filter(k => P.dirty[k]);
    if (dirty.length) {
        const r = await confirmDlg({ title: 'Discard unsaved changes?', body: '<p>The ' + dirty.map(k => ({config: 'Configuration', resources: 'Resources', operations: 'Operations'}[k] || k)).join(' and ') + ' form has changes that were not saved.</p>', confirm: 'Discard changes', danger: true, cancel: 'Keep editing' });
        if (!r) return;
        P.dirty = {};
    }
    closeDlg($('mgPanel'));
}
$('mgPanel').addEventListener('cancel', e => { if (Object.values(P.dirty).some(Boolean)) { e.preventDefault(); requestClosePanel(); } });
$('mgPanel').addEventListener('close', () => { clearPanelTimers(); P.gen++; P.name = null;
    if (panelReturn?.fromList) {
        const row = qsa('.mg-row').find(r => r.dataset.name === panelReturn.name);
        const target = panelReturn.tab === 'overview' ? row?.querySelector('[data-open]') : row?.querySelector(`[data-service-tab="${panelReturn.tab}"]`);
        (target || $('mgSearch')).focus({ preventScroll: true });
    }
});
// the back/close button should honour unsaved changes too
$('mgPanel').addEventListener('click', e => {
    if (e.target.closest('.mg-back')) { e.stopImmediatePropagation(); requestClosePanel(); }
}, true);

function clearPanelTimers() { Object.keys(P.timers).forEach(k => { clearTimeout(P.timers[k]); clearInterval(P.timers[k]); }); P.timers = {}; }
const stopLive = () => { clearTimeout(P.timers.live); };
const stopFollow = () => { clearInterval(P.timers.follow); };

// ── header actions ──
async function panelAction(act) {
    const name = P.name, s = curSvc();
    switch (act) {
        case 'viewjob': { const j = svcJob(); if (j) openJob(j); return; }
        case 'start': return runSync('start', 'Started');
        case 'stop':
            if (await confirmDlg({ title: 'Stop ' + name + '?', body: `<p><b>${esc(name)}</b> will stop answering requests until you start it again.</p>`, confirm: 'Stop service', danger: true })) runSync('stop', 'Stopped');
            return;
        case 'restart':
            if (await confirmDlg({ title: 'Restart ' + name + '?', body: `<p>Restarting drops in-flight requests on <b>${esc(name)}</b> for a few seconds.</p>`, confirm: 'Restart service', danger: true })) runSync('restart', 'Restarted');
            return;
        case 'update': {
            const how = s.runtime === 'docker' ? 'pull the latest code, rebuild the Docker image and restart the container' : 'pull the latest code, reinstall dependencies if they changed and restart the service';
            if (!await confirmDlg({ title: 'Update ' + name + ' now?', body: `<p>This will ${how}. The service is briefly unavailable while it restarts.</p>`, confirm: 'Update now' })) return;
            adoptJob(await POST(svcPath(name, '/action'), { action: 'update' }), 'Updating', true);
            return;
        }
        case 'redeploy': return openRedeploy();
        case 'delete': return openDelete();
    }
}

async function runSync(action, past) {
    const name = P.name;
    P.busy = action; renderPanelHead();
    const r = await POST(svcPath(name, '/action'), { action });
    P.busy = null;
    if (r.ok) toast(`${name}: ${past.toLowerCase()}${r.data && r.data.message && !/ok$/.test(r.data.message) ? ' (' + r.data.message + ')' : ''}`);
    else toast(`Could not ${action} ${name}: ${r.error}`, true);
    await fetchManage(true);
    if (panelOpen() && P.name === name) { await loadDetail(); renderPanelHead(); }
}

function adoptJob(r, label, open) {
    if (r.ok) {
        const j = trackJob(r.data.job_id, r.data.op, r.data.name, label);
        renderPanelHead();
        if (open) openJob(j);
        return j;
    }
    toast(r.error, true);
    if (r.code === 'busy' && r.job_id) { const j = trackJob(r.job_id, '', P.name || ''); renderPanelHead(); if (open) openJob(j); return j; }
    return null;
}

async function openRedeploy() {
    const name = P.name, s = curSvc();
    const res = await confirmDlg({
        title: 'Redeploy ' + name, confirm: 'Redeploy',
        body: `<p>Redeploy clones the repository again, rebuilds and restarts <b>${esc(name)}</b>. Use it to switch repository or branch, or to rebuild from scratch.</p>
               ${/\*\*\*/.test(s.repo_url || '') ? '<p class="mg-note warn">The stored repository URL contains a token that is hidden here. Enter the full URL again.</p>' : ''}`,
        fields: [{ id: 'repo_url', label: 'Repository URL', value: s.repo_url || '', inputmode: 'url' }, { id: 'branch', label: 'Branch', value: s.branch || '' }],
        validate: v => !/^(https:\/\/|git@)\S+$/.test(v.repo_url) ? 'Repository URL must start with https:// or git@' :
            /\*\*\*/.test(v.repo_url) ? 'The URL still contains the hidden token placeholder (***). Enter the full URL.' :
            !BRANCH_RE.test(v.branch) || v.branch.includes('..') ? 'Branch name is not valid' : ''
    });
    if (!res) return;
    adoptJob(await POST(svcPath(name, '/redeploy'), { repo_url: res.values.repo_url, branch: res.values.branch }), 'Redeploying', true);
}

async function openDelete() {
    const name = P.name, s = curSvc();
    const res = await confirmDlg({
        title: 'Delete ' + name, confirm: 'Delete service', danger: true, type: name,
        body: `<p>This stops <b>${esc(name)}</b>, removes its systemd unit, Cloudflare route${s.runtime === 'docker' ? ', container and image' : ''}. It cannot be undone.</p>`,
        checks: [{ id: 'delete_files', label: 'Delete the service files' + (s.path ? ' in ' + s.path : ''), checked: true },
                 { id: 'delete_backups', label: 'Also delete its backups', checked: false },
                 { id: 'backup_first', label: 'Create a backup before deleting', checked: false }]
    });
    if (!res) return;
    const r = await DEL(svcPath(name), Object.assign({ confirm: name }, res.checks));
    if (!r.ok) { adoptJob(r, 'Deleting', true); return; }
    if (r.status === 202) { adoptJob(r, 'Deleting', true); return; }
    toast(`Deleted ${name}`);
    closeDlg($('mgPanel'));
    fetchManage(true);
}

// ═══════════════════════════════════════════════════════════
//   PANES
// ═══════════════════════════════════════════════════════════
const PANES = {};
const ESTIMATE_RESTART = new Set(['domain', 'port', 'workers', 'max_memory_mb', 'cpu_quota', 'container_port', 'env']);

const dl = rows => `<dl class="mg-dl">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const flag = (cls, text) => `<span class="mg-flag ${cls}">${text}</span>`;

// ── Overview ───────────────────────────────────────────────
function liveCellsHtml(r, d) {
    const run = isRunning(curSvc());
    const cell = (l, v, pct, sub) => `<div><span class="dk-st-l">${l}</span><span class="mg-live-v">${v}</span>${pct == null ? '' : `<span class="dk-bar"><i class="${pct > 90 ? 'crit' : pct > 75 ? 'warn' : ''}" style="width:${clamp(pct, 0, 100)}%"></i></span>`}<span class="mg-live-s">${sub || '&nbsp;'}</span></div>`;
    if (!r || !run) {
        const dash = '<span class="mg-muted">&mdash;</span>';
        return cell('CPU', dash, null, run ? 'reading...' : 'not running') + cell('Memory', dash, null, 'limit ' + fmtMem(d.max_memory_mb)) + cell('Processes', dash, null, '') + cell('Uptime', dash, null, '');
    }
    const quota = (r.limits && r.limits.cpu_quota) || d.cpu_quota || 100;
    return cell('CPU', num(r.cpu_pct) + '%', r.cpu_pct / quota * 100, 'of ' + quota + '% quota') +
        cell('Memory', fmtMem(Math.round(r.mem_mb)), r.mem_mb / (r.mem_limit_mb || d.max_memory_mb) * 100, 'of ' + fmtMem(r.mem_limit_mb || d.max_memory_mb)) +
        cell('Processes', num(r.pids), null, (r.limits && r.limits.workers ? r.limits.workers + ' workers' : '')) +
        cell('Uptime', fmtUptime(r.uptime_s), null, 'since last start');
}

PANES.overview = {
    init() {
        const d = P.d, g = d.git || {}, cf = d.cloudflare || {}, ld = d.last_deploy;
        const gitFlags = [g.dirty ? flag('warn', 'uncommitted changes') : '', g.behind ? flag('warn', g.behind + ' behind origin') : '', g.ahead ? flag('warn', g.ahead + ' ahead') : '',
            !g.dirty && !g.behind && !g.ahead ? flag('ok', 'clean, up to date') : ''].join(' ');
        const cfHtml = !d.cloudflare ? '<span class="mg-muted">unknown</span>' : !cf.route_present ? flag('bad', 'no route') + ' <span class="mg-muted">Open Settings, Cloudflare, and sync routes.</span>' : cf.correct ? flag('ok', 'route present and correct') : flag('warn', 'route present but points elsewhere');
        $('mgp-overview').innerHTML = `
            <div class="mg-stats" id="mgLive">${liveCellsHtml(null, d)}</div>
            <div class="mg-cols">
                <section>
                    <div class="sec-label">Service</div>
                    ${dl([['Runtime', esc(RT[d.runtime] || d.runtime)], ['Domain', d.domain ? `<a href="https://${esc(d.domain)}" target="_blank" rel="noopener noreferrer">${esc(d.domain)}</a>` : '—'],
                        ['Port', num(d.port) + (d.docker ? ' &rarr; container ' + num(d.docker.container_port) : '')], ['Path', `<code>${esc(d.path)}</code>`],
                        ['Resources', `${d.workers} workers, ${fmtMem(d.max_memory_mb)}, ${d.cpu_quota}% CPU`], ['Updates', d.auto_update ? 'automatic on push' : 'manual only'],
                        d.docker ? ['Container', `<code>${esc(d.docker.container)}</code> from <code>${esc(d.docker.image)}</code>`] : null,
                        ['Created', esc(fmtDate(d.created_at))]])}
                </section>
                <section>
                    <div class="sec-label">Source</div>
                    ${dl([['Repository', `<code>${esc(repoShort(d.repo_url))}</code>`], ['Branch', `<code>${esc(d.branch)}</code>`],
                        ['Commit', g.commit ? `<code>${esc(g.commit)}</code> ${esc(g.subject || '')}` : '—'], ['Working tree', gitFlags]])}
                    <div class="sec-label">Cloudflare route</div>
                    ${dl([['Hostname', esc(d.domain || '—')], ['Route', cfHtml]])}
                </section>
            </div>
            <div class="sec-label">Last deploy</div>
            <div id="mgLastDeploy">${ld ? dl([['Result', flag(ld.status === 'success' ? 'ok' : ld.status === 'failed' ? 'bad' : 'warn', esc(ld.status))], ['When', esc(fmtDate(ld.timestamp)) + ' <span class="mg-muted">' + esc(fmtAgo(ld.timestamp)) + '</span>'], ['Duration', esc(fmtDur(ld.duration_seconds) || '—')]]) : '<p class="mg-muted">This service has not been deployed through ats yet.</p>'}</div>
            <div class="sec-label">Recent operations</div>
            <div id="mgOps"></div>
            <div class="sec-label">Systemd unit</div>
            <details class="mg-details"><summary>${d.runtime === 'docker' ? 'Show unit file (wraps the container)' : 'Show unit file'}</summary><pre class="mg-pre" tabindex="0">${esc(d.unit_file || 'No unit file reported.')}</pre></details>
            <div class="sec-label">${d.runtime === 'docker' ? 'Container status' : 'Service status'}<button class="mg-link mg-sl-btn" data-act="ov-status">Refresh</button></div>
            <pre class="mg-pre" id="mgStatusText" tabindex="0">Loading...</pre>`;
        PANES.overview.ops();
        PANES.overview.status();
    },
    show() { PANES.overview.live(); },
    ops() {
        const rows = [...mg.jobs.values(), ...mg.history].filter((j, i, a) => j.name === P.name && a.findIndex(x => x.id === j.id) === i)
            .sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, 6);
        $('mgOps').innerHTML = rows.length
            ? `<table class="mg-mini"><thead><tr><th scope="col">Operation</th><th scope="col">Result</th><th scope="col">Started</th></tr></thead><tbody>${rows.map(j =>
                `<tr><td>${esc(OP_LABELS[j.op] || j.label || j.op || 'Operation')}</td><td>${flag(j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'warn', j.status === 'done' ? 'done' : j.status)}</td><td class="mg-muted">${esc(fmtAgo(j.started))}</td></tr>`).join('')}</tbody></table>`
            : '<p class="mg-muted">Nothing has been run from the monitor in the last 24 hours.</p>';
    },
    async status() {
        const gen = P.gen;
        const r = await GET(svcPath(P.name, '/status'));
        if (gen !== P.gen || !$('mgStatusText')) return;
        $('mgStatusText').textContent = r.ok ? (r.data.text || '(empty)') : 'Could not read status: ' + r.error;
    },
    live() {
        const gen = P.gen, name = P.name;
        stopLive();
        const tick = async () => {
            if (gen !== P.gen || P.tab !== 'overview' || !panelOpen()) return;
            if (!document.hidden) {
                const r = await GET(svcPath(name, '/resources'));
                if (gen !== P.gen || P.tab !== 'overview') return;
                const box = $('mgLive');
                if (box && P.d) box.innerHTML = r.ok ? liveCellsHtml(r.data, P.d) : liveCellsHtml(null, P.d);
            }
            P.timers.live = setTimeout(tick, 3000);
        };
        tick();
    }
};
$('mgPanel').addEventListener('click', e => { if (e.target.closest('[data-act="ov-status"]')) PANES.overview.status(); });

// ── change summaries ───────────────────────────────────────
function diffHtml(changes) {
    return `<div class="mg-diff">${changes.map(c => c.rows
        ? `<div class="mg-diff-g"><span class="k">${esc(c.label)}</span>${c.rows.map(r => `<div class="mg-diff-r ${r.t}"><b aria-hidden="true">${r.t === 'add' ? '+' : r.t === 'del' ? '-' : '~'}</b><code>${esc(r.text)}</code><span class="sr-only">${r.t === 'add' ? 'added' : r.t === 'del' ? 'removed' : 'changed'}</span></div>`).join('')}</div>`
        : `<div class="mg-diff-g"><span class="k">${esc(c.label)}</span><div class="mg-diff-r del"><b aria-hidden="true">-</b><code>${esc(c.from)}</code><span class="sr-only">was</span></div><div class="mg-diff-r add"><b aria-hidden="true">+</b><code>${esc(c.to)}</code><span class="sr-only">now</span></div></div>`).join('')}</div>`;
}
const restartNote = changes => {
    const need = changes.some(c => ESTIMATE_RESTART.has(c.key));
    return need ? '<p class="mg-note warn">Expected: the service restarts to apply this and is briefly unavailable. ats makes the final call.</p>'
                : '<p class="mg-note">Expected: no restart. The change applies at the next update or deploy.</p>';
};

async function savePatch(patch, changes, formKey, errSlotId) {
    const name = P.name;
    const ok = await confirmDlg({ title: 'Review changes to ' + name, confirm: 'Save changes', body: diffHtml(changes) + restartNote(changes) });
    if (!ok) return false;
    const slot = $(errSlotId); if (slot) slot.innerHTML = '';
    const r = await PATCH(svcPath(name), patch);
    if (!r.ok) {
        if (slot) slot.innerHTML = `<div class="mg-note bad" role="alert"><b>Not saved.</b> ${esc(r.error)}</div>`;
        toast('Not saved: ' + r.error, true);
        return false;
    }
    const restarted = r.data.restarted != null ? r.data.restarted : /restarted\W+true/i.test(r.data.message || '');
    toast(`Saved ${name}. ${restarted ? 'The service was restarted.' : 'No restart was needed.'}`);
    P.dirty[formKey] = false;
    P.d = r.data;
    ['config', 'resources', 'overview'].forEach(k => { if (!P.dirty[k]) P.inited.delete(k); });
    renderPanelHead();
    showTab(P.tab, true);
    fetchManage(true);
    return true;
}

// ── Configuration ──────────────────────────────────────────
PANES.config = {
    init() {
        const d = P.d, el = $('mgp-config'), dock = d.runtime === 'docker';
        const redacted = /\*\*\*/.test(d.repo_url || '');
        el.innerHTML = `<form class="mg-form" id="mgCfg" novalidate autocomplete="off">
            <div class="mg-config-fields">
            <div id="mgCfgErr"></div>
            <section class="mg-config-section" aria-labelledby="cf-connection-title">
            <h3 id="cf-connection-title">Connection</h3>
            ${domainFieldHtml('cf', d.domain)}
            <div class="mg-f"><label for="cf-port">Port</label>
                <div class="mg-inline"><input class="filter-input" id="cf-port" type="number" inputmode="numeric" min="1" max="65535" value="${num(d.port)}"><button type="button" class="term-btn" id="cf-suggest">Suggest a free port</button></div>
                <p class="mg-hint">Cloudflare forwards traffic to this local port.</p></div>
            </section>
            <section class="mg-config-section" aria-labelledby="cf-source-title">
            <h3 id="cf-source-title">Source</h3>
            <div class="mg-f"><label for="cf-repo">Repository URL</label><input class="filter-input" id="cf-repo" value="${esc(d.repo_url)}" spellcheck="false" autocapitalize="off" inputmode="url">
                <p class="mg-hint">${redacted ? 'The stored URL contains a token, so it is shown redacted. Leave it as it is to keep it, or paste a full URL to replace it.' : 'https:// or git@ URL.'}</p></div>
            <div class="mg-f"><label for="cf-branch">Branch</label><input class="filter-input" id="cf-branch" value="${esc(d.branch)}" spellcheck="false" autocapitalize="off">
                <p class="mg-hint">Webhook pushes and "Update now" follow this branch.</p></div>
            <div class="mg-f"><label for="cf-runtime">Runtime</label><input class="filter-input" id="cf-runtime" value="${esc(RT[d.runtime] || d.runtime)}" disabled>
                <p class="mg-hint">Fixed after deploy. To change runtime, use Redeploy and create the service again.</p></div>
            ${dock ? `<div class="mg-f"><label for="cf-cport">Container port</label><input class="filter-input" id="cf-cport" type="number" inputmode="numeric" min="1" max="65535" value="${num(d.container_port != null ? d.container_port : d.docker && d.docker.container_port)}">
                <p class="mg-hint">The port the app listens on inside the container. Published on 127.0.0.1:${num(d.port)}.</p></div>` : ''}
            </section>
            <section class="mg-config-section" aria-labelledby="cf-environment-title">
            <h3 id="cf-environment-title">Environment</h3>
            <div class="mg-f"><span class="mg-lbl" id="cf-env-l">Environment variables</span>${envEditorHtml('cf', d.env)}
                <p class="mg-hint">Values stay hidden until you choose to show them.</p></div>
            </section>
            </div>
            <div class="mg-formbar"><span class="mg-fstate" id="cf-state" aria-live="polite">No changes</span>
                <button type="button" class="term-btn mg-lg" id="cf-discard" disabled>Discard</button><button type="submit" class="dk-primary mg-lg" id="cf-save" disabled>Review and save</button></div>
        </form>`;
        const form = $('mgCfg');
        const upd = () => PANES.config.update();
        P.dp = bindDomain(form, 'cf', d.domain, upd);
        bindEnv(form, 'cf', upd);
        form.addEventListener('input', upd);
        $('cf-suggest').addEventListener('click', async () => {
            const r = await GET('/ports/suggest');
            if (r.ok) { $('cf-port').value = r.data.port; upd(); toast('Port ' + r.data.port + ' is free'); } else toast(r.error, true);
        });
        $('cf-discard').addEventListener('click', () => { P.dirty.config = false; P.inited.delete('config'); showTab('config'); });
        form.addEventListener('submit', e => { e.preventDefault(); PANES.config.save(); });
        upd();
    },
    collect() {
        const d = P.d, f = $('mgCfg'), patch = {}, changes = [], errors = [];
        const dom = readDomain(f, 'cf');
        if (dom && dom !== d.domain) {
            if (!HOST_RE.test(dom) || P.dp.state === 'bad') errors.push('Domain is not a valid hostname');
            else if (P.dp.state === 'taken') errors.push('Domain is already used by another service');
            else { patch.domain = dom; changes.push({ key: 'domain', label: 'Domain', from: d.domain, to: dom }); }
        } else if (!dom) errors.push('Domain is required');
        const portI = $('cf-port'), pv = portI.value.trim(); let perr = '';
        if (!/^\d+$/.test(pv) || +pv < 1 || +pv > 65535) perr = 'Port must be between 1 and 65535';
        fieldErr(portI, perr);
        if (perr) errors.push(perr); else if (+pv !== d.port) { patch.port = +pv; changes.push({ key: 'port', label: 'Port', from: String(d.port), to: pv }); }
        const repoI = $('cf-repo'), rv = repoI.value.trim(); let rerr = '';
        if (rv !== d.repo_url) {
            if (!/^(https:\/\/|git@)\S+$/.test(rv)) rerr = 'Repository URL must start with https:// or git@';
            else if (/\*\*\*/.test(rv)) rerr = 'The URL still has the hidden token placeholder (***). Paste the full URL or leave the field unchanged.';
        }
        fieldErr(repoI, rerr);
        if (rerr) errors.push(rerr); else if (rv !== d.repo_url) { patch.repo_url = rv; changes.push({ key: 'repo_url', label: 'Repository', from: repoShort(d.repo_url), to: repoShort(rv) }); }
        const brI = $('cf-branch'), bv = brI.value.trim(); let berr = '';
        if (!BRANCH_RE.test(bv) || bv.includes('..')) berr = 'Branch name is not valid';
        fieldErr(brI, berr);
        if (berr) errors.push(berr); else if (bv !== d.branch) { patch.branch = bv; changes.push({ key: 'branch', label: 'Branch', from: d.branch, to: bv }); }
        const cp = $('cf-cport');
        if (cp) {
            const cv = cp.value.trim(), orig = d.container_port != null ? d.container_port : d.docker && d.docker.container_port;
            const cerr = !/^\d+$/.test(cv) || +cv < 1 || +cv > 65535 ? 'Container port must be between 1 and 65535' : '';
            fieldErr(cp, cerr);
            if (cerr) errors.push(cerr); else if (+cv !== orig) { patch.container_port = +cv; changes.push({ key: 'container_port', label: 'Container port', from: String(orig), to: cv }); }
        }
        const { env, errors: ee } = readEnv(f, 'cf');
        errors.push(...ee);
        if (!ee.length) {
            const rows = [];
            Object.keys(env).forEach(k => { if (!(k in (d.env || {}))) rows.push({ t: 'add', text: k }); else if (env[k] !== d.env[k]) rows.push({ t: 'chg', text: k + ' (value changed)' }); });
            Object.keys(d.env || {}).forEach(k => { if (!(k in env)) rows.push({ t: 'del', text: k }); });
            if (rows.length) { patch.env = env; changes.push({ key: 'env', label: 'Environment variables', rows }); }
        }
        return { patch, changes, errors };
    },
    update() {
        if (!$('mgCfg')) return;
        const c = PANES.config.collect(), n = c.changes.length;
        P.dirty.config = n > 0;
        $('cf-state').textContent = c.errors.length ? c.errors.length + (c.errors.length === 1 ? ' problem to fix' : ' problems to fix') : n ? n + (n === 1 ? ' unsaved change' : ' unsaved changes') : 'No changes';
        $('cf-state').classList.toggle('bad', c.errors.length > 0);
        $('cf-save').disabled = !n || c.errors.length > 0 || ['checking'].includes(P.dp.state);
        $('cf-discard').disabled = !n && !c.errors.length;
    },
    async save() {
        const c = PANES.config.collect();
        if (c.errors.length || !c.changes.length) return;
        const btn = $('cf-save'); btn.disabled = true; btn.textContent = 'Saving...';
        const ok = await savePatch(c.patch, c.changes, 'config', 'mgCfgErr');
        if (!ok && $('cf-save')) { $('cf-save').textContent = 'Review and save'; PANES.config.update(); }
    }
};

// ── Resources ──────────────────────────────────────────────
PANES.resources = {
    init() {
        const d = P.d, lim = Object.assign({}, DEFAULT_LIMITS, d.limits || {}), def = Object.assign({ workers: 4, max_memory_mb: 512, cpu_quota: 50 }, d.defaults || {});
        P.lim = lim; P.def = def;
        const hint = {
            workers: d.runtime === 'python' ? 'Gunicorn worker processes. More workers use more memory.' : 'Used by the Python runtime. Stored for other runtimes but not applied.',
            max_memory_mb: d.runtime === 'docker' ? 'Passed to the container as --memory. Over the limit the container is killed.' : 'Systemd MemoryMax for the service. Over the limit the process is killed.',
            cpu_quota: d.runtime === 'docker' ? '100% is one core. Passed to the container as --cpus.' : '100% is one core. Systemd CPUQuota for the service.'
        };
        $('mgp-resources').innerHTML = `<form class="mg-form" id="mgRes" novalidate autocomplete="off">
            <div id="mgResErr"></div>
            <p class="mg-lead">Limits for <b>${esc(d.name)}</b>. The default beside each field is what new deployments start with; change the defaults in Settings.</p>
            <div class="mg-resbox">${['workers', 'max_memory_mb', 'cpu_quota'].map(k => resFieldHtml('rs', k, d[k], def[k], lim[k], hint[k] + ' ')).join('')}</div>
            <div class="mg-formbar"><span class="mg-fstate" id="rs-state" aria-live="polite">No changes</span>
                <button type="button" class="term-btn mg-lg" id="rs-all">Reset all to defaults</button>
                <button type="submit" class="dk-primary mg-lg" id="rs-save" disabled>Review and save</button></div></form>`;
        const f = $('mgRes');
        bindRes(f, 'rs', def, lim, () => PANES.resources.update());
        $('rs-all').addEventListener('click', () => {
            ['workers', 'max_memory_mb', 'cpu_quota'].forEach(k => { const b = qs(`[data-reset="${k}"]`, f); if (!b.disabled) b.click(); });
            $('rs-all').focus();
        });
        f.addEventListener('submit', e => { e.preventDefault(); PANES.resources.save(); });
        PANES.resources.update();
    },
    collect() {
        const d = P.d, f = $('mgRes'), patch = {}, changes = [], errors = [];
        ['workers', 'max_memory_mb', 'cpu_quota'].forEach(k => {
            const r = readRes(f, 'rs', k, P.lim[k]);
            if (r.err) errors.push(r.err);
            else if (r.value !== d[k]) {
                patch[k] = r.value;
                const u = RES[k].unit === '%' ? '%' : RES[k].unit === 'MB' ? ' MB' : '';
                changes.push({ key: k, label: RES[k].label, from: d[k] + u, to: r.value + u });
            }
        });
        return { patch, changes, errors };
    },
    update() {
        if (!$('mgRes')) return;
        const c = PANES.resources.collect(), n = c.changes.length;
        P.dirty.resources = n > 0;
        $('rs-state').textContent = c.errors.length ? c.errors.length + (c.errors.length === 1 ? ' problem to fix' : ' problems to fix') : n ? n + (n === 1 ? ' unsaved change' : ' unsaved changes') : 'No changes';
        $('rs-state').classList.toggle('bad', c.errors.length > 0);
        $('rs-save').disabled = !n || c.errors.length > 0;
        const allDef = ['workers', 'max_memory_mb', 'cpu_quota'].every(k => parseInt($('rs-' + k).value, 10) === P.def[k]);
        $('rs-all').disabled = allDef;
    },
    async save() {
        const c = PANES.resources.collect();
        if (c.errors.length || !c.changes.length) return;
        const btn = $('rs-save'); btn.disabled = true; btn.textContent = 'Saving...';
        const ok = await savePatch(c.patch, c.changes, 'resources', 'mgResErr');
        if (!ok && $('rs-save')) { $('rs-save').textContent = 'Review and save'; PANES.resources.update(); }
    }
};

// ── Logs ───────────────────────────────────────────────────
const LOG_SOURCES = ['stdout', 'stderr', 'access', 'error', 'journal'];
const logCls = l => /\b(ERROR|CRITICAL|FATAL|Traceback|Exception)\b/.test(l) ? 'log-error' : /\bWARN(ING)?\b/i.test(l) ? 'log-warning' : /\bDEBUG\b/.test(l) ? 'log-debug' : '';

PANES.logs = {
    init() {
        const L = P.logs;
        $('mgp-logs').innerHTML = `<div class="mg-logs">
            <div class="mg-logtools">
                <div class="mg-srcs" id="mgSrcs" role="group" aria-label="Log source">${LOG_SOURCES.map(s => `<button class="dk-chip${s === L.source ? ' active' : ''}" data-src="${s}" aria-pressed="${s === L.source}">${s}<b></b></button>`).join('')}</div>
                <div class="mg-logrow">
                    <label class="mg-sel"><span class="sr-only">Lines</span><select class="filter-input" id="mgLogLines" aria-label="Number of lines">${[100, 300, 1000, 5000].map(n => `<option${n === L.lines ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
                    <input class="filter-input mg-logfilter" id="mgLogGrep" type="search" placeholder="Filter lines (case-insensitive)" aria-label="Filter log lines" autocomplete="off" value="${esc(L.grep)}">
                    <label class="toggle-label"><input type="checkbox" id="mgLogFollow"><span>Follow</span></label>
                    <button class="term-btn" id="mgLogRefresh">Refresh</button>
                    <button class="term-btn" id="mgLogDl">Download</button>
                    <button class="term-btn" id="mgLogClear">Clear</button>
                </div>
            </div>
            <div class="log-viewer mg-logview" id="mgLogView" tabindex="0" role="region" aria-label="Log output"><div class="mg-skel-pad">${skelRows(6)}</div></div>
            <div class="mg-logfoot" id="mgLogFoot"></div></div>`;
        const el = $('mgp-logs');
        el.addEventListener('click', e => {
            const s = e.target.closest('[data-src]');
            if (s && !s.disabled) { P.logs.source = s.dataset.src; P.logs.first = true; qsa('[data-src]', el).forEach(b => { b.classList.toggle('active', b === s); b.setAttribute('aria-pressed', String(b === s)); }); loadLogs(); }
        });
        $('mgLogLines').addEventListener('change', e => { P.logs.lines = +e.target.value; P.logs.first = true; loadLogs(); });
        let t; $('mgLogGrep').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { P.logs.grep = e.target.value.trim(); P.logs.first = true; loadLogs(); }, 400); });
        $('mgLogFollow').addEventListener('change', e => { P.logs.follow = e.target.checked; PANES.logs.show(); });
        $('mgLogRefresh').addEventListener('click', () => { P.logs.first = true; loadLogs(true); });
        $('mgLogDl').addEventListener('click', () => {
            const L2 = P.logs; if (!L2.data) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([L2.data.lines.join('\n') + '\n'], { type: 'text/plain' }));
            a.download = `${P.name}-${L2.source}.log`; document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        });
        $('mgLogClear').addEventListener('click', async () => {
            const src = P.logs.source;
            const ok = await confirmDlg({ title: `Clear ${src} log?`, body: `<p>The file for <b>${esc(P.name)}</b> is truncated, not deleted. Lines already written are lost.</p>`, confirm: 'Clear log', danger: true });
            if (!ok) return;
            const r = await POST(svcPath(P.name, '/logs/clear'), { source: src });
            toast(r.ok ? `Cleared ${src} log` : r.error, !r.ok);
            if (r.ok) loadLogs();
        });
        loadLogs();
    },
    show() {
        stopFollow();
        if (P.logs.follow && P.tab === 'logs') P.timers.follow = setInterval(() => { if (!document.hidden) loadLogs(); }, 3000);
    }
};

async function loadLogs(manual) {
    const L = P.logs, gen = P.gen, name = P.name;
    if (!L || L.busy) return;
    L.busy = true;
    const q = `?source=${L.source}&lines=${L.lines}` + (L.grep ? '&grep=' + encodeURIComponent(L.grep) : '');
    const r = await GET(svcPath(name, '/logs') + q);
    L.busy = false;
    if (gen !== P.gen || !$('mgLogView')) return;
    const view = $('mgLogView');
    if (!r.ok) { view.innerHTML = `<div class="mg-pad">${errBlock(r, 'logs-retry')}</div>`; $('mgLogFoot').textContent = ''; return; }
    L.data = r.data;
    qsa('[data-src]', $('mgSrcs')).forEach(b => {
        const have = r.data.sources || [], s = have.find(x => x.id === b.dataset.src);
        const gone = have.length > 0 && (!s || !s.exists);
        b.disabled = gone;
        b.title = gone ? 'This log is not available for this service' : '';
        qs('b', b).textContent = s ? (s.exists ? fmtBytes(s.size_bytes) : 'n/a') : have.length ? 'n/a' : '';
    });
    const lines = r.data.lines || [];
    const atEnd = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
    view.innerHTML = lines.length
        ? lines.map(l => `<div class="log-line ${logCls(l)}">${esc(l)}</div>`).join('')
        : `<div class="log-empty">${L.grep ? 'No lines match the filter.' : 'This log is empty.'}</div>`;
    if (L.first || atEnd || L.follow) view.scrollTop = view.scrollHeight;
    L.first = false;
    $('mgLogFoot').textContent = `${lines.length} lines shown${L.grep ? ' (filtered)' : ''} · file size ${fmtBytes(r.data.size_bytes)} · updated ${new Date().toLocaleTimeString('en-GB')}`;
    $('mgLogClear').disabled = L.source === 'journal';
    $('mgLogClear').title = L.source === 'journal' ? 'The journal is managed by systemd and cannot be cleared here' : '';
}
$('mgPanel').addEventListener('click', e => { if (e.target.closest('[data-act="logs-retry"]')) loadLogs(true); });

// Keep the latest inline result visible through service refreshes. Each slot
// owns one subscription, tied to the current panel, so an old job cannot paint
// another service's panel after navigation.
const inlineJobs = new Map();
function paintInlineJob(id, job, render) {
    const old = inlineJobs.get(id);
    if (old) old.job.subs.delete(old.paint);
    inlineJobs.delete(id);
    const box = $(id);
    if (!box) return;
    if (!job) { box.innerHTML = ''; return; }
    const gen = P.gen, name = P.name;
    const paint = current => {
        if ($(id) !== box || P.gen !== gen || P.name !== name) {
            current.subs.delete(paint); return;
        }
        box.innerHTML = render(current);
        if (current.status !== 'running') current.subs.delete(paint);
    };
    inlineJobs.set(id, { job, paint });
    if (job.status === 'running') job.subs.add(paint);
    paint(job);
}

// ── Backups ────────────────────────────────────────────────
const locBadge = l => `<span class="mg-loc ${l === 'gdrive' ? 'gd' : ''}">${l === 'gdrive' ? 'Google Drive' : 'Local'}</span>`;
const rcloneOk = () => !!(mg.deps && mg.deps.rclone && mg.deps.rclone.ok);

PANES.backups = {
    init() {
        $('mgp-backups').innerHTML = `
            <div class="mg-bkbar">
                <button class="dk-primary mg-lg" id="bkLocal">Create backup</button>
                <button class="term-btn mg-lg" id="bkDrive"${rcloneOk() ? '' : ' disabled'} title="${rcloneOk() ? '' : esc((mg.deps && mg.deps.rclone && mg.deps.rclone.hint) || 'rclone is not available')}">Create and upload to Google Drive</button>
                <span class="mg-muted mg-bkhint">${rcloneOk() ? '' : 'Drive uploads need rclone, see the dependency hints above.'}</span>
            </div>
            <div id="mgBkJob"></div>
            <div id="mgBkList" aria-live="polite"><div class="mg-pane-skel">${skelRows(4)}</div></div>`;
        const start = async gd => {
            const r = await POST('/backups', { name: P.name, gdrive: gd });
            adoptJob(r, 'Backing up', false);
            PANES.backups.job();
        };
        $('bkLocal').addEventListener('click', () => start(false));
        $('bkDrive').addEventListener('click', () => start(true));
        $('mgBkList').addEventListener('click', e => {
            const b = e.target.closest('[data-bk]');
            if (b) PANES.backups.act(b.dataset.bk, +b.dataset.i);
            if (e.target.closest('[data-act="bk-retry"]')) loadBackups();
        });
        loadBackups();
        PANES.backups.job();
    },
    show() { PANES.backups.job(); },
    job() {
        const j = [...mg.jobs.values()].reverse().find(x => x.name === P.name && ['backups.create', 'backups.restore'].includes(x.op));
        paintInlineJob('mgBkJob', j, jobBoxHtml);
    },
    async act(kind, i) {
        const b = P.bk && P.bk[i]; if (!b) return;
        if (kind === 'restore') {
            const ok = await confirmDlg({ title: 'Restore this backup?', danger: true, confirm: 'Restore backup',
                body: `<p>This stops <b>${esc(P.name)}</b>, replaces its files with the contents of <code>${esc(b.filename)}</code> (${esc(fmtDate(b.timestamp))}, ${fmtBytes(b.size_bytes)}) and starts it again. Files changed since then are lost.</p>` });
            if (!ok) return;
            adoptJob(await POST('/backups/restore', { name: P.name, filename: b.filename, source: b.location }), 'Restoring', false);
            PANES.backups.job();
        } else if (kind === 'delete') {
            const ok = await confirmDlg({ title: 'Delete this backup?', danger: true, confirm: 'Delete backup',
                body: `<p><code>${esc(b.filename)}</code> will be permanently removed from ${b.location === 'gdrive' ? 'Google Drive' : 'local storage'}.</p>` });
            if (!ok) return;
            const r = await DEL('/backups', b.id != null ? { id: b.id } : { filename: b.filename, source: b.location });
            toast(r.ok ? 'Backup deleted' : r.error, !r.ok);
            loadBackups(); loadDetail();
        }
    }
};

async function loadBackups() {
    const gen = P.gen, name = P.name;
    const r = await GET('/backups?name=' + encodeURIComponent(name));
    if (gen !== P.gen || !$('mgBkList')) return;
    if (!r.ok) { $('mgBkList').innerHTML = errBlock(r, 'bk-retry'); return; }
    const rows = P.bk = (r.data.backups || []).slice().sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    $('mgBkList').innerHTML = rows.length
        ? `<div class="mg-tablewrap"><table class="mg-mini mg-bktable"><thead><tr><th scope="col">Backup</th><th scope="col">Where</th><th scope="col">Size</th><th scope="col">Created</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${rows.map((b, i) =>
            `<tr><td data-label="Backup"><code>${esc(b.filename)}</code>${b.encrypted ? ' ' + flag('ok', 'encrypted') : ''}</td><td data-label="Where">${locBadge(b.location)}</td><td data-label="Size">${fmtBytes(b.size_bytes)}</td>
             <td data-label="Created" title="${esc(fmtDate(b.timestamp))}">${esc(fmtAgo(b.timestamp))}</td>
             <td class="mg-bkact"><button class="term-btn" data-bk="restore" data-i="${i}" aria-label="Restore ${esc(b.filename)}">Restore</button><button class="term-btn mg-del" data-bk="delete" data-i="${i}" aria-label="Delete ${esc(b.filename)}">Delete</button></td></tr>`).join('')}</tbody></table></div>`
        : emptyBlock('No backups yet', 'Create a local backup, or upload one to Google Drive when rclone is set up.');
}

// ── Git & Webhook ──────────────────────────────────────────
const RESULT_CLS = { accepted: 'ok', updated: 'ok', rejected_signature: 'bad', failed: 'bad', busy: 'warn', ignored_branch: '', ignored_event: '' };

PANES.hook = {
    init() {
        $('mgp-hook').innerHTML = `<div id="mgHook"><div class="mg-pane-skel">${skelRows(5)}</div></div>`;
        $('mgHook').addEventListener('click', e => PANES.hook.click(e));
        $('mgHook').addEventListener('change', e => { if (e.target.id === 'hkAuto') PANES.hook.setAuto(e.target.checked, e.target); });
        loadHook();
    },
    show() { PANES.hook.job(); },
    job() {
        const j = [...mg.jobs.values()].reverse().find(x => x.name === P.name && x.op === 'webhook.test');
        paintInlineJob('hkJob', j, jj => jobBoxHtml(jj) + (jj.status === 'done' ? `<p class="mg-note ${jj.result.data && jj.result.data.ok ? '' : 'bad'}">${esc(resultSummary(jj))}</p>` : ''));
    },
    async click(e) {
        const b = e.target.closest('[data-hk]'); if (!b) return;
        const h = P.hook, s = h && h.service, name = P.name;
        switch (b.dataset.hk) {
            case 'reveal': P.hookReveal = !P.hookReveal; renderHook(); $('mgHook').querySelector('[data-hk=reveal]')?.focus({ preventScroll: true }); break;
            case 'copy-url': copyText(s.url, 'Webhook URL'); break;
            case 'copy-map': copyText(`sudo python3 app.py server map --from-service ${P.name}`, 'Command'); break;
            case 'copy-secret': copyText(s.secret, 'Secret'); break;
            case 'rotate': {
                const ok = await confirmDlg({ title: 'Rotate the webhook secret?', danger: true, confirm: 'Rotate secret',
                    body: '<p>The old secret stops working immediately. Update the secret in the GitHub webhook settings, or deliveries will be rejected with 401 until you do.</p>' });
                if (!ok) break;
                const r = await POST(svcPath(name, '/webhook'), { rotate_secret: true });
                if (r.ok) { P.hook = r.data; P.hookReveal = true; renderHook(); toast('Secret rotated. Copy the new one into GitHub.'); loadDetail(); } else toast(r.error, true);
                break;
            }
            case 'test': {
                const r = await POST(svcPath(name, '/webhook/test'), {});
                adoptJob(r, 'Testing webhook', false);
                PANES.hook.job();
                break;
            }
            case 'pull': {
                const ok = await confirmDlg({ title: 'Pull and update now?', confirm: 'Pull now', body: `<p>Fetches the latest commit of <b>${esc(s.branch)}</b>, rebuilds if needed and restarts <b>${esc(name)}</b>. Same path a webhook delivery uses.</p>` });
                if (ok) adoptJob(await POST(svcPath(name, '/action'), { action: 'update' }), 'Updating', true);
                break;
            }
            case 'retry': loadHook(); break;
        }
    },
    async setAuto(on, input) {
        input.disabled = true;
        const r = await POST(svcPath(P.name, '/webhook'), { auto_update: on });
        if (r.ok) { P.hook = r.data; toast(on ? 'Auto-update turned on' : 'Auto-update turned off'); loadDetail(); } else toast(r.error, true);
        renderHook();
    }
};

async function loadHook() {
    const gen = P.gen;
    const r = await GET(svcPath(P.name, '/webhook'));
    if (gen !== P.gen || !$('mgHook')) return;
    if (!r.ok) { $('mgHook').innerHTML = errBlock(r, 'hk-retry'); $('mgHook').querySelector('[data-act="hk-retry"]')?.addEventListener('click', loadHook); return; }
    P.hook = r.data;
    renderHook();
}

function renderHook() {
    const h = P.hook, el = $('mgHook'); if (!h || !el) return;
    const s = h.service, l = h.listener || {}, d = P.d, g = d.git || {};
    if (!s) { el.innerHTML = emptyBlock('No webhook for this service', 'ats did not return webhook details for it.'); return; }
    const mask = '&bull;'.repeat(24);
    const ev = s.last_events || [];
    el.innerHTML = `
        <section class="mg-hook-sec">
            <h3 class="mg-hook-title">Webhook connection</h3>
            <dl class="mg-dl mg-dl-wide">
                <dt>Payload URL</dt><dd class="mg-copyrow"><code>${esc(s.url)}</code><button class="term-btn" data-hk="copy-url" aria-label="Copy webhook URL">Copy</button></dd>
                <dt>Secret</dt><dd class="mg-copyrow"><code id="hkSecret">${P.hookReveal ? esc(s.secret) : mask}</code>
                    <span class="mg-secret-actions"><button class="term-btn" data-hk="reveal" aria-controls="hkSecret" aria-label="${P.hookReveal ? 'Hide' : 'Reveal'} webhook secret" aria-pressed="${!!P.hookReveal}">${P.hookReveal ? 'Hide' : 'Reveal'}</button><button class="term-btn" data-hk="copy-secret" aria-label="Copy webhook secret">Copy</button><button class="term-btn mg-del" data-hk="rotate">Rotate secret</button></span></dd>
                ${s.mapped === undefined || s.mapped === null ? '' : `<dt>Central receiver</dt><dd>${s.mapped ? flag('ok', 'mapped') + ` <span class="mg-muted">${esc(s.mapped_repository || '')}</span>` : flag('bad', 'not mapped: deliveries are rejected')}</dd>`}
                <dt>Listener</dt><dd>${flag(l.active ? 'ok' : 'bad', l.active ? 'active' : 'not running')} <span class="mg-muted">${esc(l.bind || '')}:${esc(l.port || '')}</span>${l.route_present === false ? ' ' + flag('warn', 'no Cloudflare route') : ''}</dd>
            </dl>
            ${s.mapped === false ? `<div class="mg-hook-warn" role="note"><b>Not connected to the webhook receiver yet.</b> GitHub deliveries for this service are rejected until it is mapped. On this server run
                <span class="mg-copyrow"><code>sudo python3 app.py server map --from-service ${esc(P.name)}</code><button class="term-btn" data-hk="copy-map" aria-label="Copy the map command">Copy</button></span>
                It reuses the secret above, so a GitHub webhook that already uses this URL and secret needs no change.</div>` : ''}
            <label class="mg-switch"><input type="checkbox" id="hkAuto" role="switch"${s.auto_update ? ' checked' : ''}><span class="mg-track" aria-hidden="true"></span><span>Automatic updates</span></label>
            <p class="mg-hint">Pushes to <code>${esc(s.branch)}</code> ${s.auto_update ? 'rebuild and restart this service.' : 'are verified and recorded without updating this service.'}</p>
        </section>
        <section class="mg-hook-sec">
            <h3 class="mg-hook-title">Git source</h3>
            <dl class="mg-dl mg-dl-wide">${[['Repository', `<span class="mg-hook-repo">${esc(d.repo_url || '—')}</span>`], ['Branch', `<code>${esc(g.branch || s.branch)}</code>`], ['Commit', g.commit ? `<code>${esc(g.commit)}</code> ${esc(g.subject || '')}` : '—'],
                ['State', [g.dirty ? flag('warn', 'uncommitted changes') : '', g.behind ? flag('warn', g.behind + ' behind origin') : flag('ok', 'up to date')].join(' ')]].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
            <div class="mg-btnrow"><button class="term-btn mg-lg" data-hk="test">Test webhook</button><button class="term-btn mg-lg" data-hk="pull">Pull now</button></div>
            <div id="hkJob"></div>
        </section>
        <section class="mg-hook-sec"><h3 class="mg-hook-title">Recent deliveries</h3>
        ${ev.length ? `<div class="mg-tablewrap"><table class="mg-mini mg-evtable"><thead><tr><th scope="col">When</th><th scope="col">Event</th><th scope="col">Ref</th><th scope="col">Commit</th><th scope="col">Result</th><th scope="col">Message</th></tr></thead><tbody>${ev.slice(0, 20).map(x =>
            `<tr><td data-label="When" title="${esc(fmtDate(x.timestamp))}">${esc(fmtAgo(x.timestamp))}</td><td data-label="Event">${esc(x.event)}</td><td data-label="Ref">${x.ref ? `<code>${esc(String(x.ref).replace('refs/heads/', ''))}</code>` : '—'}</td><td data-label="Commit">${x.commit ? `<code>${esc(String(x.commit).slice(0, 7))}</code>` : '—'}</td>
             <td data-label="Result">${flag(RESULT_CLS[x.result] != null ? RESULT_CLS[x.result] : '', esc(String(x.result).replace(/_/g, ' ')))}</td><td data-label="Message" class="mg-evmsg">${esc(x.message)}</td></tr>`).join('')}</tbody></table></div>`
            : emptyBlock('No deliveries yet', 'Once GitHub sends a push, or you press Test webhook, it shows up here.')}</section>
        <details class="mg-details mg-gh"><summary>GitHub setup</summary>
            <ol>
                <li>In the repository, open <b>Settings</b>, then <b>Webhooks</b>, then <b>Add webhook</b>.</li>
                <li>Payload URL: <code>${esc(s.url)}</code></li>
                <li>Content type: <code>application/json</code></li>
                <li>Secret: the secret shown above.</li>
                <li>Events: choose <b>Just the push event</b>. Leave SSL verification enabled.</li>
                <li>Pushes to <code>${esc(s.branch)}</code> ${s.auto_update ? 'update this service' : 'are recorded only (auto-update is off)'}. Pushes to other branches are ignored.</li>
            </ol></details>`;
    PANES.hook.job();
}

// ═══════════════════════════════════════════════════════════
//   DEPLOY DIALOG (stepper) -> live job log
// ═══════════════════════════════════════════════════════════
const D_STEPS = ['Source', 'Runtime', 'Address', 'Resources', 'Review'];
const D = { step: 0, v: null, dp: null, err: '' };
const defaultsOf = () => Object.assign({ runtime: 'python', branch: 'main', workers: 4, max_memory_mb: 512, cpu_quota: 50, container_port: 8000 }, (mg.settings && mg.settings.defaults) || {});
const limitsOf = () => Object.assign({}, DEFAULT_LIMITS, (mg.settings && mg.settings.limits) || {});

function freshDeploy() {
    const df = defaultsOf();
    return { name: '', repo_url: '', branch: df.branch, runtime: df.runtime === 'docker' && !dockerUsable() ? 'python' : df.runtime, domain: '', port: '', container_port: df.container_port,
        workers: df.workers, max_memory_mb: df.max_memory_mb, cpu_quota: df.cpu_quota, env: {}, auto_update: true };
}

async function openDeploy(keep) {
    if (!mg.settings) { const r = await loadSettings(); if (!r.ok) { toast('Could not load settings: ' + r.error, true); return; } }
    if (!mg.deps) await loadDeps();
    if (!keep || !D.v) { D.v = freshDeploy(); D.step = 0; }
    D.err = '';
    const d = $('mgDeploy');
    d.innerHTML = `<form id="mgDeployForm" novalidate autocomplete="off">
        <div class="dk-dhead"><h2 id="mgDeployTitle">Deploy service</h2><button type="button" class="term-btn" data-close>Cancel</button></div>
        <ol class="mg-stepper" id="mgStepper" aria-label="Deploy steps"></ol>
        <div class="mg-dbody" id="mgDStep"></div>
        <div class="dk-form-actions mg-dfoot"><button type="button" class="term-btn mg-lg" id="dBack">Back</button><span class="mg-grow"></span><button type="submit" class="dk-primary mg-lg" id="dNext">Next</button></div>
    </form>`;
    $('mgDeployForm').addEventListener('submit', e => { e.preventDefault(); deployNext(); });
    $('dBack').addEventListener('click', () => { if (D.step > 0) deployGo(D.step - 1); });
    $('mgStepper').addEventListener('click', e => { const b = e.target.closest('[data-go]'); if (b) deployGo(+b.dataset.go); });
    deployGo(D.step, true);
    openDlg(d);
}

function deployGo(i, first) {
    if (!first) deployRead();
    D.step = i; D.err = '';
    $('mgStepper').innerHTML = D_STEPS.map((s, k) => `<li${k === i ? ' aria-current="step"' : ''} class="${k < i ? 'done' : k === i ? 'cur' : ''}">${k < i ? `<button type="button" data-go="${k}" aria-label="Back to step ${k + 1}, ${s}">` : '<span>'}<i>${k + 1}</i><span class="mg-sn">${s}</span>${k < i ? '</button>' : '</span>'}</li>`).join('');
    const body = $('mgDStep');
    body.innerHTML = [dSource, dRuntime, dAddress, dResources, dReview][i]();
    [bSource, bRuntime, bAddress, bResources, bReview][i](body);
    $('dBack').hidden = i === 0;
    $('dNext').textContent = i === 4 ? 'Deploy' : 'Next';
    $('dNext').disabled = false;
    const f = qs('[autofocus], input:not([type=radio]):not([disabled]), select', body) || qs('input[type=radio]:checked', body);
    if (f) f.focus();
    body.scrollTop = 0;
    const currentStep = qs('[aria-current="step"]', $('mgStepper'));
    if (currentStep) $('mgStepper').scrollLeft = Math.max(0, currentStep.offsetLeft - $('mgStepper').offsetLeft - 12);
}

// read the visible step's inputs back into D.v
function deployRead() {
    const b = $('mgDStep'), v = D.v; if (!b) return;
    const val = id => { const el = qs('#' + id, b); return el ? el.value.trim() : null; };
    switch (D.step) {
        case 0: v.name = val('dd-name'); v.repo_url = val('dd-repo'); v.branch = val('dd-branch'); break;
        case 1: { const r = qs('input[name="dd-rt"]:checked', b); if (r) v.runtime = r.value; break; }
        case 2: { v.domain = readDomain(b, 'dd'); v.port = val('dd-port'); const cp = val('dd-cport'); if (cp != null) v.container_port = cp; break; }
        case 3: ['workers', 'max_memory_mb', 'cpu_quota'].forEach(k => { const x = val('dd-' + k); if (x != null) v[k] = x; }); v.env = readEnv(b, 'dd').env; v.auto_update = qs('#dd-auto', b).checked; break;
    }
}

const defTag = v => `<span class="mg-def">default <b>${esc(v)}</b></span>`;

function dSource() {
    const v = D.v, df = defaultsOf();
    return `<div class="mg-form">
        <div class="mg-f"><label for="dd-name">Service name</label><input class="filter-input" id="dd-name" value="${esc(v.name)}" placeholder="my-api" maxlength="64" spellcheck="false" autocapitalize="off" autofocus>
            <p class="mg-hint">Letters, digits, dash and underscore. Used for the systemd unit, the folder and the webhook URL. Cannot be changed later.</p></div>
        <div class="mg-f"><label for="dd-repo">Repository URL</label><input class="filter-input" id="dd-repo" value="${esc(v.repo_url)}" placeholder="https://github.com/owner/repo.git" spellcheck="false" autocapitalize="off" inputmode="url">
            <p class="mg-hint">https:// or git@ only. For a private repository put a token in the URL: <code>https://TOKEN@github.com/owner/repo.git</code>. It is redacted wherever it is shown.</p></div>
        <div class="mg-f"><div class="mg-lbl-row"><label for="dd-branch">Branch</label>${defTag(df.branch)}</div><input class="filter-input" id="dd-branch" value="${esc(v.branch)}" spellcheck="false" autocapitalize="off">
            <p class="mg-hint">Webhook pushes and updates follow this branch.</p></div></div>`;
}
function bSource(b) { /* nothing dynamic */ }

function dockerReason() {
    const d = dockerState();
    if (!d) return 'Docker status is not known yet.';
    if (!d.installed) return 'Docker is not installed on this host.';
    return d.hint || 'The service user cannot reach the Docker socket. Add it to the docker group and restart ats.';
}
function dRuntime() {
    const v = D.v, ok = dockerUsable();
    const card = (id, title, desc, dis, why) => `<label class="mg-rtcard${dis ? ' off' : ''}"><input type="radio" name="dd-rt" value="${id}"${v.runtime === id ? ' checked' : ''}${dis ? ' disabled' : ''}${why ? ` aria-describedby="dd-rt-${id}-why"` : ''}>
        <span class="mg-rtc-t">${title}</span><span class="mg-rtc-d">${desc}</span>${why ? `<span class="mg-rtc-why" id="dd-rt-${id}-why">Unavailable: ${esc(why)}</span>` : ''}</label>`;
    return `<div class="mg-form"><fieldset class="mg-fs"><legend>Runtime</legend><div class="mg-rtcards" role="radiogroup" aria-label="Runtime">
        ${card('python', 'Python', 'Flask or any WSGI app, served by gunicorn in a virtualenv. Needs a requirements.txt.')}
        ${card('node', 'Node', 'Node.js app. Dependencies are installed with npm and the app is started by the unit.')}
        ${card('docker', 'Docker <span class="mg-opt">optional</span>', 'Builds the repository Dockerfile and runs it as a container, wrapped by systemd so start, stop and logs work the same.', !ok, ok ? '' : dockerReason())}
        </div></fieldset>
        <p class="mg-hint">The runtime cannot be changed after deploy. Python and Node never need Docker.</p></div>`;
}
function bRuntime() { /* radios are read on Next */ }

function dAddress() {
    const v = D.v, dock = v.runtime === 'docker', df = defaultsOf();
    return `<div class="mg-form">
        ${domainFieldHtml('dd', v.domain)}
        <div class="mg-f"><label for="dd-port">Port</label><div class="mg-inline"><input class="filter-input" id="dd-port" type="number" inputmode="numeric" min="1" max="65535" value="${esc(v.port)}" placeholder="auto"><button type="button" class="term-btn" id="dd-suggest">Suggest a free port</button></div>
            <p class="mg-hint">Local port on 127.0.0.1 that the Cloudflare route points to. Leave blank and ats picks the first free one from 8000.</p></div>
        ${dock ? `<div class="mg-f"><div class="mg-lbl-row"><label for="dd-cport">Container port</label>${defTag(df.container_port)}</div><input class="filter-input" id="dd-cport" type="number" inputmode="numeric" min="1" max="65535" value="${esc(v.container_port)}">
            <p class="mg-hint">The port your app listens on inside the container.</p></div>` : ''}
    </div>`;
}
function bAddress(b) {
    D.dp = bindDomain(b, 'dd', '', () => {});
    $('dd-suggest').addEventListener('click', async () => {
        const r = await GET('/ports/suggest');
        if (r.ok) { $('dd-port').value = r.data.port; toast('Port ' + r.data.port + ' is free'); } else toast(r.error, true);
    });
    if (!D.v.port) GET('/ports/suggest').then(r => { const i = $('dd-port'); if (r.ok && i && !i.value) { i.value = r.data.port; D.v.port = String(r.data.port); } });
}

function dResources() {
    const v = D.v, df = defaultsOf(), lim = limitsOf();
    const hint = { workers: 'Gunicorn workers (Python runtime). ', max_memory_mb: 'Process or container is killed above this. ', cpu_quota: '100% is one core. ' };
    return `<div class="mg-form"><p class="mg-lead">Each field starts at the default from Settings. Change only what this service needs.</p>
        <div class="mg-resbox">${['workers', 'max_memory_mb', 'cpu_quota'].map(k => resFieldHtml('dd', k, +v[k], df[k], lim[k], hint[k])).join('')}</div>
        <div class="mg-f"><span class="mg-lbl">Environment variables <span class="mg-opt">optional</span></span>${envEditorHtml('dd', v.env)}</div>
        <label class="mg-switch"><input type="checkbox" id="dd-auto" role="switch"${v.auto_update ? ' checked' : ''}><span class="mg-track" aria-hidden="true"></span><span>Update automatically when GitHub pushes to the branch</span></label>
    </div>`;
}
function bResources(b) {
    const df = defaultsOf(), lim = limitsOf();
    bindRes(b, 'dd', df, lim, () => {});
    bindEnv(b, 'dd');
}

function deployPayload() {
    const v = D.v, p = { name: v.name, repo_url: v.repo_url, branch: v.branch, runtime: v.runtime, domain: v.domain,
        workers: +v.workers, max_memory_mb: +v.max_memory_mb, cpu_quota: +v.cpu_quota, auto_update: !!v.auto_update };
    if (v.port) p.port = +v.port;
    if (v.runtime === 'docker') p.container_port = +v.container_port;
    if (Object.keys(v.env).length) p.env = v.env;
    return p;
}
function dReview() {
    const v = D.v, df = defaultsOf();
    const tag = (k) => +v[k] === +df[k] ? ' <span class="mg-muted">default</span>' : ' <span class="mg-muted">default ' + df[k] + '</span>';
    return `<div class="mg-form"><div id="dd-err" class="mg-form-err" role="alert" ${D.err ? '' : 'hidden'}>${esc(D.err)}</div>
        ${dl([['Name', `<b>${esc(v.name)}</b>`], ['Repository', `<code>${esc(repoShort(v.repo_url))}</code>${/@/.test(v.repo_url.replace(/^git@/, '')) ? ' <span class="mg-muted">token hidden</span>' : ''}`], ['Branch', `<code>${esc(v.branch)}</code>`],
            ['Runtime', esc(RT[v.runtime])], ['Address', `<a href="https://${esc(v.domain)}" target="_blank" rel="noopener noreferrer">https://${esc(v.domain)}</a>`],
            ['Port', v.port ? esc(v.port) : '<span class="mg-muted">first free from 8000</span>'], v.runtime === 'docker' ? ['Container port', esc(v.container_port)] : null,
            ['Workers', esc(v.workers) + tag('workers')], ['Max memory', fmtMem(+v.max_memory_mb) + tag('max_memory_mb')], ['CPU quota', esc(v.cpu_quota) + '%' + tag('cpu_quota')],
            ['Environment', Object.keys(v.env).length ? Object.keys(v.env).map(k => `<code>${esc(k)}</code>`).join(' ') + ' <span class="mg-muted">values hidden</span>' : '<span class="mg-muted">none</span>'],
            ['Auto-update', v.auto_update ? 'on' : 'off']])}
        <p class="mg-note">Deploy runs on the server and keeps going if you close this window. If a step fails, nothing half-deployed is left behind.</p></div>`;
}
function bReview() {}

function deployValidate(i) {
    const v = D.v, b = $('mgDStep'); let ok = true;
    const bad = (id, msg) => { const el = qs('#' + id, b); if (el) fieldErr(el, msg); if (msg) ok = false; return msg; };
    if (i === 0) {
        const taken = mg.services.some(s => s.name === v.name);
        bad('dd-name', !NAME_RE.test(v.name) ? 'Use letters, digits, dash or underscore (1 to 64 characters)' : taken ? 'A service with this name already exists' : '');
        bad('dd-repo', /^http:\/\//i.test(v.repo_url) ? 'Plain http:// is not accepted, use https://' : !/^(https:\/\/|git@)\S+$/.test(v.repo_url) ? 'Enter an https:// or git@ repository URL' : '');
        bad('dd-branch', !BRANCH_RE.test(v.branch) || v.branch.includes('..') ? 'Branch name is not valid' : '');
    } else if (i === 2) {
        const d = D.dp;
        const dom = qs('#dd-sub, #dd-manual', b), vis = qs('input[name="dd-mode"]:checked', b);
        const target = vis && vis.value === 'saved' ? qs('#dd-sub', b) : qs('#dd-manual', b);
        const msg = !v.domain ? 'Choose or type a domain' : !HOST_RE.test(v.domain) ? 'Not a valid hostname' : d && d.state === 'taken' ? 'This domain is already used by another service' : d && d.state === 'checking' ? 'Still checking the domain, try again in a moment' : '';
        if (msg) { fieldErr(target, msg); ok = false; } else fieldErr(target, '');
        if (v.port) bad('dd-port', !/^\d+$/.test(v.port) || +v.port < 1 || +v.port > 65535 ? 'Port must be between 1 and 65535' : mg.services.some(s => String(s.port) === v.port) ? 'Another service already uses this port' : '');
        if (v.runtime === 'docker') bad('dd-cport', !/^\d+$/.test(String(v.container_port)) || +v.container_port < 1 || +v.container_port > 65535 ? 'Container port must be between 1 and 65535' : '');
    } else if (i === 3) {
        const lim = limitsOf();
        ['workers', 'max_memory_mb', 'cpu_quota'].forEach(k => { if (readRes(b, 'dd', k, lim[k]).err) ok = false; });
        if (readEnv(b, 'dd').errors.length) ok = false;
    }
    if (!ok) { const first = qs('.invalid', b); if (first) first.focus(); }
    return ok;
}

async function deployNext() {
    deployRead();
    if (D.step === 2 && D.dp) { const b = $('dNext'); b.disabled = true; await D.dp.settled(); b.disabled = false; deployRead(); }
    if (!deployValidate(D.step)) return;
    if (D.step < 4) { deployGo(D.step + 1, true); return; }
    const btn = $('dNext'); btn.disabled = true; btn.textContent = 'Starting...';
    const r = await POST('/services', deployPayload());
    if (!r.ok) {
        btn.disabled = false; btn.textContent = 'Deploy';
        D.err = r.error; const e = $('dd-err'); e.textContent = r.error; e.hidden = false; e.scrollIntoView({ block: 'nearest' });
        if (r.code === 'busy' && r.job_id) { trackJob(r.job_id, 'services.deploy', D.v.name, 'Deploying'); }
        return;
    }
    const j = trackJob(r.data.job_id, r.data.op, r.data.name, 'Deploying');
    closeDlg($('mgDeploy'));
    openJob(j, { retry: () => openDeploy(true) });
}
$('mgDeploy').addEventListener('close', () => { /* keep D.v so a failed deploy can be edited and retried */ });

// ═══════════════════════════════════════════════════════════
//   SETTINGS DIALOG + CLOUDFLARE PANEL
// ═══════════════════════════════════════════════════════════
const S = { tab: 'general', draft: null, orig: null, cf: null, cfBusy: false, cfNote: '' };
const cloneSettings = s => JSON.parse(JSON.stringify({ storage_root: s.storage_root, domains: s.domains || [], main_domain: s.main_domain || null,
    defaults: s.defaults || {}, cloudflare_config: s.cloudflare_config || '', cloudflared_service: s.cloudflared_service || '' }));

async function openSettings(tab = 'general') {
    const d = $('mgSettings');
    S.tab = tab;
    d.innerHTML = `<div class="dk-dhead"><h2 id="mgSettingsTitle">Settings</h2><button class="term-btn" data-close>Close</button></div>
        <div class="db-subtabs mg-stabs" role="tablist" aria-label="Settings sections">
            <button class="dk-tab" role="tab" id="mgst-general" data-st="general" aria-controls="mgs-general">GENERAL</button>
            <button class="dk-tab" role="tab" id="mgst-cf" data-st="cf" aria-controls="mgs-cf">CLOUDFLARE</button></div>
        <div class="mg-sbody">
            <section id="mgs-general" role="tabpanel" aria-labelledby="mgst-general" tabindex="0"><div class="mg-pane-skel">${skelRows(6)}</div></section>
            <section id="mgs-cf" role="tabpanel" aria-labelledby="mgst-cf" tabindex="0" hidden><div class="mg-pane-skel">${skelRows(4)}</div></section>
        </div>`;
    setSettingsTab(tab);
    openDlg(d);
    const r = await loadSettings();
    if (!$('mgs-general')) return;
    if (!r.ok) { $('mgs-general').innerHTML = errBlock(r, 'st-retry'); return; }
    S.orig = cloneSettings(mg.settings); S.draft = cloneSettings(mg.settings);
    renderGeneral();
}

function setSettingsTab(tab) {
    S.tab = tab;
    qsa('[data-st]', $('mgSettings')).forEach(b => { const on = b.dataset.st === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
    $('mgs-general').hidden = tab !== 'general';
    $('mgs-cf').hidden = tab !== 'cf';
    if (tab === 'cf') loadCloudflare();
}

$('mgSettings').addEventListener('keydown', e => {
    const t = e.target.closest('[data-st]');
    if (t && ['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); const o = qs(`[data-st="${t.dataset.st === 'general' ? 'cf' : 'general'}"]`, $('mgSettings')); o.focus(); setSettingsTab(o.dataset.st); }
});

function numField(id, key, label, val, lim, df) {
    return `<div class="mg-f mg-f-sm"><label for="${id}">${label}</label><div class="mg-num"><input class="filter-input" id="${id}" type="number" inputmode="numeric" min="${lim[0]}" max="${lim[1]}" value="${val}" data-def="${key}"><span class="mg-unit">${RES[key].unit}</span></div><p class="mg-hint">allowed ${lim[0]} to ${lim[1]}</p></div>`;
}

function renderGeneral() {
    const s = mg.settings, dr = S.draft, lim = limitsOf(), el = $('mgs-general');
    const ro = [['Service user', s.service_user], ['ATS home', s.ats_home], ['Webhook domain', s.webhook && s.webhook.domain], ['Webhook port', s.webhook && s.webhook.port],
        ['Google Drive remote', s.gdrive && s.gdrive.remote], ['Drive retention', s.gdrive && s.gdrive.retention_days != null ? s.gdrive.retention_days + ' days' : null]].filter(r => r[1] != null);
    const keepFocus = document.activeElement && document.activeElement.id;
    el.innerHTML = `<form class="mg-form" id="mgSetForm" novalidate autocomplete="off">
        <div id="mgSetErr"></div>
        <div class="sec-label">Storage</div>
        <div class="mg-f"><label for="st-root">Storage root</label><input class="filter-input" id="st-root" value="${esc(dr.storage_root)}" spellcheck="false" autocapitalize="off">
            <p class="mg-hint">New services are cloned to <code>${esc(dr.storage_root || '/opt')}/api/&lt;name&gt;</code>. Services that already exist keep their current location.</p></div>
        <div class="sec-label">Saved domains</div>
        <p class="mg-hint mg-hint-top">Saved domains show up as a list when you deploy or edit a service, so you only type the subdomain.</p>
        <ul class="mg-domlist" id="stDomains">${dr.domains.length ? dr.domains.map((d, i) => `<li><span class="mg-domname">${esc(d)}</span>${dr.main_domain === d ? flag('ok', 'main') : `<button type="button" class="mg-link" data-dom="main" data-i="${i}" aria-label="Make ${esc(d)} the main domain">Set as main</button>`}
            <button type="button" class="term-btn mg-del" data-dom="rm" data-i="${i}" aria-label="Remove ${esc(d)}">Remove</button></li>`).join('') : '<li class="mg-muted">No saved domains. Add one below.</li>'}</ul>
        <div class="mg-inline mg-adddom"><input class="filter-input" id="st-newdom" placeholder="example.com" aria-label="New domain" spellcheck="false" autocapitalize="off" autocomplete="off"><button type="button" class="term-btn" id="st-adddom">Add domain</button></div>
        <div class="sec-label">Defaults for new services</div>
        <div class="mg-grid3">
            <div class="mg-f mg-f-sm"><label for="st-runtime">Runtime</label><select class="filter-input" id="st-runtime"><option value="python">Python</option><option value="node">Node</option><option value="docker"${dockerUsable() ? '' : ' disabled'}>Docker${dockerUsable() ? '' : ' (unavailable)'}</option></select></div>
            <div class="mg-f mg-f-sm"><label for="st-branch">Branch</label><input class="filter-input" id="st-branch" value="${esc(dr.defaults.branch)}" spellcheck="false" autocapitalize="off"></div>
            ${numField('st-workers', 'workers', 'Workers', dr.defaults.workers, lim.workers)}
            ${numField('st-mem', 'max_memory_mb', 'Max memory', dr.defaults.max_memory_mb, lim.max_memory_mb)}
            ${numField('st-cpu', 'cpu_quota', 'CPU quota', dr.defaults.cpu_quota, lim.cpu_quota)}
            <div class="mg-f mg-f-sm"><label for="st-cport">Container port</label><div class="mg-num"><input class="filter-input" id="st-cport" type="number" inputmode="numeric" min="1" max="65535" value="${dr.defaults.container_port != null ? dr.defaults.container_port : ''}"></div><p class="mg-hint">Docker runtime only</p></div>
        </div>
        <div class="sec-label">Cloudflare</div>
        <div class="mg-grid2">
            <div class="mg-f"><label for="st-cfpath">Config file path</label><input class="filter-input" id="st-cfpath" value="${esc(dr.cloudflare_config)}" spellcheck="false" autocapitalize="off"></div>
            <div class="mg-f"><label for="st-cfsvc">systemd service name</label><input class="filter-input" id="st-cfsvc" value="${esc(dr.cloudflared_service)}" spellcheck="false" autocapitalize="off"></div>
        </div>
        <div class="sec-label">Fixed by ats</div>
        ${dl(ro.map(([k, v]) => [esc(k), `<code>${esc(v)}</code>`]))}
        <div class="mg-formbar"><span class="mg-fstate" id="st-state" aria-live="polite">No changes</span>
            <button type="button" class="term-btn mg-lg" id="st-revert" disabled>Revert</button><button type="submit" class="dk-primary mg-lg" id="st-save" disabled>Save settings</button></div>
    </form>`;
    $('st-runtime').value = dr.defaults.runtime || 'python';
    const f = $('mgSetForm');
    f.addEventListener('input', () => { settingsRead(); settingsState(); });
    f.addEventListener('change', () => { settingsRead(); settingsState(); });
    f.addEventListener('submit', e => { e.preventDefault(); settingsSave(); });
    $('st-revert').addEventListener('click', () => { S.draft = cloneSettings(S.orig); renderGeneral(); });
    $('st-adddom').addEventListener('click', addDomain);
    $('st-newdom').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } });
    $('stDomains').addEventListener('click', e => {
        const b = e.target.closest('[data-dom]'); if (!b) return;
        settingsRead();
        const i = +b.dataset.i, d = S.draft.domains[i];
        if (b.dataset.dom === 'rm') {
            S.draft.domains.splice(i, 1);
            if (S.draft.main_domain === d) S.draft.main_domain = S.draft.domains[0] || null;
        } else S.draft.main_domain = d;
        renderGeneral();
        const nf = qs(`#stDomains [data-dom]`); (nf || $('st-newdom')).focus();
    });
    if (keepFocus && $(keepFocus) && keepFocus !== 'st-adddom') $(keepFocus).focus();
    settingsState();
}

function addDomain() {
    settingsRead();
    const inp = $('st-newdom'), v = inp.value.trim().toLowerCase();
    let err = '';
    if (!HOST_RE.test(v)) err = 'Enter a valid domain such as example.com';
    else if (S.draft.domains.includes(v)) err = 'This domain is already saved';
    else if (S.draft.domains.length >= 50) err = 'Too many saved domains';
    if (err) { fieldErr(inp, err); inp.focus(); return; }
    S.draft.domains.push(v);
    if (!S.draft.main_domain) S.draft.main_domain = v;
    renderGeneral();
    $('st-newdom').focus();
}

function settingsRead() {
    const dr = S.draft, g = id => { const e = $(id); return e ? e.value.trim() : null; };
    if (g('st-root') == null) return;
    dr.storage_root = g('st-root'); dr.cloudflare_config = g('st-cfpath'); dr.cloudflared_service = g('st-cfsvc');
    dr.defaults.runtime = $('st-runtime').value; dr.defaults.branch = g('st-branch');
    const n = id => { const v = g(id); return /^\d+$/.test(v) ? +v : v; };
    dr.defaults.workers = n('st-workers'); dr.defaults.max_memory_mb = n('st-mem'); dr.defaults.cpu_quota = n('st-cpu');
    const cp = g('st-cport'); dr.defaults.container_port = cp === '' ? null : n('st-cport');
}

function settingsDiff() {
    const a = S.orig, b = S.draft, patch = {}, errors = [], lim = limitsOf();
    const chk = (id, msg) => { const el = $(id); if (el) fieldErr(el, msg); if (msg) errors.push(msg); };
    chk('st-root', !/^\/[^\0\r\n]*$/.test(b.storage_root) || b.storage_root.split('/').includes('..') ? 'Storage root must be an absolute path without ".."' : '');
    chk('st-branch', !BRANCH_RE.test(b.defaults.branch || '') ? 'Branch name is not valid' : '');
    [['st-workers', 'workers'], ['st-mem', 'max_memory_mb'], ['st-cpu', 'cpu_quota']].forEach(([id, k]) => {
        const v = b.defaults[k];
        chk(id, !Number.isInteger(v) || v < lim[k][0] || v > lim[k][1] ? `${RES[k].label} must be between ${lim[k][0]} and ${lim[k][1]}` : '');
    });
    const cp = b.defaults.container_port;
    chk('st-cport', cp != null && (!Number.isInteger(cp) || cp < 1 || cp > 65535) ? 'Container port must be between 1 and 65535' : '');
    chk('st-cfpath', !/^\/[^\0\r\n]*$/.test(b.cloudflare_config) ? 'Enter an absolute path' : '');
    chk('st-cfsvc', !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(b.cloudflared_service) ? 'Enter a systemd unit name' : '');
    if (b.storage_root !== a.storage_root) patch.storage_root = b.storage_root;
    if (JSON.stringify(b.domains) !== JSON.stringify(a.domains)) patch.domains = b.domains;
    if (b.main_domain !== a.main_domain || patch.domains) { if (b.main_domain !== a.main_domain) patch.main_domain = b.main_domain; }
    const dd = {};
    Object.keys(b.defaults).forEach(k => { if (b.defaults[k] !== a.defaults[k] && !(b.defaults[k] == null && a.defaults[k] == null)) dd[k] = b.defaults[k]; });
    if (Object.keys(dd).length) patch.defaults = dd;
    if (b.cloudflare_config !== a.cloudflare_config) patch.cloudflare_config = b.cloudflare_config;
    if (b.cloudflared_service !== a.cloudflared_service) patch.cloudflared_service = b.cloudflared_service;
    if (patch.defaults && patch.defaults.container_port === null) delete patch.defaults.container_port;
    return { patch, errors };
}

function settingsState() {
    if (!$('mgSetForm')) return;
    const { patch, errors } = settingsDiff(), n = Object.keys(patch).length;
    $('st-state').textContent = errors.length ? errors.length + (errors.length === 1 ? ' problem to fix' : ' problems to fix') : n ? n + (n === 1 ? ' unsaved change' : ' unsaved changes') : 'No changes';
    $('st-state').classList.toggle('bad', errors.length > 0);
    $('st-save').disabled = !n || errors.length > 0;
    $('st-revert').disabled = !n && !errors.length;
}

async function settingsSave() {
    settingsRead();
    const { patch, errors } = settingsDiff();
    if (errors.length || !Object.keys(patch).length) return;
    const btn = $('st-save'); btn.disabled = true; btn.textContent = 'Saving...';
    const r = await PUT('/settings', patch);
    if (!r.ok) {
        $('mgSetErr').innerHTML = `<div class="mg-note bad" role="alert"><b>Not saved.</b> ${esc(r.error)}</div>`;
        btn.textContent = 'Save settings'; settingsState();
        toast('Settings not saved: ' + r.error, true);
        $('mgSetErr').scrollIntoView({ block: 'nearest' });
        return;
    }
    mg.settings = r.data;
    S.orig = cloneSettings(r.data); S.draft = cloneSettings(r.data);
    renderGeneral();
    $('mgSetErr').innerHTML = '';
    toast('Settings saved' + (patch.storage_root ? '. The new storage root applies to new deployments only.' : ''));
}

// ── Cloudflare ──
async function loadCloudflare() {
    const el = $('mgs-cf');
    if (!S.cf) el.innerHTML = `<div class="mg-pane-skel">${skelRows(4)}</div>`;
    const r = await GET('/cloudflare');
    if (!$('mgs-cf')) return;
    if (!r.ok) { $('mgs-cf').innerHTML = errBlock(r, 'cf-retry'); return; }
    S.cf = r.data;
    renderCloudflare();
}

function renderCloudflare() {
    const c = S.cf, el = $('mgs-cf'); if (!c) return;
    const state = r => r.owner == null ? (r.hostname === '*' || /^http_status/.test(r.service) ? flag('', 'catch-all') : flag('warn', 'orphan')) : r.ok ? flag('ok', 'ok') : flag('bad', 'wrong target');
    const problems = c.missing.length + c.orphans.length + c.routes.filter(r => r.owner && !r.ok).length;
    el.innerHTML = `
        <div class="mg-cfhead">
            <dl class="mg-dl mg-dl-wide">
                <dt>Tunnel service</dt><dd><code>${esc(c.service)}</code> ${flag(c.active ? 'ok' : 'bad', c.active ? 'active' : 'not running')}</dd>
                <dt>Config file</dt><dd><code>${esc(c.config_path)}</code></dd>
                <dt>Routes</dt><dd>${problems ? flag('warn', problems + (problems === 1 ? ' needs attention' : ' need attention')) : flag('ok', 'all routes match the services')}</dd>
            </dl>
            <div class="mg-btnrow"><button class="dk-primary mg-lg" data-cf="sync"${S.cfBusy ? ' disabled' : ''}>Sync routes</button><button class="term-btn mg-lg" data-cf="edit"${S.cfBusy ? ' disabled' : ''}>Edit config file</button><button class="term-btn mg-lg" data-cf="restart"${S.cfBusy ? ' disabled' : ''}>Restart cloudflared</button><button class="term-btn mg-lg" data-cf="refresh"${S.cfBusy ? ' disabled' : ''}>Refresh</button></div>
            ${S.cfBusy ? '<p class="mg-note"><span class="mg-spin" aria-hidden="true"></span> Working...</p>' : ''}
            ${S.cfNote ? `<p class="mg-note" role="status">${S.cfNote}</p>` : ''}
        </div>
        ${c.missing.length ? `<div class="mg-note warn" role="status"><b>Missing routes:</b> ${c.missing.map(n => `<code>${esc(n)}</code>`).join(', ')}. Sync routes adds them.</div>` : ''}
        <div class="sec-label">Routes</div>
        ${c.routes.length ? `<div class="mg-tablewrap"><table class="mg-mini mg-cftable"><thead><tr><th scope="col">Hostname</th><th scope="col">Points to</th><th scope="col">Service</th><th scope="col">State</th></tr></thead><tbody>${c.routes.map(r =>
            `<tr><td data-label="Hostname"><code>${esc(r.hostname)}</code></td><td data-label="Points to"><code>${esc(r.service)}</code></td><td data-label="Service">${r.owner ? esc(r.owner) : '<span class="mg-muted">none</span>'}</td><td data-label="State">${state(r)}</td></tr>`).join('')}</tbody></table></div>`
            : emptyBlock('No routes', 'The Cloudflare config has no ingress rules yet.')}`;
}

const DEP_INFO = {
    docker: ['Docker', 'This installs the <code>docker.io</code> package from your distribution, starts the Docker service and gives the ATS service user access to it.'],
    rclone: ['rclone', 'This installs the <code>rclone</code> package from your distribution. You still configure the Google Drive remote on that server with <code>rclone config</code>.']
};
async function installDependency(name) {
    const [label, what] = DEP_INFO[name] || [name, ''];
    const server = document.querySelector('#activeServer option:checked')?.textContent || 'this server';
    const ok = await confirmDlg({ title: `Install ${label} on ${server}?`, confirm: `Install ${label}`,
        body: `<p>${what}</p><p>It runs as root on <b>${esc(server)}</b>, needs internet access and can take a minute or two. Nothing is downloaded except the distribution's own packages.</p>` });
    if (!ok) return;
    adoptJob(await POST('/dependencies/install', { name }), 'Installing', true);
}
document.addEventListener('click', e => { const b = e.target.closest('[data-act="dep-install"]'); if (b) installDependency(b.dataset.dep); });
window.mgInstallDependency = installDependency;

async function openCfEditor() {
    const d = $('mgCfEdit');
    d.innerHTML = `<div class="dk-dhead"><h2 id="mgCfEditTitle">Edit Cloudflare config</h2><button class="term-btn" data-close>Close</button></div><div class="mg-cfe-body"><div class="mg-pane-skel">${skelRows(6)}</div></div>`;
    openDlg(d);
    const r = await GET('/cloudflare/config');
    if (!d.open) return;
    const body = qs('.mg-cfe-body', d);
    if (!r.ok) { body.innerHTML = errBlock(r, 'cfe-retry'); qs('[data-act="cfe-retry"]', body)?.addEventListener('click', openCfEditor); return; }
    const f = r.data;
    body.innerHTML = `<dl class="mg-dl mg-dl-wide"><dt>File</dt><dd><code>${esc(f.path)}</code>${f.exists ? '' : ' ' + flag('warn', 'does not exist yet')}</dd>
        <dt>Tunnel service</dt><dd><code>${esc(f.service)}</code> ${flag(f.active ? 'ok' : 'bad', f.active ? 'active' : 'not running')}</dd>
        <dt>Checked by</dt><dd>${f.validator ? 'cloudflared validates the file before it is saved' : flag('warn', 'cloudflared not found: only the structure is checked')}</dd></dl>
        <textarea id="mgCfText" class="mg-cfe-text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="Cloudflare config file contents"></textarea>
        <p class="mg-hint">The previous file is kept as a timestamped backup next to it. If cloudflared will not start with your change, the previous file is put back automatically. Keep <code>tunnel</code> and <code>credentials-file</code>; the last rule must be a catch-all such as <code>service: http_status:404</code>.</p>
        <label class="mg-switch"><input type="checkbox" id="mgCfRestart" role="switch" checked><span class="mg-track" aria-hidden="true"></span><span>Restart cloudflared to apply the change</span></label>
        <p id="mgCfeErr" class="mg-form-err" role="alert" hidden></p>
        <div class="mg-final-act"><button class="dk-primary mg-lg" id="mgCfSave" disabled>Save</button><button class="term-btn mg-lg" data-close>Cancel</button></div>`;
    const area = $('mgCfText'), save = $('mgCfSave');
    area.value = f.content;
    area.addEventListener('input', () => { save.disabled = area.value === f.content; });
    save.addEventListener('click', async () => {
        save.disabled = true; $('mgCfeErr').hidden = true;
        const restart = $('mgCfRestart').checked;
        const res = await PUT('/cloudflare/config', { content: area.value, base_sha256: f.sha256, restart });
        if (!res.ok) { $('mgCfeErr').textContent = res.error; $('mgCfeErr').hidden = false; save.disabled = false; return; }
        closeDlg(d);
        adoptJob(res, 'Saving Cloudflare config', true);
    });
}

$('mgSettings').addEventListener('click', async e => {
    const st = e.target.closest('[data-st]');
    if (st) { setSettingsTab(st.dataset.st); return; }
    if (e.target.closest('[data-act="st-retry"]')) { openSettings(S.tab); return; }
    if (e.target.closest('[data-act="cf-retry"]')) { loadCloudflare(); return; }
    const b = e.target.closest('[data-cf]'); if (!b) return;
    const act = b.dataset.cf;
    if (act === 'refresh') { S.cfNote = ''; loadCloudflare(); return; }
    if (act === 'edit') { openCfEditor(); return; }
    if (act === 'sync') {
        const c = S.cf;
        const res = await confirmDlg({ title: 'Sync Cloudflare routes?', confirm: 'Sync routes',
            body: `<p>ats adds missing routes and corrects wrong ones in <code>${esc(c.config_path)}</code>, then reloads <code>${esc(c.service)}</code>. The catch-all rule and routes ats does not own are not touched.</p>`,
            checks: c.orphans.length ? [{ id: 'remove_orphans', label: `Also remove ${c.orphans.length} orphan route${c.orphans.length === 1 ? '' : 's'}: ${c.orphans.join(', ')}`, checked: false }] : [] });
        if (!res) return;
        S.cfBusy = true; S.cfNote = ''; renderCloudflare();
        const r = await POST('/cloudflare/sync', res.checks.remove_orphans ? { remove_orphans: true } : {});
        S.cfBusy = false;
        if (r.ok) {
            const x = r.data, part = (l, a) => a && a.length ? `${l} ${a.length} (${a.map(esc).join(', ')})` : '';
            const parts = [part('added', x.added), part('fixed', x.fixed), part('removed', x.removed)].filter(Boolean);
            S.cfNote = 'Sync finished: ' + (parts.length ? parts.join('; ') : 'nothing needed changing') + '.';
            toast('Cloudflare routes synced');
        } else { S.cfNote = ''; toast('Sync failed: ' + r.error, true); }
        await loadCloudflare();
        if (!r.ok && $('mgs-cf')) { S.cfNote = `<span class="mg-bad">Sync failed:</span> ${esc(r.error)}`; renderCloudflare(); }
        fetchManage(true);
    } else if (act === 'restart') {
        if (!await confirmDlg({ title: 'Restart cloudflared?', danger: true, confirm: 'Restart', body: `<p>Restarting <code>${esc(S.cf.service)}</code> briefly drops every public hostname served through the tunnel.</p>` })) return;
        S.cfBusy = true; S.cfNote = ''; renderCloudflare();
        const r = await POST('/cloudflare/restart', {});
        S.cfBusy = false;
        S.cfNote = r.ok ? (r.data.active ? 'cloudflared restarted and is active.' : 'cloudflared restarted but is not active. Check its logs.') : `<span class="mg-bad">Restart failed:</span> ${esc(r.error)}`;
        toast(r.ok ? 'cloudflared restarted' : 'Restart failed: ' + r.error, !r.ok);
        await loadCloudflare();
    }
});

// Operations uses the existing service dialog, job transport and confirmation UI.
const opTime = n => n ? new Date(n * 1000).toLocaleString() : '—';
const opEmpty = text => `<p class="mg-muted">${esc(text)}</p>`;
function collectorHtml(c) {
    return `<div class="mg-note ${c.stale ? 'bad' : ''}" role="status"><b>${c.stale ? 'Collector needs attention' : 'Collector is running'}</b><p>Last cycle: ${esc(opTime(c.at))}. ${c.stale ? 'Restart the updated ATS daemon to collect health and resource samples and run configured backup schedules.' : 'Health and resource observations are sampled every minute.'}</p>${(c.errors || []).map(x => `<p>${esc(x.name)}: ${esc(x.error)}</p>`).join('')}</div>`;
}
function alertsHtml(rows) {
    if (!rows.length) return opEmpty('No alerts recorded.');
    return rows.map(r => `<article class="mg-op-row"><div><b>${esc(r.name)} · ${esc(r.kind)}</b><span class="mg-st ${r.active ? 'bad' : 'ok'}">${r.active ? 'Active' : 'Resolved'}</span><p>${esc(r.message)}</p><small>${esc(opTime(r.last_seen))}</small></div>${r.acknowledged ? '<span class="mg-muted">Acknowledged</span>' : `<button class="term-btn" data-op-ack="${r.id}">Acknowledge</button>`}</article>`).join('');
}
function activityHtml(rows) {
    return rows.length ? `<div class="mg-activity-list" role="region" aria-label="Activity history" tabindex="0">${rows.map(r => `<article class="mg-op-row"><div><b>${esc(r.action.replaceAll('_', ' '))}</b><p>${esc(r.target)} · ${esc(r.user)}</p></div><time>${esc(r.timestamp.replace('T', ' ').slice(0, 19))}</time></article>`).join('')}</div>` : opEmpty('No activity recorded.');
}
function resourceChart(rows, key, label, unit) {
    const values = rows.filter(r => Number.isFinite(r[key]));
    if (!values.length) return opEmpty(`${label}: no measurements available yet.`);
    const max = Math.max(...values.map(r => r[key]), 1), first = rows[0].at, span = Math.max(1, rows[rows.length - 1].at - first);
    const points = values.map(r => `${10 + (r.at - first) / span * 480},${100 - r[key] / max * 80}`).join(' ');
    return `<figure class="mg-op-chart"><figcaption>${esc(label)} · latest <b>${values[values.length - 1][key].toFixed(1)} ${unit}</b></figcaption><svg viewBox="0 0 500 115" role="img" aria-label="${esc(label)} history, maximum ${max.toFixed(1)} ${unit}"><path d="M10 20H490M10 60H490M10 100H490" class="mg-op-grid"/><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="${points.split(' ').at(-1).split(',')[0]}" cy="${points.split(' ').at(-1).split(',')[1]}" r="3"/></svg><small>${esc(opTime(first))} → ${esc(opTime(rows.at(-1).at))} · ${values.length} samples</small></figure>`;
}
let operationsData = null, operationsGeneration = 0;
PANES.operations = {
    init() {
        $('mgp-operations').innerHTML = '<div id="mgOperationsService" aria-live="polite"></div>';
        loadOperations();
    }
};
async function loadOperations() {
    const gen = ++operationsGeneration, name = P.name;
    const box = $('mgOperationsService');
    if (!box) return;
    box.innerHTML = opEmpty('Loading operations…');
    const r = await GET(svcPath(name) + '/operations');
    if (gen !== operationsGeneration || P.name !== name || !panelOpen()) return;
    if (!r.ok) { box.innerHTML = `<div class="mg-note bad" role="alert">${esc(r.error)}</div><button class="term-btn" data-op-refresh>Retry</button>`; return; }
    const d = operationsData = r.data, c = d.config;
    const checked = d.samples.filter(x => x.health_ok != null);
    const latest = checked.at(-1);
    const cfgNumber = (key, label, lo, hi) => `<label>${label}<input class="filter-input" type="number" inputmode="numeric" min="${lo}" max="${hi}" name="${key}" value="${c[key]}" required></label>`;
    box.innerHTML = `<div class="mg-op-toolbar"><h3>Operations</h3><button class="term-btn" data-op-refresh>Refresh</button></div>
      ${collectorHtml(d.collector)}
      <section class="mg-op-section"><h3>Alerts</h3>${alertsHtml(d.alerts)}</section>
      <section class="mg-op-section"><h3>Deployment history</h3><p class="mg-muted">Current commit <code>${esc(d.current_commit || 'Unavailable')}</code>. History begins with this ATS version. Rollback rebuilds and restarts code; database and environment values are preserved.</p>
      ${d.deployments.length ? d.deployments.map(x => `<article class="mg-op-row"><div><b>${esc(x.action)} · <code>${esc((x.commit_sha || x.before_sha || 'unknown').slice(0, 12))}</code></b><span class="mg-st ${x.status === 'success' ? 'ok' : x.status === 'failed' ? 'bad' : 'warn'}">${esc(x.status)}</span><p>${esc(opTime(x.started))} · ${esc(x.branch)}</p>${x.error ? `<p class="mg-bad">${esc(x.error)}</p>` : ''}</div>${x.rollback_available ? `<button class="term-btn" data-op-rollback="${x.id}">Roll back</button>` : ''}</article>`).join('') : opEmpty('No deployments recorded yet.')}</section>
      <section class="mg-op-section"><h3>Health checks</h3><div class="mg-op-stats"><div><span>Latest HTTP check</span><b>${latest ? latest.health_ok ? 'Passed' : 'Failed' : 'Not sampled'}</b></div><div><span>Response time</span><b>${Number.isFinite(latest?.latency_ms) ? latest.latency_ms + ' ms' : '—'}</b></div><div><span>Observed availability</span><b>${d.health.observed_availability_pct == null ? '—' : d.health.observed_availability_pct + '%'}</b></div><div><span>Consecutive failures</span><b>${d.health.failure_streak}</b></div></div><p class="mg-muted">Availability covers ${d.health.observations} retained observations, rather than continuous uptime. Checks request this service's local port without following redirects.</p>${latest?.error ? `<p class="mg-bad">${esc(latest.error)}</p>` : ''}</section>
      <form id="mgOperationsForm"><section class="mg-op-section"><h3>Health configuration</h3><label class="toggle-label"><input name="health_enabled" type="checkbox" ${c.health_enabled ? 'checked' : ''}> Enable HTTP checks</label><div class="mg-op-fields"><label>Local path<input class="filter-input" name="health_path" value="${esc(c.health_path)}" maxlength="512" required></label>${cfgNumber('expected_status','Expected HTTP status',100,599)}${cfgNumber('timeout_seconds','Timeout (seconds)',1,10)}${cfgNumber('failure_threshold','Failures before alert',1,20)}</div></section>
      <section class="mg-op-section"><h3>Scheduled backups</h3><p class="mg-muted">Local database backups. Retention applies only to backups made by this schedule after a new backup passes archive verification.</p>${d.schedule.legacy_midnight ? '<p class="mg-note">The legacy midnight backup is still active. Saving these settings replaces it for this service, including when the schedule is disabled.</p>' : ''}<div class="mg-op-stats"><div><span>Next run</span><b>${esc(opTime(d.schedule.next_backup))}</b></div><div><span>Last backup</span><b>${esc(opTime(d.schedule.last_backup))}</b></div><div><span>Last archive verification</span><b>${esc(opTime(d.schedule.verified_at))}</b></div></div>${d.schedule.last_error ? `<p class="mg-bad">${esc(d.schedule.last_error)}</p>` : ''}<p class="mg-muted">Archive verification checks checksum and ZIP integrity. An application restore test is still needed to prove recovery.</p><label class="toggle-label"><input name="backup_enabled" type="checkbox" ${c.backup_enabled ? 'checked' : ''}> Enable scheduled backups</label><div class="mg-op-fields">${cfgNumber('interval_hours','Interval (hours)',1,720)}${cfgNumber('retain_count','Scheduled backups to retain',1,100)}</div></section><div class="mg-op-save"><span id="mgOpSaveStatus" role="status"></span><button class="term-btn" type="submit">Save settings</button></div></form>
      <section class="mg-op-section"><h3>Resource history</h3><p class="mg-muted">CPU uses one core = 100%. Missing systemd measurements remain unavailable.</p>${resourceChart(d.samples,'cpu_percent','CPU','%')}${resourceChart(d.samples,'memory_mb','Memory','MB')}
      <details><summary>Recent samples</summary><div class="mg-op-table"><table><thead><tr><th>Time</th><th>CPU</th><th>Memory</th><th>State</th></tr></thead><tbody>${d.samples.slice(-20).reverse().map(x => `<tr><td>${esc(opTime(x.at))}</td><td>${x.cpu_percent == null ? '—' : x.cpu_percent.toFixed(1) + '%'}</td><td>${x.memory_mb == null ? '—' : x.memory_mb.toFixed(1) + ' MB'}</td><td>${esc(x.status)}</td></tr>`).join('')}</tbody></table></div></details></section>
      <section class="mg-op-section"><h3>Webhook activity</h3><p class="mg-muted">Signed deliveries, branch decisions and deployment outcomes. Manual tests do not check a GitHub signature.</p>${d.webhook_events.length ? d.webhook_events.map(x => `<article class="mg-op-row"><div><b>${esc(x.event || 'unknown')} · ${esc(x.result)}</b><p>Signature: ${esc(x.signature || 'unknown')} · ${esc(x.ref || '—')}</p><p>${esc(x.message)}</p><small>${esc(x.timestamp)}${x.delivery ? ' · ' + esc(x.delivery) : ''}</small></div></article>`).join('') : opEmpty('No deliveries recorded.')}</section>
      <section class="mg-op-section"><h3>Activity history</h3>${activityHtml(d.activity)}</section>`;
    P.dirty.operations = false;
    const form = $('mgOperationsForm');
    form.addEventListener('input', () => { P.dirty.operations = true; });
    form.addEventListener('submit', async e => {
        e.preventDefault(); const serviceName = P.name;
        const data = Object.fromEntries(new FormData(form));
        for (const k of ['health_enabled','backup_enabled']) data[k] = form.elements[k].checked;
        for (const k of ['expected_status','timeout_seconds','failure_threshold','interval_hours','retain_count']) data[k] = Number(data[k]);
        const button = form.querySelector('button[type=submit]'); button.disabled = true;
        const result = await PUT(svcPath(serviceName) + '/operations', data);
        if (P.name !== serviceName || !panelOpen()) return;
        button.disabled = false;
        $('mgOpSaveStatus').textContent = result.ok ? 'Saved' : result.error;
        if (result.ok) { P.dirty.operations = false; toast('Operations settings saved'); loadOperations(); }
    });
}
document.addEventListener('click', async e => {
    const refresh = e.target.closest('[data-op-refresh]');
    if (refresh) {
        if (P.dirty.operations && !await confirmDlg({title:'Discard unsaved settings?',confirm:'Discard',body:'<p>Refreshing replaces the unsaved health and backup settings.</p>'})) return;
        loadOperations(); return;
    }
    const ack = e.target.closest('[data-op-ack]');
    if (ack) {
        ack.disabled = true; const r = await POST('/alerts/' + ack.dataset.opAck + '/ack', {});
        if (!r.ok) { ack.disabled = false; toast(r.error, true); return; }
        if ($('mgOperationsGlobal').open) loadGlobalOperations();
        else if (P.tab === 'operations' && !P.dirty.operations) loadOperations();
        else { ack.textContent = 'Acknowledged'; }
        return;
    }
    const rollback = e.target.closest('[data-op-rollback]');
    if (rollback) {
        const name = P.name, id = Number(rollback.dataset.opRollback);
        const row = operationsData?.deployments.find(x => x.id === id);
        if (!row || !await confirmDlg({title:'Roll back ' + name + '?',danger:true,confirm:'Roll back',type:name,body:`<p>Restore code to <code>${esc(row.commit_sha)}</code>, rebuild dependencies and restart this service. Database and environment values remain unchanged. Type <b>${esc(name)}</b> to confirm.</p>`})) return;
        adoptJob(await POST(svcPath(name) + '/rollback', {deployment_id:id,confirm:name}), 'Rolling back', true);
    }
});
const globalOps = document.createElement('dialog');
globalOps.id = 'mgOperationsGlobal'; globalOps.className = 'dk-dialog mg-wide';
globalOps.setAttribute('aria-labelledby','mgOpsTitle');
globalOps.innerHTML = '<div class="dk-dhead"><h2 id="mgOpsTitle">Alerts &amp; activity</h2><button class="term-btn" data-close>Close</button></div><div class="mg-op-global" id="mgOpsGlobalBody"></div>';
document.body.append(globalOps);
const globalButton = document.createElement('button'); globalButton.id = 'mgOperationsBtn';
globalButton.className = 'term-btn'; globalButton.textContent = 'Alerts & activity';
$('mgSettingsBtn').before(globalButton);
globalButton.addEventListener('click', () => { openDlg(globalOps); loadGlobalOperations(); });
async function loadGlobalOperations(badgeOnly = false) {
    const r = await GET('/operations');
    if (!r.ok) { if (!badgeOnly) $('mgOpsGlobalBody').innerHTML = `<div class="mg-note bad" role="alert">${esc(r.error)}</div>`; return; }
    const active = r.data.alerts.filter(x => x.active && !x.acknowledged).length;
    globalButton.textContent = active ? `Alerts & activity · ${active}` : 'Alerts & activity';
    globalButton.classList.toggle('mg-bad', active > 0);
    if (badgeOnly) return; // Keep the reader's position and keyboard focus during background badge refreshes.
    $('mgOpsGlobalBody').innerHTML = collectorHtml(r.data.collector) + '<h3>Alerts</h3>' + alertsHtml(r.data.alerts) + '<h3>Activity history</h3>' + activityHtml(r.data.activity);
}
setInterval(() => { if (!document.hidden && $('tab-manage').classList.contains('active')) loadGlobalOperations(true); }, 30000);
globalOps.addEventListener('keydown', e => { if (e.key === 'Escape') globalOps.close(); });
})();

'use strict';

// ── STATE ──────────────────────────────────────────────────
let prev          = {};
let activeTab     = 'overview';
let activeLogType = 'ats';
let activeDbTable = 'services';
let logAutoScroll = true;
let auditFilterVal = '';
let auditCache    = [];
let logFilterVal  = '';

// Terminal State
let term = null;
let fitAddon = null;
let socket = null;
let termInactivityTimer = null;
const TERM_TIMEOUT = 10 * 60 * 1000; // 10 minutes

function resetTermTimeout() {
    clearTimeout(termInactivityTimer);
    termInactivityTimer = setTimeout(() => {
        if (socket && socket.connected) {
            socket.disconnect();
            if (term) termShowOverlay('Session timed out', 'Closed after 10 minutes without typing. Start a new session to continue.');
        }
    }, TERM_TIMEOUT);
}

// ── CHANGE DETECTION ───────────────────────────────────────
function flash(el) {
    if (!el) return;
    el.classList.remove('changed');
    void el.offsetWidth;
    el.classList.add('changed');
}

function setVal(el, newVal, key) {
    if (!el) return;
    const str = String(newVal);
    if (prev[key] !== undefined && prev[key] !== str) flash(el);
    prev[key] = str;
    el.textContent = str;
}

function setText(id, val, key) {
    setVal(document.getElementById(id), val, key || id);
}

// ── CLOCK ──────────────────────────────────────────────────
function updateClock() {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-GB');
}
setInterval(updateClock, 1000);
updateClock();

// ── THEME SWITCHER ────────────────────────────────────────
function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('theme', t);
    document.querySelectorAll('.theme-opt').forEach(b => {
        b.classList.toggle('active', b.dataset.theme === t);
        b.setAttribute('aria-pressed', String(b.dataset.theme === t));
    });
    const nameEl = document.getElementById('theme-name');
    if (nameEl) nameEl.textContent = THEME_NAMES[t] || t;
    if (term) updateTermTheme();
}

const THEME_NAMES = { jetblack: 'Graphite', light: 'Paper', midnight: 'Ink', rose: 'Clay' };

// xterm palettes follow the active theme (dark themes share ANSI colours)
function termPalette() {
    const t = document.documentElement.getAttribute('data-theme');
    const css = getComputedStyle(document.documentElement);
    const v = n => css.getPropertyValue(n).trim();
    const isDark = ['jetblack', 'midnight'].includes(t);
    return {
        background: v('--term-bg'),
        foreground: v('--text-1'),
        cursor: v('--accent'),
        cursorAccent: v('--term-bg'),
        selectionBackground: isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)',
        black: isDark ? '#3a3a36' : '#1c1b18',
        red: isDark ? '#f0605a' : '#b3261e',
        green: isDark ? '#62c48a' : '#2b7a4b',
        yellow: isDark ? '#e6b23c' : '#9a6a06',
        blue: isDark ? '#6ea4ff' : '#285ea8',
        magenta: isDark ? '#c792ea' : '#7a4a9a',
        cyan: isDark ? '#5fcfcf' : '#1f7a7a',
        white: isDark ? '#d8d6cf' : '#55534b',
        brightBlack: isDark ? '#6b6a63' : '#85827a',
        brightRed: isDark ? '#ff7a74' : '#cc3b32',
        brightGreen: isDark ? '#7fdba3' : '#3a9460',
        brightYellow: isDark ? '#f3c75a' : '#b8820f',
        brightBlue: isDark ? '#8dbaff' : '#3b78cc',
        brightMagenta: isDark ? '#d8aaf5' : '#9460b5',
        brightCyan: isDark ? '#7fe0e0' : '#2a9494',
        brightWhite: isDark ? '#ffffff' : '#000000'
    };
}

function updateTermTheme() {
    term.options.theme = termPalette();
}
setTheme(localStorage.getItem('theme') || 'jetblack');

function setThemeMenu(open) {
    document.querySelector('.theme-dots')?.classList.toggle('open', open);
    document.getElementById('theme-btn')?.setAttribute('aria-expanded', String(open));
}

document.getElementById('theme-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    setThemeMenu(!document.querySelector('.theme-dots')?.classList.contains('open'));
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.querySelector('.theme-dots.open')) {
        setThemeMenu(false);
        document.getElementById('theme-btn')?.focus();
    }
});

document.querySelectorAll('.theme-opt').forEach(btn => {
    btn.addEventListener('click', () => {
        setTheme(btn.dataset.theme);
        setThemeMenu(false);
    });
});

document.addEventListener('click', () => setThemeMenu(false));

// ── TABS ──────────────────────────────────────────────────
const TAB_META = {
    overview: ['Overview',  'Live state of every service on this host.'],
    manage:   ['Manage',    'Deploy, configure and operate the services on this host.'],
    metrics:  ['Metrics',   'Pass / warn / fail checks across disk, network, services and the database.'],
    logs:     ['Logs',      'Tail of the ATS, security and Prometheus logs.'],
    audit:    ['Audit',     'Who did what, and when.'],
    database: ['Database',  'Read-only view of the monitor tables.'],
    stats:    ['Stats',     'Per-service performance, deployments and backups.'],
    docker:   ['Docker',    'Containers, images, volumes and networks on this host.'],
    terminal: ['Terminal',  'Interactive shell on the server. Sessions end after 10 minutes idle.']
};

function syncHeadHeight() {
    const h = document.querySelector('.site-header');
    if (h) document.documentElement.style.setProperty('--head-h', h.getBoundingClientRect().height + 'px');
}
window.addEventListener('resize', syncHeadHeight);
if (window.ResizeObserver) new ResizeObserver(syncHeadHeight).observe(document.querySelector('.site-header'));
syncHeadHeight();

function stamp() {
    const el = document.getElementById('lastUpdated');
    if (el) el.textContent = new Date().toLocaleTimeString('en-GB');
}
document.querySelectorAll('.nav-link').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tabcontent').forEach(s => s.classList.remove('active'));
        document.querySelectorAll('.nav-link').forEach(b => b.removeAttribute('aria-current'));
        btn.classList.add('active');
        btn.setAttribute('aria-current', 'page');
        activeTab = btn.dataset.tab;
        const tabEl = document.getElementById('tab-' + activeTab);
        if (tabEl) tabEl.classList.add('active');
        const meta = TAB_META[activeTab];
        if (meta) {
            document.getElementById('pageTitle').textContent = meta[0];
            document.getElementById('pageSub').textContent = meta[1];
        }
        document.querySelector('.page-head').style.display = activeTab === 'terminal' ? 'none' : '';

        if (activeTab === 'terminal') {
            if (!socket || !socket.connected) initTerminal();
            resetTermTimeout();
            if (term && fitAddon) setTimeout(() => { termFit(); term.focus(); }, 50);
        } else {
            refreshActive();
        }
    });
});

// ── PHONE TAB BAR ──────────────────────────────────────────
// Bottom bar mirrors the sidebar buttons; it just clicks the real .nav-link.
const MORE_TABS = ['logs', 'metrics', 'audit', 'database', 'stats'];
function setMoreSheet(open) {
    const sheet = document.getElementById('moreSheet'), back = document.getElementById('moreBackdrop'), btn = document.getElementById('tbMore');
    if (!sheet) return;
    sheet.hidden = back.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
}
function syncTabbar() {
    document.querySelectorAll('.tb-btn[data-tab]').forEach(b => {
        const on = b.dataset.tab === activeTab;
        b.classList.toggle('active', on);
        if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    document.getElementById('tbMore')?.classList.toggle('active', MORE_TABS.includes(activeTab));
    document.querySelectorAll('.ms-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTab));
    document.body.dataset.tab = activeTab;
}
document.querySelectorAll('.nav-link').forEach(b => b.addEventListener('click', syncTabbar));
document.querySelectorAll('.tb-btn[data-tab], .ms-btn').forEach(b => b.addEventListener('click', () => {
    setMoreSheet(false);
    document.querySelector('.nav-link[data-tab="' + b.dataset.tab + '"]')?.click();
    window.scrollTo(0, 0);
}));
document.getElementById('tbMore')?.addEventListener('click', () => setMoreSheet(document.getElementById('moreSheet').hidden));
document.getElementById('moreBackdrop')?.addEventListener('click', () => setMoreSheet(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMoreSheet(false); });
syncTabbar();

// ── LOG SUB-TABS ───────────────────────────────────────────
document.querySelectorAll('.logtab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.logtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeLogType = btn.dataset.logtype;
        fetchLogs();
    });
});

document.getElementById('logAutoScroll')?.addEventListener('change', e => {
    logAutoScroll = e.target.checked;
});

document.getElementById('logFilter')?.addEventListener('input', e => {
    logFilterVal = e.target.value.toLowerCase();
    fetchLogs(true);
});

document.getElementById('clearLogs')?.addEventListener('click', () => {
    const viewer = document.getElementById('logViewer');
    if (viewer) viewer.innerHTML = '';
});

// ── DB SUB-TABS ────────────────────────────────────────────
document.querySelectorAll('.dbtab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.dbtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeDbTable = btn.dataset.dbtable;
        fetchDatabase();
    });
});

// ── AUDIT FILTER ───────────────────────────────────────────
document.getElementById('auditFilter')?.addEventListener('input', e => {
    auditFilterVal = e.target.value.toLowerCase();
    filterAuditEntries();
});

// ── SAFE FETCH ─────────────────────────────────────────────
async function api(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

// ═══════════════════════════════════════════════════════════
//   OVERVIEW & METRICS
// ═══════════════════════════════════════════════════════════
function setBar(barId, pct, warnAt, critAt) {
    const el = document.getElementById(barId);
    if (!el) return;
    el.style.width = Math.max(0, Math.min(pct, 100)) + '%';
    el.classList.toggle('crit', pct > critAt);
    el.classList.toggle('warn', pct > warnAt && pct <= critAt);
}

function renderBanner(d) {
    const box = document.getElementById('statusBanner');
    if (!box) return;
    const down = d.total - d.online;
    const netDown = [['internet', 'Internet'], ['dns', 'DNS']].filter(([k]) => d[k] === false || d[k] === 0).map(x => x[1]);
    let cls = 'ok', text = 'All systems operational';
    if (down > 0) { cls = 'bad'; text = down + (down === 1 ? ' service is' : ' services are') + ' offline'; }
    else if (netDown.length) { cls = 'bad'; text = netDown.join(' and ') + ' check failing'; }
    box.className = 'status-banner ' + cls;
    document.getElementById('sbText').textContent = text;
    document.getElementById('sbSub').textContent = d.online + ' of ' + d.total + ' services online';
}

async function fetchOverview() {
    const d = await api('/api/overview');
    if (!d) return;

    setText('ov-online',  d.online,  'online');
    setText('ov-offline', (d.total - d.online), 'offline');
    document.getElementById('ov-offline')?.classList.toggle('zero', d.total - d.online === 0);
    setText('ov-total',   d.total + ' total', 'total');

    const cpuStr = d.cpu != null ? d.cpu.toFixed(1) + '%' : 'N/A';
    setText('ov-cpu', cpuStr, 'cpu');
    setText('ov-load', 'load ' + (d.load ? d.load[0] : '--'), 'load');
    setText('ov-uptime', d.uptime || 'N/A', 'uptime');

    if (d.ram) {
        setText('ov-ram-val', d.ram.pct.toFixed(1) + '%', 'ram-pct');
        setText('ov-ram-detail', d.ram.used + ' / ' + d.ram.total + ' GB', 'ram-detail');
        setBar('ov-ram-bar', d.ram.pct, 75, 90);
    }
    if (d.swap) {
        setText('ov-swap-val', d.swap.pct.toFixed(1) + '%', 'swap-pct');
        setText('ov-swap-detail', d.swap.used + ' / ' + d.swap.total + ' MB', 'swap-detail');
        setBar('ov-swap-bar', d.swap.pct, 60, 80);
    }
    if (d.disk_root) {
        setText('ov-disk1-val', d.disk_root.pct + '%', 'disk1-pct');
        setText('ov-disk1-detail', d.disk_root.used + ' / ' + d.disk_root.total + ' GB', 'disk1-detail');
        setBar('ov-disk1-bar', d.disk_root.pct, 75, 90);
    }
    if (d.disk_storage) {
        setText('ov-disk2-val', d.disk_storage.pct + '%', 'disk2-pct');
        setText('ov-disk2-detail', d.disk_storage.used + ' / ' + d.disk_storage.total + ' GB', 'disk2-detail');
        setBar('ov-disk2-bar', d.disk_storage.pct, 75, 90);
    }

    setPill('ov-inet', d.internet, 'INTERNET');
    setPill('ov-dns',  d.dns,      'DNS');
    setPill('ov-cf',   d.cloudflare, 'CLOUDFLARE');

    renderBanner(d);
    renderServiceCards(d.services);
    renderMetrics(d);
    stamp();
}

function renderMetrics(d) {
    let diskHtml = '';
    [d.disk_root, d.disk_storage].forEach(dk => {
        if (!dk) return;
        const st = dk.pct > 90 ? 'fail' : dk.pct > 75 ? 'warn' : 'pass';
        diskHtml += metRow('Disk (' + dk.path + ')', st, dk.used + ' / ' + dk.total + ' GB (' + dk.pct + '%)');
    });
    setInner('mt-disk', diskHtml);

    let netHtml = metRow('Internet', d.internet ? 'pass' : 'fail', d.internet ? 'Online' : 'Offline') +
                  metRow('DNS', d.dns ? 'pass' : 'fail', d.dns ? 'Resolving' : 'Failed') +
                  metRow('Cloudflare', d.cloudflare ? 'pass' : 'warn', d.cloudflare ? 'Active' : 'Inactive');
    setInner('mt-network', netHtml);

    let svcHtml = '';
    if (d.services) {
        d.services.forEach(s => {
            svcHtml += metRow(s.name, s.status === 'online' ? 'pass' : 'fail', s.status.toUpperCase());
        });
    }
    setInner('mt-services', svcHtml);

    let resHtml = metRow('CPU Usage', d.cpu > 80 ? 'fail' : d.cpu > 60 ? 'warn' : 'pass', d.cpu + '%') +
                  metRow('RAM Usage', d.ram ? (d.ram.pct > 90 ? 'fail' : d.ram.pct > 75 ? 'warn' : 'pass') : 'warn', d.ram ? d.ram.used + ' / ' + d.ram.total + ' GB' : '--') +
                  metRow('Load Avg', 'pass', d.load ? d.load.join(' ') : 'N/A');
    setInner('mt-resources', resHtml);

    const dbSt = d.db_integrity ? 'pass' : (d.db_exists ? 'fail' : 'warn');
    const dbMsg = d.db_exists ? (d.db_status || 'OK') : 'Not found at ' + d.db_path;
    let dbHtml = metRow('Database Status', dbSt, dbMsg);
    if (d.db_stats) {
        Object.entries(d.db_stats).forEach(([t, c]) => {
            dbHtml += metRow('Table: ' + t, c > 2000 ? 'warn' : 'pass', c + ' rows');
        });
    }
    setInner('mt-dbintegrity', dbHtml);
}

function metRow(label, status, detail) {
    const cls = { pass: 'status-pass', fail: 'status-fail', warn: 'status-warn' }[status] || '';
    const sym = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' }[status] || status;
    return `<div class="metrics-row">
        <span class="metrics-row-label">${esc(label)}</span>
        <span class="metrics-row-status ${cls}">${sym}</span>
        <span class="metrics-row-detail">${esc(detail)}</span>
    </div>`;
}

function setInner(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html || '<div class="empty-note">No data.</div>';
}

function setPill(id, ok, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'pill ' + (ok ? 'ok' : 'fail');
    el.textContent = label + (ok ? ' OK' : ' FAIL');
}

function renderServiceCards(services) {
    const grid = document.getElementById('ov-services');
    if (!grid) return;
    if (!services || services.length === 0) {
        delete grid.dataset.sig;
        grid.innerHTML = '<div class="empty-note" style="grid-column:1/-1">No services registered.</div>';
        return;
    }
    const svcHtml = services.map(svc => `
        <div class="svc-card ${esc(svc.status)}">
            <div class="svc-top">
                <div class="svc-name">${esc(svc.name)}</div>
                <div class="svc-badge ${esc(svc.status)}">${esc(svc.status)}</div>
            </div>
            <a href="https://${esc(svc.domain)}" target="_blank" rel="noopener noreferrer" class="svc-link">${esc(svc.domain || 'localhost')}</a>
            <div class="svc-footer">
                <div class="svc-stat">
                    <span class="stat-lbl">Port</span>
                    <span class="stat-val">:${svc.port}</span>
                </div>
                <div class="svc-stat">
                    <span class="stat-lbl">Runtime</span>
                    <span class="stat-val">${esc(svc.runtime)}</span>
                </div>
            </div>
        </div>
    `).join('');
    if (grid.dataset.sig === svcHtml) return;
    grid.dataset.sig = svcHtml;
    grid.innerHTML = svcHtml;
}

// ═══════════════════════════════════════════════════════════
//   LOGS
// ═══════════════════════════════════════════════════════════
let lastLogData = [];

async function fetchLogs(isRedraw = false) {
    if (!isRedraw) {
        const d = await api('/api/logs?type=' + activeLogType + '&n=400');
        if (!d) return;
        lastLogData = d.lines;
    }

    const viewer = document.getElementById('logViewer');
    if (!viewer) return;

    const filtered = logFilterVal 
        ? lastLogData.filter(l => l.toLowerCase().includes(logFilterVal))
        : lastLogData;

    const wasAtBottom = viewer.scrollHeight - viewer.clientHeight <= viewer.scrollTop + 50;
    
    if (filtered.length === 0) {
        viewer.innerHTML = '<div class="log-empty">' + (logFilterVal ? 'No lines match the filter.' : 'Nothing logged yet.') + '</div>';
        document.getElementById('logLineCount').textContent = '0 lines';
        return;
    }
    viewer.innerHTML = filtered.map(line => {
        const cls = classifyLog(line, activeLogType);
        return `<div class="log-line ${cls}">${esc(line)}</div>`;
    }).join('');

    document.getElementById('logLineCount').textContent = filtered.length + ' lines';
    stamp();
    if (logAutoScroll && wasAtBottom) viewer.scrollTop = viewer.scrollHeight;
}

function classifyLog(line, type) {
    if (type === 'metrics' && line.startsWith('#')) return 'log-prom-comment';
    const u = line.toUpperCase();
    if (u.includes('ERROR') || u.includes('CRITICAL') || u.includes('FAILED')) return 'log-error';
    if (u.includes('WARN')) return 'log-warning';
    if (u.includes('INFO')) return 'log-info';
    return '';
}

// ═══════════════════════════════════════════════════════════
//   REAL TERMINAL (XTERM.JS + PTY)
// ═══════════════════════════════════════════════════════════
const TERM_FONT_MIN = 10, TERM_FONT_MAX = 22;
let termFont = parseInt(localStorage.getItem('termFont'), 10) || (window.matchMedia('(max-width: 900px)').matches ? 12 : 14);
let termMods = { ctrl: false, alt: false };
let termToastTimer = null;
let termWasConnected = false;

function termSend(s) {
    if (socket && socket.connected) {
        socket.emit('terminal_input', {input: s});
        resetTermTimeout();
    }
}

function termToast(msg) {
    const el = document.getElementById('term-toast');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(termToastTimer);
    termToastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

function termSetMod(name, on) {
    termMods[name] = on;
    document.querySelector(`.term-keys [data-mod="${name}"]`)?.setAttribute('aria-pressed', String(on));
}

// sticky Ctrl / Alt from the key bar apply to the next typed character
function termApplyMods(data) {
    if (!termMods.ctrl && !termMods.alt) return data;
    let out = data;
    if (termMods.ctrl && data.length === 1) {
        const c = data.toUpperCase().charCodeAt(0);
        if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
        else if (data === ' ') out = '\x00';
    }
    if (termMods.alt) out = '\x1b' + out;
    termSetMod('ctrl', false);
    termSetMod('alt', false);
    return out;
}

function termKeySeq(name) {
    const appMode = term.modes && term.modes.applicationCursorKeysMode;
    const arrow = ch => '\x1b' + (appMode ? 'O' : '[') + ch;
    return {
        esc: '\x1b', tab: '\t',
        up: arrow('A'), down: arrow('B'), right: arrow('C'), left: arrow('D'),
        home: '\x1b[H', end: '\x1b[F', pgup: '\x1b[5~', pgdn: '\x1b[6~'
    }[name];
}

async function termCopy() {
    const text = term.getSelection();
    if (!text) { termToast('Select some text first'); return; }
    try {
        await navigator.clipboard.writeText(text);
    } catch (e) {
        // clipboard API needs a secure context; fall back to a hidden textarea
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (_) {}
        ta.remove();
    }
    termToast('Copied');
    term.focus();
}

async function termPaste() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) term.paste(text);
        term.focus();
    } catch (e) {
        term.focus();
        termToast('Browser blocked clipboard. Use Ctrl+Shift+V or long-press to paste');
    }
}

function termFit() {
    if (!fitAddon || !document.getElementById('tab-terminal').classList.contains('active')) return;
    try { fitAddon.fit(); } catch (_) {}
}

function termSetFont(px) {
    termFont = Math.max(TERM_FONT_MIN, Math.min(TERM_FONT_MAX, px));
    localStorage.setItem('termFont', termFont);
    if (term) { term.options.fontSize = termFont; termFit(); }
    document.getElementById('term-font-down').disabled = termFont <= TERM_FONT_MIN;
    document.getElementById('term-font-up').disabled = termFont >= TERM_FONT_MAX;
}

function termShowOverlay(title, sub) {
    document.getElementById('term-overlay-title').textContent = title;
    document.getElementById('term-overlay-sub').textContent = sub;
    document.getElementById('term-overlay').hidden = false;
}
function termHideOverlay() { document.getElementById('term-overlay').hidden = true; }

function termReconnect() {
    termHideOverlay();
    term.reset();
    if (socket.connected) socket.disconnect();
    socket.connect();
    term.focus();
}

// keep the terminal above the on-screen keyboard on phones
function termSyncViewport() {
    const tab = document.getElementById('tab-terminal');
    const vv = window.visualViewport;
    if (!vv || !tab) return;
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    const keyboard = narrow && vv.height < window.innerHeight - 120;
    tab.classList.toggle('kb-open', keyboard);
    if (keyboard) {
        tab.style.top = vv.offsetTop + 'px';
        tab.style.height = vv.height + 'px';
        tab.style.bottom = 'auto';
    } else {
        tab.style.top = tab.style.height = tab.style.bottom = '';
    }
    termFit();
}

function initTerminal() {
    if (term) {
        if (socket && !socket.connected) termReconnect();
        return;
    }

    term = new Terminal({
        cursorBlink: true,
        fontFamily: "'IBM Plex Mono', ui-monospace, Menlo, Consolas, monospace",
        fontSize: termFont,
        scrollback: 5000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        theme: termPalette()
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    termSetFont(termFont);

    if (document.fonts && document.fonts.load) {
        // re-measure cells once the web font is in (xterm ignores same-value assignments)
        document.fonts.load('13px "IBM Plex Mono"').then(() => {
            const f = term.options.fontFamily;
            term.options.fontFamily = 'monospace';
            term.options.fontFamily = f;
            termFit();
        });
    }
    setTimeout(termFit, 150);
    setTimeout(termFit, 500);

    socket = io('/terminal', { autoConnect: false });

    socket.on('connect', () => {
        const statusEl = document.getElementById('term-status');
        statusEl.textContent = 'CONNECTED';
        statusEl.className = 'term-status connected';
        termHideOverlay();
        if (termWasConnected) term.write('\r\n\x1b[2m[reconnected: new shell session]\x1b[0m\r\n');
        termWasConnected = true;
        termFit();
        socket.emit('terminal_resize', {cols: term.cols, rows: term.rows});
        resetTermTimeout();
        if (activeTab === 'terminal') term.focus();
    });

    socket.on('connect_error', () => {
        const statusEl = document.getElementById('term-status');
        statusEl.textContent = 'CONNECTION FAILED';
        statusEl.className = 'term-status';
        termShowOverlay('Unable to connect', 'Check your connection and sign in again if your session expired. Then start a new session.');
    });

    socket.on('terminal_exit', () => {
        socket.disconnect();
        const statusEl = document.getElementById('term-status');
        statusEl.textContent = 'SESSION ENDED';
        statusEl.className = 'term-status';
        termShowOverlay('Session ended', 'Start a new session to open a fresh shell.');
    });

    socket.on('terminal_output', (data) => {
        term.write(String(data));
    });

    socket.on('disconnect', (reason) => {
        const statusEl = document.getElementById('term-status');
        statusEl.textContent = 'DISCONNECTED';
        statusEl.className = 'term-status';
        if (reason === 'io client disconnect') return;
        termShowOverlay('Connection lost', 'Trying to reconnect. A new connection starts a fresh shell, so unfinished commands are gone.');
    });

    term.onData(data => {
        termSend(termApplyMods(data));
    });

    // the pty size follows the visible grid, whatever caused the resize
    term.onResize(({cols, rows}) => {
        if (socket && socket.connected) socket.emit('terminal_resize', {cols, rows});
    });
    window.addEventListener('resize', termFit);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', termSyncViewport);
        window.visualViewport.addEventListener('scroll', termSyncViewport);
    }
    if (window.ResizeObserver) new ResizeObserver(termFit).observe(document.getElementById('terminal-container'));

    // Ctrl+C copies when text is selected (otherwise it is SIGINT); Ctrl+Shift+C always copies.
    // Ctrl+Shift+V is left to the browser's native paste event, which xterm handles.
    term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.shiftKey && e.code === 'KeyV') return false;
        if (mod && (e.shiftKey || e.metaKey || term.hasSelection()) && e.code === 'KeyC') {
            if (term.hasSelection()) { termCopy(); term.clearSelection(); }
            return false;
        }
        return true;
    });

    // Enter on the "session ended" overlay starts a new session
    document.addEventListener('keydown', (e) => {
        if (activeTab !== 'terminal' || e.key !== 'Enter') return;
        if (!document.getElementById('term-overlay').hidden) { e.preventDefault(); e.stopPropagation(); termReconnect(); }
    }, true);

    // toolbar
    document.getElementById('term-clear-btn').addEventListener('click', () => { term.clear(); term.focus(); });
    document.getElementById('term-reconnect-btn').addEventListener('click', termReconnect);
    document.getElementById('term-overlay-btn').addEventListener('click', termReconnect);
    document.getElementById('term-copy-btn').addEventListener('click', termCopy);
    document.getElementById('term-paste-btn').addEventListener('click', termPaste);
    document.getElementById('term-font-down').addEventListener('click', () => { termSetFont(termFont - 1); term.focus(); });
    document.getElementById('term-font-up').addEventListener('click', () => { termSetFont(termFont + 1); term.focus(); });

    const tab = document.getElementById('tab-terminal');
    const keysBtn = document.getElementById('term-keys-btn');
    const fullBtn = document.getElementById('term-full-btn');
    const setKeys = (on) => {
        tab.classList.toggle('keys-on', on);
        keysBtn.setAttribute('aria-pressed', String(on));
        localStorage.setItem('termKeys', on ? '1' : '0');
        termFit();
    };
    // key bar defaults on for touch devices, off for desktops
    const stored = localStorage.getItem('termKeys');
    setKeys(stored === null ? window.matchMedia('(pointer: coarse)').matches : stored === '1');
    keysBtn.addEventListener('click', () => setKeys(!tab.classList.contains('keys-on')));
    fullBtn.addEventListener('click', () => {
        const on = !tab.classList.contains('full');
        tab.classList.toggle('full', on);
        fullBtn.setAttribute('aria-pressed', String(on));
        fullBtn.textContent = on ? 'Collapse' : 'Expand';
        termFit(); term.focus();
    });

    // key bar: pointerdown is cancelled so the soft keyboard stays open
    const keys = document.getElementById('term-keys');
    keys.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    keys.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.mod) {
            termSetMod(b.dataset.mod, !termMods[b.dataset.mod]);
        } else if (b.dataset.key) {
            termSend(termApplyMods(termKeySeq(b.dataset.key)));
        } else if (b.dataset.ctrl) {
            termSend(String.fromCharCode(b.dataset.ctrl.toUpperCase().charCodeAt(0) - 64));
        } else if (b.dataset.send) {
            termSend(termApplyMods(b.dataset.send));
        }
        term.focus();
    });

    socket.connect();
}

// ═══════════════════════════════════════════════════════════
//   STATS (PER-SERVICE)
// ═══════════════════════════════════════════════════════════
function resBar(pct) {
    const p = Math.min(pct, 100);
    const cls = p > 90 ? 'res-fill crit' : p > 75 ? 'res-fill warn' : p > 50 ? 'res-fill' : 'res-fill low';
    return `<div class="res-track"><div class="${cls}" style="width:${p}%"></div></div>`;
}

async function fetchStats() {
    const d = await api('/api/stats');
    if (!d) return;

    const svcs = d.services || [];
    const onCount = svcs.filter(s => s.status === 'online').length;
    const offCount = svcs.length - onCount;
    const g = d.global || {};

    let avgCpu = 0, avgRam = 0, maxCpu = 0, maxRam = 0, totalBk = 0;
    if (svcs.length > 0) {
        let cpuSum = 0, ramSum = 0;
        svcs.forEach(s => {
            const c = (s.current_metrics || {}).cpu || 0;
            const r = (s.current_metrics || {}).ram || 0;
            cpuSum += c; ramSum += r;
            if (c > maxCpu) maxCpu = c;
            if (r > maxRam) maxRam = r;
            totalBk += (s.backup_count || 0);
        });
        avgCpu = cpuSum / svcs.length;
        avgRam = ramSum / svcs.length;
    }
    const totalDep = g.total_deployments || 0;
    const succRate = g.deployment_success_rate || 0;

    const heroEl = document.getElementById('statsHero');
    if (heroEl) {
        heroEl.innerHTML = `
            <div class="stats-hero-grid">
                <div class="hero-card"><div class="hero-val green">${onCount}</div><div class="hero-lbl">ONLINE</div></div>
                <div class="hero-card"><div class="hero-val ${offCount > 0 ? 'red' : 'zero'}">${offCount}</div><div class="hero-lbl">OFFLINE</div></div>
                <div class="hero-card"><div class="hero-val">${svcs.length}</div><div class="hero-lbl">SERVICES</div></div>
                <div class="hero-card"><div class="hero-val cyan">${totalDep}</div><div class="hero-lbl">DEPLOYS</div></div>
                <div class="hero-card"><div class="hero-val ${succRate >= 80 ? 'green' : succRate >= 50 ? 'amber' : 'red'}">${succRate}%</div><div class="hero-lbl">SUCCESS RATE</div></div>
                <div class="hero-card"><div class="hero-val cyan">${totalBk}</div><div class="hero-lbl">BACKUPS</div></div>
                <div class="hero-card"><div class="hero-val ${avgCpu > 80 ? 'red' : avgCpu > 60 ? 'amber' : 'zero'}">${avgCpu.toFixed(1)}%</div><div class="hero-lbl">AVG CPU</div></div>
                <div class="hero-card"><div class="hero-val purple">${g.active_workers || 0}</div><div class="hero-lbl">WORKERS</div></div>
            </div>`;
    }

    stamp();
    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    if (svcs.length === 0) {
        delete grid.dataset.sig;
        grid.innerHTML = '<div class="empty-note" style="grid-column:1/-1">No service data available.</div>';
        return;
    }

    const statsHtml = svcs.map(s => {
        const curr = s.current_metrics || {cpu: 0, ram: 0};
        const cTrend = s.trend || [];
        const avgC = cTrend.length > 0 ? (cTrend.reduce((a,b)=>a+b,0) / cTrend.length).toFixed(1) : curr.cpu.toFixed(1);
        const maxC = cTrend.length > 0 ? Math.max(...cTrend).toFixed(1) : curr.cpu.toFixed(1);
        const avgR = curr.ram.toFixed(1);
        const maxR = curr.ram.toFixed(1);

        const cCls = s.status !== 'online' ? '' : curr.cpu > 80 ? 'bad' : curr.cpu > 50 ? 'warn' : 'ok';
        const rCls = s.status !== 'online' ? '' : curr.ram > 80 ? 'bad' : curr.ram > 50 ? 'warn' : 'ok';

        const sparkHtml = cTrend.length > 0
            ? '<div class="sparkline-box">' + cTrend.map(v => `<div class="spark-bar" style="height:${Math.max(10,v)}%"></div>`).join('') + '</div>'
            : '';

        const rate = s.deploy_total > 0 ? (s.deploy_ok / s.deploy_total * 100).toFixed(1) : 0;
        const depFail = (s.deploy_total || 0) - (s.deploy_ok || 0);
        const depBarCls = rate >= 80 ? 'dep-fill ok' : rate >= 50 ? 'dep-fill warn' : 'dep-fill bad';

        const lastDep = s.last_deploy
            ? `<span class="last-dep ${s.last_deploy.status === 'success' ? 'dep-ok' : 'dep-fail'}">${esc(s.last_deploy.status)} ${esc(s.last_deploy.timestamp || '')}</span>`
            : '<span class="stat-lbl">No deployments</span>';

        return `
            <div class="stats-card ${esc(s.status)}">
                <div class="stats-card-header">
                    <div class="stats-card-name">${esc(s.name)}</div>
                    <div class="svc-badge ${esc(s.status)}">${esc(s.status)}</div>
                </div>
                <div class="stats-card-body">
                    <div class="svc-meta-row">
                        <span class="svc-meta-item"><span class="svc-meta-lbl">Host</span><span class="svc-meta-val">${esc(s.domain || 'localhost')}</span></span>
                        <span class="svc-meta-item"><span class="svc-meta-lbl">Port</span><span class="svc-meta-val">:${s.port}</span></span>
                        <span class="svc-meta-item"><span class="svc-meta-lbl">Since</span><span class="svc-meta-val">${esc(s.created_at || '—')}</span></span>
                    </div>

                    <div class="stats-section-title">PERFORMANCE</div>
                    <div class="res-row">
                        <div class="res-label">CPU</div>
                        <div class="res-bar-wrap">${resBar(curr.cpu)}</div>
                        <div class="res-pct ${cCls}">${curr.cpu.toFixed(1)}%</div>
                    </div>
                    <div class="res-detail">avg ${avgC}% &middot; peak ${maxC}%</div>
                    <div class="res-row">
                        <div class="res-label">RAM</div>
                        <div class="res-bar-wrap">${resBar(curr.ram)}</div>
                        <div class="res-pct ${rCls}">${curr.ram.toFixed(1)}%</div>
                    </div>
                    <div class="res-detail">${curr.ram_mb ? curr.ram_mb.toFixed(0) + ' MB' : ''} &middot; avg ${avgR}% &middot; peak ${maxR}%</div>

                    <div class="stats-section-title">DEPLOYMENTS</div>
                    <div class="dep-stats">
                        <div class="dep-stat"><span class="dep-num">${s.deploy_total || 0}</span><span class="dep-lbl">Total</span></div>
                        <div class="dep-stat"><span class="dep-num green">${s.deploy_ok || 0}</span><span class="dep-lbl">Success</span></div>
                        <div class="dep-stat"><span class="dep-num red">${depFail}</span><span class="dep-lbl">Failed</span></div>
                        <div class="dep-stat"><span class="dep-num ${rate >= 80 ? 'green' : rate >= 50 ? 'amber' : 'red'}">${rate}%</span><span class="dep-lbl">Rate</span></div>
                    </div>
                    <div class="dep-rate-bar"><div class="${depBarCls}" style="width:${rate}%"></div></div>
                    <div class="res-detail">Last: ${lastDep}</div>

                    <div class="stats-section-title">BACKUPS</div>
                    <div class="res-row">
                        <span class="res-label">Versions</span>
                        <span class="res-pct">${s.backup_count || 0}</span>
                    </div>

                    ${sparkHtml ? '<div class="stats-section-title">CPU TREND</div>' + sparkHtml : ''}
                </div>
            </div>`;
    }).join('');
    if (grid.dataset.sig === statsHtml) return;
    grid.dataset.sig = statsHtml;
    grid.innerHTML = statsHtml;
}

// ═══════════════════════════════════════════════════════════
//   AUDIT & DATABASE
// ═══════════════════════════════════════════════════════════
async function fetchAudit() {
    const d = await api('/api/audit');
    if (!d || !d.entries) return;
    stamp();
    auditCache = d.entries;
    filterAuditEntries();
}

function filterAuditEntries() {
    const list = document.getElementById('auditList');
    if (!list) return;

    const filtered = auditFilterVal 
        ? auditCache.filter(e => JSON.stringify(e).toLowerCase().includes(auditFilterVal))
        : auditCache;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-note">No audit records found.</div>';
        document.getElementById('auditCount').textContent = '0 entries';
        return;
    }

    list.innerHTML = filtered.map(e => {
        const action = (e.action || 'system').toLowerCase();
        let cat = 'other';
        if (action.includes('deploy')) cat = 'deploy';
        else if (action.includes('backup')) cat = 'backup';
        else if (action.includes('update') || action.includes('edit') || action.includes('config')) cat = 'update';
        else if (action.includes('destroy') || action.includes('delete') || action.includes('fail')) cat = 'destroy';
        else if (action.includes('webhook')) cat = 'webhook';

        return `
            <div class="audit-entry entry-${cat}">
                <div class="audit-left">
                    <span class="audit-action ${cat}">${esc(e.action || 'SYSTEM')}</span>
                    <span class="audit-time">${esc(e.timestamp || '--:--')}</span>
                </div>
                <div class="audit-right">
                    <div class="audit-target">${esc(e.target || 'System Event')}</div>
                    <div class="audit-meta">${esc(e.user || 'system')} · ${esc(e.details || 'Operational log.')}</div>
                </div>
            </div>`;
    }).join('');

    document.getElementById('auditCount').textContent = filtered.length + ' entries';
}

async function fetchDatabase() {
    const d = await api('/api/database?table=' + activeDbTable);
    if (!d) return;
    stamp();
    const info = document.getElementById('dbTableInfo');
    if (info) info.innerHTML = '<span class="db-badge">' + esc(activeDbTable) + ' · ' + d.rows.length + ' rows</span>';
    const head = document.querySelector('.data-table thead');
    const body = document.querySelector('.data-table tbody');
    if (!head || !body) return;

    head.innerHTML = '<tr>' + d.columns.map(c => `<th scope="col">${esc(c)}</th>`).join('') + '</tr>';
    body.innerHTML = d.rows.map(row => 
        '<tr>' + d.columns.map(col => `<td>${esc(row[col])}</td>`).join('') + '</tr>'
    ).join('');
}

// ═══════════════════════════════════════════════════════════
//   POLLING
// ═══════════════════════════════════════════════════════════
function refreshActive() {
    if (activeTab === 'overview' || activeTab === 'metrics') fetchOverview();
    if (activeTab === 'logs') fetchLogs();
    if (activeTab === 'audit') fetchAudit();
    if (activeTab === 'database') fetchDatabase();
    if (activeTab === 'stats') fetchStats();
    if (activeTab === 'docker' && typeof fetchDocker === 'function') fetchDocker();
    if (activeTab === 'manage' && typeof fetchManage === 'function') fetchManage();
}

setInterval(refreshActive, 5000);
refreshActive();

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── IDLE TIMEOUT (10 min) ────────────────────────────────
let idleTimer = null;
const IDLE_LIMIT = 10 * 60 * 1000;

function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { window.location.href = '/logout'; }, IDLE_LIMIT);
}

['mousemove','keydown','click','scroll','touchstart'].forEach(evt => {
    document.addEventListener(evt, resetIdle, {passive: true});
});
resetIdle();

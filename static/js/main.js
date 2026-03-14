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

// ── TABS ───────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tabcontent').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        const tabEl = document.getElementById('tab-' + activeTab);
        if (tabEl) tabEl.classList.add('active');
        
        if (activeTab === 'terminal') {
            initTerminal();
        } else {
            refreshActive();
        }
    });
});

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
    el.style.width = Math.min(pct, 100) + '%';
    const color = pct >= (critAt || 90) ? 'crit' : pct >= (warnAt || 70) ? 'warn' : '';
    el.className = 'bar-fill' + (el.id.includes('swap') ? ' amber' : el.id.includes('disk') ? ' cyan' : '') + (color ? ' ' + color : '');
}

async function fetchOverview() {
    const d = await api('/api/overview');
    if (!d) return;

    setText('ov-online',  d.online,  'online');
    setText('ov-offline', (d.total - d.online), 'offline');
    setText('ov-total',   'of ' + d.total + ' total', 'total');

    const cpuStr = d.cpu != null ? d.cpu.toFixed(1) + '%' : 'N/A';
    setText('ov-cpu', cpuStr, 'cpu');
    setText('ov-load', d.load ? 'load ' + d.load[0] : 'load N/A', 'load');
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

    renderServiceCards(d.services);
    renderMetrics(d);
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
                  metRow('RAM Usage', d.ram.pct > 90 ? 'fail' : d.ram.pct > 75 ? 'warn' : 'pass', d.ram.pct.toFixed(1) + '%') +
                  metRow('Load Avg', 'pass', d.load ? d.load.join(' ') : 'N/A');
    setInner('mt-resources', resHtml);
// DB Integrity
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
    const sym = { pass: '✓ PASS', fail: '✗ FAIL', warn: '⚠ WARN' }[status] || status;
    return `<div class="metrics-row">
        <span class="metrics-row-label">${esc(label)}</span>
        <span class="metrics-row-status ${cls}">${sym}</span>
        <span class="metrics-row-detail">${esc(detail)}</span>
    </div>`;
}

function setInner(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html || '<div style="padding:1rem;color:var(--muted)">No data.</div>';
}

function setPill(id, ok, label) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'pill ' + (ok ? 'ok' : 'fail');
    el.textContent = label + (ok ? ' ✓' : ' ✗');
}

function renderServiceCards(services) {
    const grid = document.getElementById('ov-services');
    if (!grid) return;
    if (!services || services.length === 0) {
        grid.innerHTML = '<div style="color:var(--muted);padding:2rem;text-align:center;grid-column:1/-1">No services.</div>';
        return;
    }
    grid.innerHTML = services.map(svc => `
        <div class="svc-card ${svc.status}">
            <div class="svc-name">${esc(svc.name)}</div>
            <div class="svc-domain">${esc(svc.domain)}</div>
            <div class="svc-meta">
                <span class="svc-port">:${svc.port}</span>
                <span class="svc-runtime">${esc(svc.runtime)}</span>
            </div>
            <div class="svc-badge ${svc.status}"><span class="dot"></span>${svc.status.toUpperCase()}</div>
        </div>
    `).join('');
}

// ═══════════════════════════════════════════════════════════
//   LOGS (TERMINAL-LIKE VIEW)
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
    
    viewer.innerHTML = filtered.map(line => {
        const cls = classifyLog(line, activeLogType);
        return `<div class="log-line ${cls}">${esc(line)}</div>`;
    }).join('');

    document.getElementById('logLineCount').textContent = filtered.length + ' lines';
    if (logAutoScroll && wasAtBottom) viewer.scrollTop = viewer.scrollHeight;
}

function classifyLog(line, type) {
    const u = line.toUpperCase();
    if (u.includes('ERROR') || u.includes('CRITICAL') || u.includes('FAILED')) return 'log-error';
    if (u.includes('WARN')) return 'log-warning';
    if (u.includes('INFO')) return 'log-info';
    if (u.includes('DEBUG')) return 'log-debug';
    return 'log-plain';
}

// ═══════════════════════════════════════════════════════════
//   REAL TERMINAL (XTERM.JS + PTY)
// ═══════════════════════════════════════════════════════════
function initTerminal() {
    if (term) return;

    term = new Terminal({
        cursorBlink: true,
        fontFamily: "'Azeret Mono', monospace",
        fontSize: 13,
        theme: {
            background: '#000000',
            foreground: '#e2e8f4',
            cursor: '#00ff88',
            selectionBackground: '#1a1f2e'
        }
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    socket = io('/terminal');

    socket.on('connect', () => {
        document.getElementById('term-status').textContent = 'CONNECTED';
        document.getElementById('term-status').style.color = 'var(--green)';
        socket.emit('terminal_resize', {cols: term.cols, rows: term.rows});
    });

    socket.on('terminal_output', (data) => {
        term.write(data.data);
    });

    socket.on('disconnect', () => {
        document.getElementById('term-status').textContent = 'DISCONNECTED';
        document.getElementById('term-status').style.color = 'var(--red)';
    });

    term.onData(data => {
        socket.emit('terminal_input', {input: data});
    });

    window.addEventListener('resize', () => {
        if (fitAddon) fitAddon.fit();
        if (socket) socket.emit('terminal_resize', {cols: term.cols, rows: term.rows});
    });

    document.getElementById('term-clear-btn')?.addEventListener('click', () => term.clear());
    document.getElementById('term-reconnect-btn')?.addEventListener('click', () => {
        if (socket) socket.disconnect();
        socket.connect();
        term.clear();
    });
}

// ═══════════════════════════════════════════════════════════
//   STATS (PER-SERVICE)
// ═══════════════════════════════════════════════════════════
async function fetchStats() {
    const d = await api('/api/stats');
    if (!d) return;
    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    if (!d.services || d.services.length === 0) {
        grid.innerHTML = '<div style="color:var(--muted);padding:2rem;text-align:center;grid-column:1/-1">No data.</div>';
        return;
    }

    grid.innerHTML = d.services.map(s => {
        const rate = s.deploy_total > 0 ? (s.deploy_ok / s.deploy_total * 100).toFixed(1) : 0;
        const lastDep = s.last_deploy ? s.last_deploy.status + ' (' + s.last_deploy.timestamp.substring(0,16) + ')' : '—';
        
        return `<div class="svc-card ${s.status}">
            <div class="svc-name">${esc(s.name)}</div>
            <div class="svc-meta">
                <span>Port: ${s.port}</span>
                <span>Status: <b style="color:${s.status==='online'?'var(--green)':'var(--red)'}">${s.status.toUpperCase()}</b></span>
            </div>
            <div style="margin-top:1rem;font-size:0.65rem">
                <div style="display:flex;justify-content:space-between;margin-bottom:0.3rem">
                    <span style="color:var(--text2)">Deploy Success</span>
                    <span>${rate}% (${s.deploy_ok}/${s.deploy_total})</span>
                </div>
                <div class="bar-track"><div class="bar-fill" style="width:${rate}%"></div></div>
                <div style="margin-top:0.8rem;color:var(--text2)">Last Deploy: <span style="color:var(--text)">${esc(lastDep)}</span></div>
                <div style="margin-top:0.4rem;color:var(--text2)">Backups: <span style="color:var(--cyan)">${s.backup_count}</span></div>
            </div>
        </div>`;
    }).join('');
}

// ═══════════════════════════════════════════════════════════
//   AUDIT & DATABASE
// ═══════════════════════════════════════════════════════════
async function fetchAudit() {
    const d = await api('/api/audit');
    if (!d) return;
    auditCache = d.entries;
    filterAuditEntries();
}

function filterAuditEntries() {
    const list = document.getElementById('auditList');
    if (!list) return;
    const filtered = auditFilterVal 
        ? auditCache.filter(e => JSON.stringify(e).toLowerCase().includes(auditFilterVal))
        : auditCache;
    
    list.innerHTML = filtered.map(e => `
        <div class="audit-entry">
            <div class="audit-action">${esc(e.action || 'RAW')}</div>
            <div style="flex:1">
                <div class="audit-target">${esc(e.target || '—')}</div>
                <div class="audit-time">${esc(e.timestamp || '')}</div>
            </div>
        </div>
    `).join('');
    document.getElementById('auditCount').textContent = filtered.length + ' entries';
}

async function fetchDatabase() {
    const d = await api('/api/database?table=' + activeDbTable);
    if (!d) return;
    const head = document.getElementById('dbTableHead');
    const body = document.getElementById('dbTableBody');
    if (!head || !body) return;

    head.innerHTML = '<tr>' + d.columns.map(c => `<th>${esc(c)}</th>`).join('') + '</tr>';
    body.innerHTML = d.rows.map(row => 
        '<tr>' + d.columns.map(col => `<td>${esc(row[col])}</td>`).join('') + '</tr>'
    ).join('');
}

// ═══════════════════════════════════════════════════════════
//   POLLING
// ═══════════════════════════════════════════════════════════
function refreshActive() {
    if (activeTab === 'overview') fetchOverview();
    if (activeTab === 'logs') fetchLogs();
    if (activeTab === 'audit') fetchAudit();
    if (activeTab === 'database') fetchDatabase();
    if (activeTab === 'stats') fetchStats();
}

setInterval(refreshActive, 5000);
refreshActive();

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

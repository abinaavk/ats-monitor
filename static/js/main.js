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

// ── TABS (Sidebar Nav) ──────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
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
document.querySelectorAll('.log-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.log-tab').forEach(b => b.classList.remove('active'));
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
    // Colors handled by CSS gradients in new theme, but we can adjust opacity
    el.style.opacity = pct > (critAt || 90) ? '1' : '0.8';
}

async function fetchOverview() {
    const d = await api('/api/overview');
    if (!d) return;

    setText('ov-online',  d.online,  'online');
    setText('ov-offline', (d.total - d.online), 'offline');
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
    if (el) el.innerHTML = html || '<div style="padding:1rem;color:var(--text-dim)">No data.</div>';
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
        grid.innerHTML = '<div style="color:var(--text-dim);padding:2rem;text-align:center;grid-column:1/-1">No services.</div>';
        return;
    }
    grid.innerHTML = services.map(svc => `
        <div class="svc-card ${svc.status}">
            <div class="svc-top">
                <div class="svc-name">${esc(svc.name)}</div>
                <div class="svc-badge ${svc.status}">${svc.status}</div>
            </div>
            <a href="https://${svc.domain}" target="_blank" class="svc-link">${esc(svc.domain || 'localhost')}</a>
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
}

// ═══════════════════════════════════════════════════════════
//   LOGS (NEW CONTAINER VIEW)
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
        return `<div class="log-entry ${cls}">${esc(line)}</div>`;
    }).join('');

    document.getElementById('logLineCount').textContent = filtered.length + ' lines';
    if (logAutoScroll && wasAtBottom) viewer.scrollTop = viewer.scrollHeight;
}

function classifyLog(line, type) {
    const u = line.toUpperCase();
    if (u.includes('ERROR') || u.includes('CRITICAL') || u.includes('FAILED')) return 'log-error';
    if (u.includes('WARN')) return 'log-warn';
    if (u.includes('INFO')) return 'log-info';
    return '';
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
            cursor: '#00f59b',
            selectionBackground: 'rgba(0,245,155,0.2)'
        }
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal-container'));
    fitAddon.fit();

    socket = io('/terminal');

    socket.on('connect', () => {
        const statusEl = document.getElementById('term-status');
        if (statusEl) {
            statusEl.textContent = 'CONNECTED';
            statusEl.className = 'term-status connected';
        }
        socket.emit('terminal_resize', {cols: term.cols, rows: term.rows});
    });

    socket.on('terminal_output', (data) => {
        term.write(data.data);
    });

    socket.on('disconnect', () => {
        const statusEl = document.getElementById('term-status');
        if (statusEl) {
            statusEl.textContent = 'DISCONNECTED';
            statusEl.className = 'term-status';
        }
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

    if (d.global) {
        setText('st-total-svcs', d.global.total_services, 'st-svcs');
        setText('st-total-deploys', d.global.total_deployments, 'st-deploys');
        setText('st-success-rate', d.global.deployment_success_rate + '%', 'st-rate');
        setText('st-total-bk', d.global.total_backups, 'st-bk');
    }

    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    if (!d.services || d.services.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);padding:3rem;text-align:center;grid-column:1/-1">No service data available.</div>';
        return;
    }

    grid.innerHTML = d.services.map(s => {
        const rate = s.deploy_total > 0 ? (s.deploy_ok / s.deploy_total * 100).toFixed(1) : 0;
        const lastDep = s.last_deploy ? (s.last_deploy.status + ' (' + s.last_deploy.timestamp.substring(11,16) + ')') : 'None';
        
        let sparkHtml = '';
        if (s.trend && s.trend.length > 0) {
            sparkHtml = `<div class="sparkline-box">` + 
                s.trend.map(val => `<div class="spark-bar" style="height:${Math.max(10, val)}%"></div>`).join('') + 
                `</div>`;
        }

        const curr = s.current_metrics || {cpu: 0, ram: 0};
        const cpuColor = curr.cpu > 80 ? 'var(--error)' : curr.cpu > 50 ? 'var(--warning)' : 'var(--accent)';
        const ramColor = curr.ram > 80 ? 'var(--error)' : curr.ram > 50 ? 'var(--warning)' : 'var(--info)';

        return `
            <div class="stats-card ${s.status}">
                <div class="stats-card-header">
                    <div class="stats-card-name">${esc(s.name)}</div>
                    <div class="svc-badge ${s.status}">${s.status}</div>
                </div>
                <div class="stats-card-body">
                    <div style="display:flex; justify-content:space-between; margin-bottom:1rem">
                        <div style="text-align:center; flex:1">
                            <div style="font-size:0.55rem; color:var(--text-dim); margin-bottom:4px">CPU</div>
                            <div style="font-size:1.2rem; font-weight:800; color:${cpuColor}">${curr.cpu.toFixed(1)}%</div>
                        </div>
                        <div style="width:1px; background:var(--border); margin:0 15px"></div>
                        <div style="text-align:center; flex:1">
                            <div style="font-size:0.55rem; color:var(--text-dim); margin-bottom:4px">RAM</div>
                            <div style="font-size:1.2rem; font-weight:800; color:${ramColor}">${curr.ram.toFixed(1)}%</div>
                        </div>
                    </div>

                    <div class="stats-row">
                        <span class="stats-row-label">Host</span>
                        <span class="stats-row-val">${esc(s.domain)}:${s.port}</span>
                    </div>
                    <div class="stats-row">
                        <span class="stats-row-label">Integrity</span>
                        <span class="stats-row-val">${rate}% success</span>
                    </div>
                    <div class="deploy-rate-bar"><div class="deploy-rate-fill" style="width:${rate}%; background:${rate > 80 ? 'var(--accent)' : 'var(--warning)'}"></div></div>
                    
                    <div class="stats-divider"></div>
                    
                    <div class="stats-row">
                        <span class="stats-row-label">Activity</span>
                        <span class="stats-row-val">${esc(lastDep)}</span>
                    </div>
                    <div class="stats-row">
                        <span class="stats-row-label">Backups</span>
                        <span class="stats-row-val" style="color:var(--info)">${s.backup_count} versions</span>
                    </div>

                    ${sparkHtml}
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

    if (filtered.length === 0) {
        list.innerHTML = '<div style="color:var(--text-dim);padding:3rem;text-align:center;font-size:0.75rem">No audit records found.</div>';
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
            <div class="audit-entry">
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
    const head = document.querySelector('.data-table thead');
    const body = document.querySelector('.data-table tbody');
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

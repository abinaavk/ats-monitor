/* ═══════════════════════════════════════════════════════
   ATS MONITOR — main.js
   5-second polling · Change detection · Tab routing
═══════════════════════════════════════════════════════ */

'use strict';

// ── STATE ────────────────────────────────────────────────
let prev     = {};          // flat key→value store for change detection
let activeTab    = 'overview';
let activeLogType = 'ats';
let activeDbTable = 'services';
let logAutoScroll = true;
let auditFilterVal = '';

// ── CHANGE DETECTION HELPER ──────────────────────────────
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

// ── CLOCK ────────────────────────────────────────────────
function updateClock() {
    const el = document.getElementById('clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-GB');
}
setInterval(updateClock, 1000);
updateClock();

// ── TABS ─────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tabcontent').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        activeTab = btn.dataset.tab;
        document.getElementById('tab-' + activeTab).classList.add('active');
        refreshActive();
    });
});

// ── LOG SUB-TABS ─────────────────────────────────────────
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

// ── DB SUB-TABS ──────────────────────────────────────────
document.querySelectorAll('.dbtab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.dbtab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeDbTable = btn.dataset.dbtable;
        fetchDatabase();
    });
});

// ── AUDIT FILTER ─────────────────────────────────────────
document.getElementById('auditFilter')?.addEventListener('input', e => {
    auditFilterVal = e.target.value.toLowerCase();
    filterAuditEntries();
});

// ── SAFE FETCH ───────────────────────────────────────────
async function api(url) {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

// ══════════════════════════════════════════════════════════
//   OVERVIEW
// ══════════════════════════════════════════════════════════
function barColor(pct, warn = 70, crit = 90) {
    if (pct >= crit) return 'crit';
    if (pct >= warn) return 'warn';
    return '';
}

function setBar(barId, pct, warnAt = 70, critAt = 90) {
    const el = document.getElementById(barId);
    if (!el) return;
    const cls = barColor(pct, warnAt, critAt);
    el.style.width = Math.min(pct, 100) + '%';
    el.className = 'bar-fill' + (cls ? ' ' + cls : '');
    if (barId.includes('amber')) el.classList.add('amber');
    if (barId.includes('cyan') || barId.includes('disk')) el.classList.add('cyan');
}

async function fetchOverview() {
    const d = await api('/api/overview');
    if (!d) return;

    // Hero stats
    setText('ov-online',  d.online,  'online');
    setText('ov-offline', d.offline, 'offline');
    setText('ov-total',   `of ${d.total} total`, 'total');

    const cpuStr = d.cpu != null ? d.cpu.toFixed(1) + '%' : 'N/A';
    setText('ov-cpu', cpuStr, 'cpu');
    setText('ov-load', d.load ? `load ${d.load[0]}` : 'load N/A', 'load');
    setText('ov-uptime', d.uptime || 'N/A', 'uptime');

    // RAM
    if (d.ram) {
        setText('ov-ram-val', d.ram.pct + '%', 'ram-pct');
        setText('ov-ram-detail', `${d.ram.used} / ${d.ram.total} GB`, 'ram-detail');
        setBar('ov-ram-bar', d.ram.pct, 75, 90);
    }

    // Swap
    if (d.swap) {
        setText('ov-swap-val', d.swap.pct + '%', 'swap-pct');
        setText('ov-swap-detail', `${d.swap.used} / ${d.swap.total} MB`, 'swap-detail');
        setBar('ov-swap-bar', d.swap.pct, 60, 80);
    }

    // Disks
    if (d.disk_root) {
        setText('ov-disk1-val', d.disk_root.pct + '%', 'disk1-pct');
        setText('ov-disk1-detail', `${d.disk_root.used} / ${d.disk_root.total} GB · ${d.disk_root.free} GB free`, 'disk1-detail');
        setBar('ov-disk1-bar', d.disk_root.pct, 75, 90);
    }
    if (d.disk_storage) {
        setText('ov-disk2-val', d.disk_storage.pct + '%', 'disk2-pct');
        setText('ov-disk2-detail', `${d.disk_storage.used} / ${d.disk_storage.total} GB · ${d.disk_storage.free} GB free`, 'disk2-detail');
        setBar('ov-disk2-bar', d.disk_storage.pct, 75, 90);
    }

    // Network pills
    setPill('ov-inet', d.internet, 'INTERNET');
    setPill('ov-dns',  d.dns,      'DNS');
    setPill('ov-cf',   d.cloudflare, 'CLOUDFLARE');

    // Services
    renderServiceCards(d.services);

    // Also push data to metrics tab if it's active
    renderMetrics(d);
}

function setPill(id, ok, label) {
    const el = document.getElementById(id);
    if (!el) return;
    const newClass = ok ? 'pill ok' : 'pill fail';
    const newText  = label + ' ' + (ok ? '✓' : '✗');
    if (el.textContent !== newText) flash(el);
    el.className = newClass;
    el.textContent = newText;
}

function renderServiceCards(services) {
    const grid = document.getElementById('ov-services');
    if (!grid) return;
    if (!services || services.length === 0) {
        grid.innerHTML = '<div class="placeholder-msg">No services registered.</div>';
        return;
    }

    services.forEach(svc => {
        const key = 'svc-' + svc.name;
        let card = document.getElementById(key);

        if (!card) {
            card = document.createElement('div');
            card.id = key;
            card.className = 'svc-card ' + svc.status;
            grid.appendChild(card);
        }

        const prevStatus = prev['svc-status-' + svc.name];
        if (prevStatus && prevStatus !== svc.status) flash(card);
        prev['svc-status-' + svc.name] = svc.status;

        card.className = 'svc-card ' + svc.status;
        card.innerHTML = `
            <div class="svc-name">${esc(svc.name)}</div>
            <div class="svc-domain">${esc(svc.domain)}</div>
            <div class="svc-meta">
                <span>:${svc.port}</span>
                <span>${svc.runtime}</span>
                <span>${svc.workers}w</span>
            </div>
            <div class="svc-badge ${svc.status}">
                ${svc.status === 'online' ? '● ONLINE' : '● OFFLINE'}
            </div>`;
    });
}

// ══════════════════════════════════════════════════════════
//   METRICS
// ══════════════════════════════════════════════════════════
function renderMetrics(d) {
    // Disk
    let diskHtml = '';
    for (const dk of [d.disk_root, d.disk_storage]) {
        if (!dk) continue;
        const st = dk.pct > 90 ? 'fail' : dk.pct > 75 ? 'warn' : 'pass';
        diskHtml += metRow(
            `Disk (${dk.path})`,
            st,
            `${dk.used} GB / ${dk.total} GB  (${dk.pct}% used)  ${dk.free} GB free`
        );
    }
    setInner('mt-disk', diskHtml);

    // Network
    let netHtml = metRow('Internet Connectivity', d.internet ? 'pass' : 'fail', d.internet ? '1.1.1.1 reachable' : 'No connection');
    netHtml    += metRow('DNS Resolution',         d.dns       ? 'pass' : 'fail', d.dns       ? 'github.com reachable' : 'DNS not resolving');
    netHtml    += metRow('Cloudflare Tunnel',       d.cloudflare? 'pass' : 'warn', d.cloudflare? 'cloudflared active' : 'cloudflared not running');
    setInner('mt-network', netHtml);

    // Service health
    let svcHtml = '';
    if (d.services) {
        d.services.forEach(s => {
            svcHtml += metRow(
                `${s.name} (:${s.port})`,
                s.status === 'online' ? 'pass' : 'fail',
                s.status === 'online' ? 'Online' : 'Offline'
            );
        });
        const hc = d.online, uc = d.offline;
        svcHtml += metRow('Summary', hc === d.total ? 'pass' : 'warn',
            `${hc} healthy · ${uc} unhealthy`);
    }
    setInner('mt-services', svcHtml);

    // Resources
    let resHtml = '';
    if (d.cpu != null) {
        resHtml += metRow('CPU Usage', d.cpu > 80 ? 'fail' : d.cpu > 60 ? 'warn' : 'pass',
            `${d.cpu.toFixed(1)}%`);
    }
    if (d.ram) {
        resHtml += metRow('RAM Usage', d.ram.pct > 90 ? 'fail' : d.ram.pct > 75 ? 'warn' : 'pass',
            `${d.ram.used} GB / ${d.ram.total} GB  (${d.ram.pct}%)`);
    }
    if (d.swap) {
        resHtml += metRow('Swap Usage', d.swap.pct > 80 ? 'fail' : d.swap.pct > 50 ? 'warn' : 'pass',
            `${d.swap.used} MB / ${d.swap.total} MB  (${d.swap.pct}%)`);
    }
    if (d.load) {
        resHtml += metRow('Load Average', 'pass', `1m: ${d.load[0]}  5m: ${d.load[1]}  15m: ${d.load[2]}`);
    }
    resHtml += metRow('System Uptime', 'pass', d.uptime || 'N/A');
    setInner('mt-resources', resHtml);

    // DB integrity
    let dbHtml = metRow('Integrity Check', d.db_integrity ? 'pass' : 'fail',
        d.db_integrity ? 'ok' : 'Errors detected');
    if (d.db_stats) {
        for (const [t, c] of Object.entries(d.db_stats)) {
            dbHtml += metRow(`Table: ${t}`, c > 500 ? 'warn' : 'pass', `${c} records`);
        }
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
    if (el) el.innerHTML = html || '<div class="placeholder-msg">No data.</div>';
}

// ══════════════════════════════════════════════════════════
//   LOGS
// ══════════════════════════════════════════════════════════
async function fetchLogs() {
    const d = await api(`/api/logs?type=${activeLogType}&n=300`);
    if (!d) return;

    const viewer = document.getElementById('logViewer');
    if (!viewer) return;

    const countEl = document.getElementById('logLineCount');
    if (countEl) countEl.textContent = d.lines.length + ' lines';

    const wasAtBottom = viewer.scrollHeight - viewer.clientHeight <= viewer.scrollTop + 20;

    viewer.innerHTML = d.lines.map(line => {
        const cls = classifyLog(line, activeLogType);
        return `<div class="log-line ${cls}">${esc(line)}</div>`;
    }).join('');

    if (logAutoScroll && wasAtBottom) {
        viewer.scrollTop = viewer.scrollHeight;
    }
}

function classifyLog(line, type) {
    if (type === 'metrics') {
        if (line.startsWith('#')) return 'log-prom-comment';
        if (line.trim()) return 'log-prom-metric';
        return 'log-plain';
    }
    const u = line.toUpperCase();
    if (u.includes('CRITICAL')) return 'log-critical';
    if (u.includes('| ERROR') || u.includes('ERROR   |')) return 'log-error';
    if (u.includes('WARNING')) return 'log-warning';
    if (u.includes('| INFO')  || u.includes('INFO    |')) return 'log-info';
    if (u.includes('DEBUG'))   return 'log-debug';
    return 'log-plain';
}

// ══════════════════════════════════════════════════════════
//   AUDIT
// ══════════════════════════════════════════════════════════
let auditCache = [];

async function fetchAudit() {
    const d = await api('/api/audit?n=200');
    if (!d) return;
    auditCache = d.entries;
    filterAuditEntries();
    const c = document.getElementById('auditCount');
    if (c) c.textContent = d.entries.length + ' entries';
}

function filterAuditEntries() {
    const list = document.getElementById('auditList');
    if (!list) return;
    const f = auditFilterVal;
    const filtered = f
        ? auditCache.filter(e =>
            (e.action || '').toLowerCase().includes(f) ||
            (e.target || '').toLowerCase().includes(f))
        : auditCache;

    if (filtered.length === 0) {
        list.innerHTML = '<div class="placeholder-msg">No matching entries.</div>';
        return;
    }

    list.innerHTML = filtered.map(e => {
        const action = e.action || 'RAW';
        const cls    = auditActionClass(action);
        const ts     = e.timestamp ? e.timestamp.replace('T', ' ').substring(0, 19) : '—';
        const meta   = e.metadata && Object.keys(e.metadata).length
            ? Object.entries(e.metadata).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join(' · ')
            : '';
        return `<div class="audit-entry">
            <div>
                <div class="audit-action ${cls}">${esc(action)}</div>
                <div class="audit-time">${esc(ts)}</div>
            </div>
            <div class="audit-body">
                <div class="audit-target">${esc(e.target || '')}</div>
                ${meta ? `<div class="audit-meta">${esc(meta)}</div>` : ''}
            </div>
            <div class="audit-user">${esc(e.user || '')}</div>
        </div>`;
    }).join('');
}

function auditActionClass(action) {
    const a = action.toUpperCase();
    if (a.includes('DEPLOY')) return 'deploy';
    if (a.includes('DESTROY') || a.includes('DELETE')) return 'destroy';
    if (a.includes('BACKUP') || a.includes('RESTORE')) return 'backup';
    if (a.includes('UPDATE') || a.includes('RESTART') || a.includes('START') || a.includes('STOP')) return 'update';
    if (a.includes('WEBHOOK')) return 'webhook';
    if (a.includes('CONFIG') || a.includes('DATABASE')) return 'config';
    if (a.includes('SYSTEM') || a.includes('SCHEDULED')) return 'system';
    return 'other';
}

// ══════════════════════════════════════════════════════════
//   DATABASE VIEWER
// ══════════════════════════════════════════════════════════
async function fetchDatabase() {
    const d = await api(`/api/database?table=${activeDbTable}&limit=100`);
    if (!d) return;

    const infoEl = document.getElementById('dbTableInfo');
    if (infoEl) infoEl.textContent = `${d.rows.length} rows · ${d.table}`;

    const head = document.getElementById('dbTableHead');
    const body = document.getElementById('dbTableBody');
    if (!head || !body) return;

    head.innerHTML = '<tr>' + (d.columns || []).map(c =>
        `<th>${esc(c)}</th>`).join('') + '</tr>';

    body.innerHTML = (d.rows || []).map(row =>
        '<tr>' + (d.columns || []).map(col => {
            const val = row[col];
            const str = val == null ? '' : String(val);
            const cls = getCellClass(col, str);
            return `<td class="${cls}" title="${esc(str)}">${esc(str.length > 50 ? str.substring(0, 50) + '…' : str)}</td>`;
        }).join('') + '</tr>'
    ).join('');
}

function getCellClass(col, val) {
    const c = col.toLowerCase();
    if (c === 'status') return val === 'active' || val === 'success' ? 'td-green' : val === 'failed' ? 'td-red' : '';
    if (c === 'runtime') return 'td-cyan';
    if (c.includes('error') || c.includes('failed')) return val ? 'td-red' : '';
    if (c.includes('created') || c.includes('timestamp') || c.includes('updated')) return 'td-muted';
    if (c === 'port') return 'td-amber';
    return '';
}

// ══════════════════════════════════════════════════════════
//   STATS (per-service)
// ══════════════════════════════════════════════════════════
async function fetchStats() {
    const d = await api('/api/stats');
    if (!d) return;
    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    if (!d.services || d.services.length === 0) {
        grid.innerHTML = '<div class="placeholder-msg">No services found.</div>';
        return;
    }

    grid.innerHTML = d.services.map(s => {
        const rate = s.deploy_rate != null ? s.deploy_rate : 0;
        const rateColor = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--amber)' : 'var(--red)';
        const lastDep = s.last_deploy
            ? `${s.last_deploy.status}  ${(s.last_deploy.duration_seconds||0).toFixed(1)}s  ${(s.last_deploy.timestamp||'').substring(0,19)}`
            : '—';
        const lastBk = s.last_backup
            ? `${(s.last_backup.size_bytes/1024/1024).toFixed(2)} MB  ${(s.last_backup.timestamp||'').substring(0,19)}`
            : '—';

        return `<div class="stats-card">
            <div class="stats-card-header">
                <span class="stats-card-name">${esc(s.name)}</span>
                <span class="svc-badge ${s.status}">${s.status === 'online' ? '● ONLINE' : '● OFFLINE'}</span>
            </div>
            <div class="stats-card-body">
                <div class="stats-row"><span class="stats-row-label">Domain</span><span class="stats-row-val" style="color:var(--cyan)">${esc(s.domain)}</span></div>
                <div class="stats-row"><span class="stats-row-label">Port</span><span class="stats-row-val" style="color:var(--amber)">:${s.port}</span></div>
                <div class="stats-row"><span class="stats-row-label">Runtime</span><span class="stats-row-val">${esc(s.runtime)}</span></div>
                <div class="stats-row"><span class="stats-row-label">Workers</span><span class="stats-row-val">${s.workers}</span></div>
                <div class="stats-row"><span class="stats-row-label">Memory Limit</span><span class="stats-row-val">${s.memory_mb} MB</span></div>
                <div class="stats-row"><span class="stats-row-label">CPU Quota</span><span class="stats-row-val">${s.cpu_quota}%</span></div>
                <div class="stats-row"><span class="stats-row-label">Branch</span><span class="stats-row-val">${esc(s.branch)}</span></div>
                <div class="stats-divider"></div>
                <div class="stats-row">
                    <span class="stats-row-label">Deploy Success</span>
                    <span class="stats-row-val" style="color:${rateColor}">${s.deploy_rate != null ? s.deploy_rate + '%' : 'N/A'} (${s.deploy_ok}/${s.deploy_total})</span>
                </div>
                <div class="deploy-rate-bar">
                    <div class="deploy-rate-fill" style="width:${rate}%;background:${rateColor}"></div>
                </div>
                <div class="stats-row"><span class="stats-row-label">Last Deploy</span><span class="stats-row-val" style="font-size:0.58rem">${esc(lastDep)}</span></div>
                <div class="stats-divider"></div>
                <div class="stats-row"><span class="stats-row-label">Backups</span><span class="stats-row-val">${s.backup_count}</span></div>
                <div class="stats-row"><span class="stats-row-label">Last Backup</span><span class="stats-row-val" style="font-size:0.58rem">${esc(lastBk)}</span></div>
                <div class="stats-row"><span class="stats-row-label">Deployed</span><span class="stats-row-val" style="font-size:0.58rem">${esc((s.created_at||'').substring(0,19))}</span></div>
            </div>
        </div>`;
    }).join('');
}

// ══════════════════════════════════════════════════════════
//   POLLING LOOP
// ══════════════════════════════════════════════════════════
function refreshActive() {
    switch (activeTab) {
        case 'overview':  fetchOverview(); break;
        case 'metrics':   fetchOverviewForMetrics(); break;
        case 'logs':      fetchLogs(); break;
        case 'audit':     fetchAudit(); break;
        case 'database':  fetchDatabase(); break;
        case 'stats':     fetchStats(); break;
    }
}

async function fetchOverviewForMetrics() {
    const d = await api('/api/overview');
    if (d) renderMetrics(d);
}

// Poll every 5 seconds
setInterval(refreshActive, 5000);

// Initial load
refreshActive();

// ── UTILITY ──────────────────────────────────────────────
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

'use strict';

// ── STATE ──────────────────────────────────────────────────
let prev          = {};
let activeTab     = 'overview';
let activeLogType = 'ats';
let activeDbTable = 'services';
let logAutoScroll = true;
let auditFilterVal = '';
let auditCache    = [];

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
    // Clear skeleton children, set text
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
        document.getElementById('tab-' + activeTab).classList.add('active');
        refreshActive();
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
//   OVERVIEW
// ═══════════════════════════════════════════════════════════
function setBar(barId, pct, warnAt, critAt) {
    const el = document.getElementById(barId);
    if (!el) return;
    el.style.width = Math.min(pct, 100) + '%';
    const base = el.className.split(' ').filter(c => c === 'bar-fill' || c === 'amber' || c === 'cyan')[0] || 'bar-fill';
    const color = pct >= (critAt || 90) ? 'crit' : pct >= (warnAt || 70) ? 'warn' : '';
    el.className = 'bar-fill' + (el.id.includes('swap') ? ' amber' : el.id.includes('disk') ? ' cyan' : '') + (color ? ' ' + color : '');
}

async function fetchOverview() {
    const d = await api('/api/overview');
    if (!d) return;

    setText('ov-online',  d.online,  'online');
    setText('ov-offline', d.offline, 'offline');
    setText('ov-total',   'of ' + d.total + ' total', 'total');

    const cpuStr = d.cpu != null ? d.cpu.toFixed(1) + '%' : 'N/A';
    setText('ov-cpu', cpuStr, 'cpu');
    setText('ov-load', d.load ? 'load ' + d.load[0] : 'load N/A', 'load');
    setText('ov-uptime', d.uptime || 'N/A', 'uptime');

    if (d.ram) {
        setText('ov-ram-val', d.ram.pct + '%', 'ram-pct');
        setText('ov-ram-detail', d.ram.used + ' / ' + d.ram.total + ' GB', 'ram-detail');
        setBar('ov-ram-bar', d.ram.pct, 75, 90);
    }
    if (d.swap) {
        setText('ov-swap-val', d.swap.pct + '%', 'swap-pct');
        setText('ov-swap-detail', d.swap.used + ' / ' + d.swap.total + ' MB', 'swap-detail');
        setBar('ov-swap-bar', d.swap.pct, 60, 80);
    }
    if (d.disk_root) {
        setText('ov-disk1-val', d.disk_root.pct + '%', 'disk1-pct');
        setText('ov-disk1-detail', d.disk_root.used + ' / ' + d.disk_root.total + ' GB · ' + d.disk_root.free + ' GB free', 'disk1-detail');
        setBar('ov-disk1-bar', d.disk_root.pct, 75, 90);
    }
    if (d.disk_storage) {
        setText('ov-disk2-val', d.disk_storage.pct + '%', 'disk2-pct');
        setText('ov-disk2-detail', d.disk_storage.used + ' / ' + d.disk_storage.total + ' GB · ' + d.disk_storage.free + ' GB free', 'disk2-detail');
        setBar('ov-disk2-bar', d.disk_storage.pct, 75, 90);
    }

    setPill('ov-inet', d.internet, 'INTERNET');
    setPill('ov-dns',  d.dns,      'DNS');
    setPill('ov-cf',   d.cloudflare, 'CLOUDFLARE');

    renderServiceCards(d.services);
    if (activeTab === 'metrics') renderMetrics(d);
}

function setPill(id, ok, label) {
    const el = document.getElementById(id);
    if (!el) return;
    const newClass = ok ? 'pill ok' : 'pill fail';
    const newText  = label + (ok ? ' ✓' : ' ✗');
    if (el.textContent !== newText) flash(el);
    el.className = newClass;
    el.textContent = newText;
}

function renderServiceCards(services) {
    const grid = document.getElementById('ov-services');
    if (!grid) return;
    if (!services || services.length === 0) {
        grid.innerHTML = '<div style="color:var(--muted);font-size:.65rem;padding:2rem;text-align:center;grid-column:1/-1">No services registered.</div>';
        return;
    }

    // Clear skeletons on first render
    const hasSkel = grid.querySelector('.skel-card');
    if (hasSkel) grid.innerHTML = '';

    services.forEach(svc => {
        const key = 'svc-' + svc.name;
        let card = document.getElementById(key);

        if (!card) {
            card = document.createElement('div');
            card.id = key;
            grid.appendChild(card);
        }

        const prevStatus = prev['svc-status-' + svc.name];
        if (prevStatus && prevStatus !== svc.status) flash(card);
        prev['svc-status-' + svc.name] = svc.status;

        card.className = 'svc-card ' + svc.status;
        const url = svc.domain ? 'https://' + svc.domain : null;
        card.innerHTML =
            '<div class="svc-name">' + esc(svc.name) + '</div>' +
            (url
                ? '<a class="svc-domain" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(svc.domain) + '</a>'
                : '<div class="svc-domain">' + esc(svc.domain) + '</div>') +
            '<div class="svc-meta">' +
                '<span class="svc-port">:' + svc.port + '</span>' +
                '<span class="svc-runtime">' + esc(svc.runtime) + '</span>' +
                '<span class=\"svc-workers\">' + svc.workers + 'w</span>' +
            '</div>' +
            '<div class="svc-badge ' + svc.status + '">' +
                '<span class="dot"></span>' +
                (svc.status === 'online' ? 'ONLINE' : 'OFFLINE') +
            '</div>';
    });
}

// ═══════════════════════════════════════════════════════════
//   METRICS
// ═══════════════════════════════════════════════════════════
function renderMetrics(d) {
    // Disk
    let diskHtml = '';
    for (const dk of [d.disk_root, d.disk_storage]) {
        if (!dk) continue;
        const st = dk.pct > 90 ? 'fail' : dk.pct > 75 ? 'warn' : 'pass';
        diskHtml += metRow('Disk (' + dk.path + ')', st,
            dk.used + ' GB / ' + dk.total + ' GB  (' + dk.pct + '% used)  ' + dk.free + ' GB free');
    }
    setInner('mt-disk', diskHtml);

    // Network
    let netHtml =
        metRow('Internet Connectivity', d.internet ? 'pass' : 'fail', d.internet ? '1.1.1.1 reachable' : 'No connection') +
        metRow('DNS Resolution',        d.dns       ? 'pass' : 'fail', d.dns       ? 'github.com reachable' : 'DNS not resolving') +
        metRow('Cloudflare Tunnel',     d.cloudflare? 'pass' : 'warn', d.cloudflare? 'cloudflared active' : 'cloudflared not running');
    setInner('mt-network', netHtml);

    // Service health
    let svcHtml = '';
    if (d.services) {
        d.services.forEach(s => {
            svcHtml += metRow(s.name + ' (:' + s.port + ')', s.status === 'online' ? 'pass' : 'fail', s.status === 'online' ? 'Online' : 'Offline');
        });
        svcHtml += metRow('Summary', d.online === d.total ? 'pass' : 'warn', d.online + ' healthy · ' + d.offline + ' unhealthy');
    }
    setInner('mt-services', svcHtml);

    // Resources
    let resHtml = '';
    if (d.cpu != null) resHtml += metRow('CPU Usage', d.cpu > 80 ? 'fail' : d.cpu > 60 ? 'warn' : 'pass', d.cpu.toFixed(1) + '%');
    if (d.ram)         resHtml += metRow('RAM Usage', d.ram.pct > 90 ? 'fail' : d.ram.pct > 75 ? 'warn' : 'pass', d.ram.used + ' GB / ' + d.ram.total + ' GB  (' + d.ram.pct + '%)');
    if (d.swap)        resHtml += metRow('Swap Usage', d.swap.pct > 80 ? 'fail' : d.swap.pct > 50 ? 'warn' : 'pass', d.swap.used + ' MB / ' + d.swap.total + ' MB  (' + d.swap.pct + '%)');
    if (d.load)        resHtml += metRow('Load Average', 'pass', '1m: ' + d.load[0] + '  5m: ' + d.load[1] + '  15m: ' + d.load[2]);
    resHtml += metRow('System Uptime', 'pass', d.uptime || 'N/A');
    setInner('mt-resources', resHtml);

    // DB integrity
    let dbHtml = metRow('Integrity Check', d.db_integrity ? 'pass' : 'fail', d.db_integrity ? 'ok' : 'Errors detected');
    if (d.db_stats) {
        for (const [t, c] of Object.entries(d.db_stats)) {
            dbHtml += metRow('Table: ' + t, c > 500 ? 'warn' : 'pass', c + ' records');
        }
    }
    setInner('mt-dbintegrity', dbHtml);
}

function metRow(label, status, detail) {
    const cls = { pass: 'status-pass', fail: 'status-fail', warn: 'status-warn' }[status] || '';
    const sym = { pass: '✓ PASS', fail: '✗ FAIL', warn: '⚠ WARN' }[status] || status;
    return '<div class="metrics-row">' +
        '<span class="metrics-row-label">' + esc(label) + '</span>' +
        '<span class="metrics-row-status ' + cls + '">' + sym + '</span>' +
        '<span class="metrics-row-detail">' + esc(detail) + '</span>' +
        '</div>';
}

function setInner(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html || '<div style="padding:.75rem 1rem;font-size:.62rem;color:var(--muted)">No data.</div>';
}

// ═══════════════════════════════════════════════════════════
//   LOGS
// ═══════════════════════════════════════════════════════════
async function fetchLogs() {
    const d = await api('/api/logs?type=' + activeLogType + '&n=300');
    if (!d) return;

    const viewer = document.getElementById('logViewer');
    if (!viewer) return;

    const countEl = document.getElementById('logLineCount');
    if (countEl) countEl.textContent = d.lines.length + ' lines';

    const wasAtBottom = viewer.scrollHeight - viewer.clientHeight <= viewer.scrollTop + 30;

    viewer.innerHTML = d.lines.map(line => {
        const cls = classifyLog(line, activeLogType);
        return '<div class="log-line ' + cls + '">' + esc(line) + '</div>';
    }).join('');

    if (logAutoScroll && wasAtBottom) viewer.scrollTop = viewer.scrollHeight;
}

function classifyLog(line, type) {
    if (type === 'metrics') {
        if (line.startsWith('#')) return 'log-prom-comment';
        if (line.trim()) return 'log-prom-metric';
        return 'log-plain';
    }
    const u = line.toUpperCase();
    if (u.includes('CRITICAL')) return 'log-critical';
    if (u.includes('| ERROR') || u.includes('ERROR   |') || u.includes('] ERROR')) return 'log-error';
    if (u.includes('WARNING') || u.includes('WARN')) return 'log-warning';
    if (u.includes('| INFO')  || u.includes('INFO    |') || u.includes('] INFO')) return 'log-info';
    if (u.includes('DEBUG'))   return 'log-debug';
    return 'log-plain';
}

// ═══════════════════════════════════════════════════════════
//   AUDIT
// ═══════════════════════════════════════════════════════════
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
        list.innerHTML = '<div style="color:var(--muted);font-size:.65rem;padding:2rem;text-align:center">No matching entries.</div>';
        return;
    }

    list.innerHTML = filtered.map(e => {
        const action = e.action || 'RAW';
        const cls    = auditActionClass(action);
        // Try every field name ATS might use for the timestamp
        const raw = e.timestamp || e.created_at || e.time || e.ts || '';
        const ts  = raw ? String(raw).replace('T', ' ').substring(0, 19) : 'no timestamp';
        const meta = e.metadata && Object.keys(e.metadata).length
            ? Object.entries(e.metadata).map(([k, v]) => k + ': ' + JSON.stringify(v)).join(' · ')
            : '';
        return '<div class="audit-entry a-' + cls + '">' +
            '<div class="audit-row-top">' +
                '<span class="audit-action ' + cls + '">' + esc(action) + '</span>' +
                '<div class="audit-target">' + esc(e.target || '—') + '</div>' +
                '<div class="audit-user">' + esc(e.user || 'root') + '</div>' +
            '</div>' +
            '<div class="audit-row-bot">' +
                '<span class="audit-time">' + esc(ts) + '</span>' +
                (meta ? '<span class="audit-sep">·</span><span class="audit-meta">' + esc(meta) + '</span>' : '') +
            '</div>' +
        '</div>';
    }).join('');
}

function auditActionClass(action) {
    const a = action.toUpperCase();
    if (a.includes('DEPLOY') && !a.includes('UNDEPLOY')) return 'deploy';
    if (a.includes('DESTROY') || a.includes('DELETE') || a.includes('UNDEPLOY')) return 'destroy';
    if (a.includes('BACKUP') || a.includes('RESTORE')) return 'backup';
    if (a.includes('UPDATE') || a.includes('RESTART') || a.includes('START') || a.includes('STOP')) return 'update';
    if (a.includes('WEBHOOK')) return 'webhook';
    if (a.includes('CONFIG') || a.includes('DATABASE')) return 'config';
    if (a.includes('SYSTEM') || a.includes('SCHEDULED')) return 'system';
    return 'other';
}

// ═══════════════════════════════════════════════════════════
//   DATABASE VIEWER
// ═══════════════════════════════════════════════════════════
async function fetchDatabase() {
    const d = await api('/api/database?table=' + activeDbTable + '&limit=100');
    if (!d) return;

    const infoEl = document.getElementById('dbTableInfo');
    if (infoEl) infoEl.innerHTML = '<span class="db-badge">' + d.rows.length + ' rows</span> <span style="color:var(--muted)">·</span> ' + esc(d.table);

    const head = document.getElementById('dbTableHead');
    const body = document.getElementById('dbTableBody');
    if (!head || !body) return;

    head.innerHTML = '<tr>' + (d.columns || []).map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';

    body.innerHTML = (d.rows || []).map(row =>
        '<tr>' + (d.columns || []).map(col => {
            const val = row[col];
            const str = val == null ? '' : String(val);
            const cls = getCellClass(col, str);
            const display = str.length > 50 ? str.substring(0, 50) + '…' : str;
            // Make domain/url cells clickable
            if (col === 'domain' && str && !str.startsWith('http')) {
                return '<td class="' + cls + '" title="' + esc(str) + '"><a href="https://' + esc(str) + '" target="_blank" style="color:var(--cyan);text-decoration:none">' + esc(display) + '</a></td>';
            }
            if ((col === 'repo_url' || col === 'url') && str) {
                return '<td class="' + cls + '" title="' + esc(str) + '"><a href="' + esc(str) + '" target="_blank" style="color:var(--purple);text-decoration:none">' + esc(display) + '</a></td>';
            }
            return '<td class="' + cls + '" title="' + esc(str) + '">' + esc(display) + '</td>';
        }).join('') + '</tr>'
    ).join('');
}

function getCellClass(col, val) {
    const c = col.toLowerCase();
    if (c === 'status') return val === 'active' || val === 'success' ? 'td-green' : val === 'failed' || val === 'error' ? 'td-red' : '';
    if (c === 'runtime') return 'td-cyan';
    if (c.includes('error') || c.includes('failed')) return val ? 'td-red' : '';
    if (c.includes('created') || c.includes('timestamp') || c.includes('updated')) return 'td-muted';
    if (c === 'port') return 'td-amber';
    if (c === 'workers') return 'td-purple';
    return '';
}

// ═══════════════════════════════════════════════════════════
//   STATS (per-service)
// ═══════════════════════════════════════════════════════════
async function fetchStats() {
    const d = await api('/api/stats');
    if (!d) return;
    const grid = document.getElementById('statsGrid');
    if (!grid) return;

    if (!d.services || d.services.length === 0) {
        grid.innerHTML = '<div style="color:var(--muted);font-size:.65rem;padding:2rem;text-align:center;grid-column:1/-1">No services found.</div>';
        return;
    }

    grid.innerHTML = d.services.map(s => {
        const rate = s.deploy_rate != null ? s.deploy_rate : 0;
        const rateColor = rate >= 80 ? 'var(--green)' : rate >= 50 ? 'var(--amber)' : 'var(--red)';
        const lastDep = s.last_deploy
            ? s.last_deploy.status + '  ' + (s.last_deploy.duration_seconds || 0).toFixed(1) + 's  ' + (s.last_deploy.timestamp || '').substring(0, 16)
            : '—';
        const lastBk = s.last_backup
            ? (s.last_backup.size_bytes / 1024 / 1024).toFixed(2) + ' MB  ' + (s.last_backup.timestamp || '').substring(0, 16)
            : '—';
        const domainUrl = s.domain ? 'https://' + s.domain : null;

        return '<div class="stats-card ' + s.status + '">' +
            '<div class="stats-card-header">' +
                '<span class="stats-card-name">' + esc(s.name) + '</span>' +
                '<span class="svc-badge ' + s.status + '"><span class="dot"></span>' + (s.status === 'online' ? 'ONLINE' : 'OFFLINE') + '</span>' +
            '</div>' +
            '<div class="stats-card-body">' +
                statsRow('Domain', domainUrl
                    ? '<a href="' + esc(domainUrl) + '" target="_blank" style="color:var(--cyan);text-decoration:none">' + esc(s.domain) + '</a>'
                    : '<span style="color:var(--cyan)">' + esc(s.domain) + '</span>') +
                statsRow('Port', '<span style="color:var(--amber)">:' + s.port + '</span>') +
                statsRow('Runtime', esc(s.runtime)) +
                statsRow('Workers', s.workers) +
                statsRow('Memory Limit', s.memory_mb + ' MB') +
                statsRow('CPU Quota', s.cpu_quota + '%') +
                statsRow('Branch', esc(s.branch)) +
                '<div class="stats-divider"></div>' +
                '<div class="deploy-rate-wrap">' +
                    statsRow('Deploy Success', '<span style="color:' + rateColor + '">' + (s.deploy_rate != null ? s.deploy_rate + '%' : 'N/A') + ' (' + s.deploy_ok + '/' + s.deploy_total + ')</span>') +
                    '<div class="deploy-rate-bar"><div class="deploy-rate-fill" style="width:' + rate + '%;background:' + rateColor + '"></div></div>' +
                '</div>' +
                statsRow('Last Deploy', '<span style="font-size:.57rem">' + esc(lastDep) + '</span>') +
                '<div class="stats-divider"></div>' +
                statsRow('Backups', s.backup_count) +
                statsRow('Last Backup', '<span style="font-size:.57rem">' + esc(lastBk) + '</span>') +
                statsRow('Deployed', '<span style="font-size:.57rem">' + esc((s.created_at || '').substring(0, 16)) + '</span>') +
            '</div>' +
        '</div>';
    }).join('');
}

function statsRow(label, val) {
    return '<div class="stats-row"><span class="stats-row-label">' + label + '</span><span class="stats-row-val">' + val + '</span></div>';
}

// ═══════════════════════════════════════════════════════════
//   POLLING LOOP
// ═══════════════════════════════════════════════════════════
function refreshActive() {
    switch (activeTab) {
        case 'overview':  fetchOverview(); break;
        case 'metrics':   fetchOverview(); break;
        case 'logs':      fetchLogs(); break;
        case 'audit':     fetchAudit(); break;
        case 'database':  fetchDatabase(); break;
        case 'stats':     fetchStats(); break;
    }
}

setInterval(refreshActive, 5000);
refreshActive();

// ── XSS ESCAPE ─────────────────────────────────────────────
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
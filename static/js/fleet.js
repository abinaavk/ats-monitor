'use strict';
// Fleet panel on Settings → Servers: one view of every server's health, version updates, alerts, registry
// backups, and the per-server key rotation and webhook mapping tools. All text is set with textContent.
(() => {
    let api = null;
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const btn = (text, className, handler) => { const node = el('button', 'term-btn ' + (className || ''), text); node.type = 'button'; node.addEventListener('click', handler); return node; };
    const clock = seconds => new Date(seconds * 1000).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
    const ago = seconds => {
        const gap = Math.max(0, Math.round(Date.now() / 1000 - seconds));
        return gap < 90 ? 'just now' : gap < 5400 ? Math.round(gap / 60) + ' min ago' : gap < 172800 ? Math.round(gap / 3600) + ' h ago' : Math.round(gap / 86400) + ' days ago';
    };
    const bytes = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
    const uptime = s => s == null ? '—' : s < 3600 ? Math.round(s / 60) + ' min' : s < 172800 ? Math.round(s / 3600) + ' h' : Math.round(s / 86400) + ' days';
    const heading = (id, title, hint) => { const wrap = el('div', 'fleet-head'); const h = el('h3', '', title); h.id = id; wrap.append(h); if (hint) wrap.append(el('p', 'srv-hint', hint)); return wrap; };
    const say = (text, bad) => api.show(text, bad);

    // ── overview ─────────────────────────────────────────────────────────────
    const STATUS = {up: ['Online', 'ok'], down: ['Unreachable', 'bad'], disabled: ['Disconnected', 'warn'], unknown: ['Waiting for first check', 'muted']};
    const meter = (label, value) => {
        const cell = el('div', 'fleet-meter');
        if (value == null) { cell.append(el('span', 'srv-muted', '—')); return cell; }
        const tone = value >= 90 ? 'bad' : value >= 75 ? 'warn' : 'ok';
        const bar = el('span', 'fleet-bar'); bar.dataset.tone = tone;
        bar.setAttribute('role', 'meter'); bar.setAttribute('aria-label', label); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(value)));
        const fill = el('i'); fill.style.width = Math.min(100, Math.max(2, value)) + '%'; bar.append(fill);
        cell.append(bar, el('b', '', Math.round(value) + '%'));
        return cell;
    };
    let fleet = null, live = null, timer = null;
    const row = (server, live) => {
        const status = live?.status || server.status;
        const metrics = live?.metrics || server.metrics;
        const tr = el('tr'); tr.dataset.id = server.id;
        const name = el('td'); name.dataset.label = 'Server';
        name.append(el('b', '', server.name), el('small', 'srv-muted', server.local ? ' Local' : ' Global'));
        const state = el('td'); state.dataset.label = 'Status';
        const [text, tone] = STATUS[status] || STATUS.unknown;
        const badge = el('span', 'srv-badge', text); badge.dataset.tone = tone; state.append(badge);
        const err = live?.error || server.error;
        if (status === 'down' && err) { const why = el('div', 'fleet-why', err); why.title = err; state.append(why); }
        const cells = [['CPU', metrics?.cpu], ['Memory', metrics?.memory], ['Disk', metrics?.disk]].map(([label, value]) => {
            const td = el('td'); td.dataset.label = label; td.append(meter(label + ' use of ' + server.name, value)); return td;
        });
        const up = el('td', '', uptime(metrics?.uptime)); up.dataset.label = 'Uptime';
        const version = el('td'); version.dataset.label = 'Version';
        if (metrics?.ats) {
            version.append(el('code', 'srv-mono', metrics.ats));
            if (server.outdated) {
                const flag = el('span', 'srv-badge', 'Update available'); flag.dataset.tone = 'warn'; version.append(' ', flag);
                if (server.updatable) version.append(' ', btn('Update', 'srv-mini srv-primary', () => update(server)));
            } else if (!server.local && !server.outdated) version.append(' ', el('span', 'srv-muted', '✔ current'));
        } else version.append(el('span', 'srv-muted', metrics?.legacy ? 'older ATS' : '—'));
        tr.append(name, state, ...cells, up, version);
        return tr;
    };
    const renderOverview = () => {
        const box = $('fleetOverview');
        box.replaceChildren();
        const head = heading('fleetTitle', 'Fleet overview', 'CPU, memory and the fullest disk on every server, checked every minute by the ATS daemon on this server.');
        const refresh = btn('Check now', 'srv-mini', refreshNow); refresh.id = 'fleetRefresh';
        head.append(refresh);
        box.append(head);
        if (!fleet) { box.append(el('p', 'srv-muted', 'Loading…')); return; }
        const note = el('p', 'fleet-note');
        if (live) note.textContent = 'Live check ' + ago(live.at) + '. Saved history continues in the background.';
        else if (fleet.watcher.stale) { note.textContent = 'The background check has not reported lately. Is the ATS daemon running on this server? "Check now" asks every server right away.'; note.dataset.tone = 'warn'; }
        else note.textContent = 'Last background check ' + ago(fleet.watcher.last_run) + '.';
        box.append(note);
        const table = el('table', 'fleet-table');
        const thead = el('thead'); const hr = el('tr');
        for (const label of ['Server', 'Status', 'CPU', 'Memory', 'Disk', 'Uptime', 'ATS version']) hr.append(el('th', '', label));
        thead.append(hr); const tbody = el('tbody');
        for (const server of fleet.servers) tbody.append(row(server, live?.servers?.[server.id]));
        table.append(thead, tbody);
        const scroller = el('div', 'fleet-scroll'); scroller.append(table); box.append(scroller);
        const outdated = fleet.servers.filter(s => s.outdated).length;
        if (outdated) box.append(el('p', 'fleet-note', `${outdated} server${outdated === 1 ? ' is' : 's are'} not on this server's ATS version (${fleet.current.short || 'unknown'}). Update replaces the code with a fast-forward only, checks that it starts, and restarts ATS there; anything unexpected leaves the old version in place.`));
        if (fleet.events.length) {
            const events = el('details', 'srv-section'); events.append(el('summary', '', `Recent events (${fleet.events.length})`));
            const ul = el('ul', 'fleet-events');
            for (const event of fleet.events.slice(0, 12)) { const li = el('li'); li.dataset.kind = event.kind; li.append(el('time', '', clock(event.at)), el('span', '', event.message)); ul.append(li); }
            events.append(ul); box.append(events);
        }
    };
    async function loadFleet() {
        try { fleet = await api.json('/api/fleet'); } catch (error) { fleet = null; $('fleetOverview').replaceChildren(heading('fleetTitle', 'Fleet overview'), el('p', 'fleet-note', error.message)); return; }
        renderOverview();
    }
    async function refreshNow() {
        const button = $('fleetRefresh'); button.disabled = true; say('Asking every server…');
        try {
            const result = await api.change('/api/fleet/refresh', {});
            live = {servers: result.servers, at: Date.now() / 1000};
            if (fleet) { renderOverview(); }
            say('');
        } catch (error) { say(error.message, true); }
        finally { const again = $('fleetRefresh'); if (again) again.disabled = false; }
    }
    async function update(server) {
        if (!confirm(`Update ATS on ${server.name}? It fetches the latest code, checks it starts, then restarts ATS there (a few seconds). Nothing changes if the check fails.`)) return;
        say(`Updating ${server.name}…`);
        try {
            const done = (await api.change(`/api/servers/${server.id}/update`, {targets: 'both'})).result;
            const parts = ['ats', 'companion'].filter(k => done[k]).map(k => done[k].changed ? `${k}: ${done[k].before} → ${done[k].after}` : `${k}: already current`);
            say(`${server.name} updated (${parts.join('; ')})${done.restart ? '. ATS is restarting there.' : '.'}`);
            live = null; setTimeout(loadFleet, done.restart ? 6000 : 500);
        } catch (error) { say(error.message, true); }
    }
    const poll = () => {
        clearTimeout(timer);
        const panel = $('st-servers');
        if (panel && !panel.hidden && document.visibilityState === 'visible' && !live) loadFleet();
        timer = setTimeout(poll, 30000);
    };

    // ── alerts ───────────────────────────────────────────────────────────────
    const MASK = '********';
    async function renderAlerts() {
        const box = $('fleetAlerts'); box.replaceChildren(heading('alertsTitle', 'Alerts', 'Get a message when a server goes down, comes back, or its disk or memory runs out. Tokens stay on this server and are never shown again.'));
        let data;
        try { data = await api.json('/api/alerts'); } catch (error) { box.append(el('p', 'fleet-note', error.message)); return; }
        const config = data.config;
        const form = el('form', 'alert-form'); form.autocomplete = 'off';
        const field = (label, name, value, type = 'text', extra = {}) => {
            const wrap = el('label', '', label); const input = el('input'); input.name = name; input.type = type; input.value = value || ''; input.autocomplete = 'off'; input.spellcheck = false;
            Object.assign(input, extra); wrap.append(input); return wrap;
        };
        const channel = (key, title, fields) => {
            const set = el('fieldset', 'alert-channel'); const legend = el('legend');
            const on = el('input'); on.type = 'checkbox'; on.name = key + '.enabled'; on.checked = !!config.enabled[key];
            legend.append(on, ' ' + title); set.append(legend, ...fields);
            const test = btn('Send test', 'srv-mini', async () => {
                test.disabled = true; say('Sending a test alert…');
                try {
                    const saved = await save(); if (!saved) return;
                    const result = await api.change('/api/alerts/test', {channel: key});
                    const outcome = result.outcome[key];
                    say(outcome?.ok ? `Test alert sent through ${title}. Check your phone.` : `${title} failed: ${outcome?.error || 'no answer'}.`, !outcome?.ok);
                } catch (error) { say(error.message, true); } finally { test.disabled = false; }
            });
            set.append(test); return set;
        };
        form.append(
            channel('ntfy', 'ntfy', [field('Topic address (https://ntfy.sh/your-topic)', 'ntfy.url', config.ntfy.url, 'url'), field('Access token (optional)', 'ntfy.token', config.ntfy.token, 'password')]),
            channel('telegram', 'Telegram', [field('Bot token', 'telegram.token', config.telegram.token, 'password'), field('Chat ID', 'telegram.chat_id', config.telegram.chat_id)]),
            channel('webhook', 'Webhook', [field('HTTPS address (receives JSON: title, message, level)', 'webhook.url', config.webhook.url, 'password')]));
        const limits = el('fieldset', 'alert-channel'); limits.append(el('legend', '', 'When to alert'));
        limits.append(field('Down after this many failed checks (1 per minute)', 'thresholds.failures', config.thresholds.failures, 'number', {min: 1, max: 20}),
            field('Disk full at (%)', 'thresholds.disk', config.thresholds.disk, 'number', {min: 50, max: 99}),
            field('Memory full at (%)', 'thresholds.memory', config.thresholds.memory, 'number', {min: 50, max: 99}));
        form.append(limits);
        const read = () => {
            const value = {ntfy: {}, telegram: {}, webhook: {}, enabled: {}, thresholds: {}};
            for (const input of form.elements) {
                if (!input.name) continue;
                const [group, key] = input.name.split('.');
                if (key === 'enabled') value.enabled[group] = input.checked;
                else if (group === 'thresholds') value.thresholds[key] = Number(input.value);
                else value[group][key] = input.value;
            }
            return value;
        };
        async function save() {
            try { await api.change('/api/alerts', read(), 'PUT'); return true; } catch (error) { say(error.message, true); return false; }
        }
        const submit = el('button', 'term-btn srv-primary', 'Save alert settings'); submit.type = 'submit';
        form.append(submit);
        form.addEventListener('submit', async event => { event.preventDefault(); submit.disabled = true; if (await save()) say('Alert settings saved.'); submit.disabled = false; });
        box.append(form);
        const last = data.last;
        if (last) {
            const bad = Object.entries(last.outcome).filter(([, v]) => !v.ok);
            box.append(el('p', 'fleet-note', `Last alert sent ${ago(last.at)}: ` + Object.entries(last.outcome).map(([k, v]) => `${k} ${v.ok ? '✔' : '✖ ' + v.error}`).join(', ')));
            if (bad.length) box.lastChild.dataset.tone = 'warn';
        }
    }

    // ── registry backup ──────────────────────────────────────────────────────
    async function renderBackup() {
        const box = $('fleetBackup'); box.replaceChildren(heading('backupTitle', 'Registry backup', 'The registry holds every server\'s identity and key. Without a copy, losing it means pairing every server again. ATS makes one daily and keeps seven.'));
        let data;
        try { data = await api.json('/api/registry-backup'); } catch (error) { box.append(el('p', 'fleet-note', error.message)); return; }
        const newest = data.status.newest, last = data.status.last;
        const line = el('p', 'fleet-note');
        if (last?.error) { line.textContent = 'The last automatic backup failed: ' + last.error; line.dataset.tone = 'bad'; }
        else if (newest) line.textContent = `Newest backup ${ago(newest.at)} · ${bytes(newest.size)} · ${newest.encrypted ? 'encrypted' : 'not encrypted'} · ${data.status.count} kept in ${data.directory}`;
        else { line.textContent = 'No backup yet. The ATS daemon makes the first within an hour of starting; or back up now.'; line.dataset.tone = 'warn'; }
        box.append(line);
        const form = el('form', 'backup-form'); form.autocomplete = 'off';
        const pass = el('input'); pass.type = 'password'; pass.autocomplete = 'new-password'; pass.minLength = 8; pass.placeholder = 'Passphrase to encrypt (optional, 8+ characters)'; pass.setAttribute('aria-label', 'Passphrase to encrypt the backup (optional)');
        const go = el('button', 'term-btn srv-primary', 'Back up now'); go.type = 'submit';
        form.append(pass, go);
        form.addEventListener('submit', async event => {
            event.preventDefault(); go.disabled = true; say('Backing up the registry…');
            try { const made = await api.change('/api/registry-backup', pass.value ? {passphrase: pass.value} : {}); pass.value = ''; say(`Backed up (${bytes(made.size)}, ${made.encrypted ? 'encrypted' : 'not encrypted'}).`); await renderBackup(); }
            catch (error) { say(error.message, true); } finally { go.disabled = false; }
        });
        box.append(form);
        box.append(el('p', 'srv-hint', 'Backups stay on this server (mode 0600) and are never sent to the browser. An unencrypted backup contains private keys: keep it out of shared storage. To restore, run this on this server and restart ATS:'));
        const cmd = el('div', 'srv-cmd'); const code = el('code', '', 'sudo python3 app.py server restore --input FILE');
        cmd.append(code, btn('Copy', 'srv-mini', () => api.copy(code.textContent, 'Command'))); box.append(cmd);
    }

    // ── per-server tools, added to each card ───────────────────────────────────
    const section = (title, ...content) => { const details = el('details', 'srv-section'); details.append(el('summary', '', title), ...content); return details; };
    const secretBox = (info, close) => {
        const box = el('div', 'fleet-secret'); box.setAttribute('role', 'alert');
        box.append(el('b', '', 'Add this webhook in GitHub now — the secret is shown only once.'));
        const rows = [['Payload URL', info.payload_url || '(set a webhook host first)'], ['Content type', info.content_type], ['Secret', info.secret], ['Events', info.events]];
        const dl = el('dl', 'fleet-secret-rows');
        for (const [label, value] of rows) {
            const wrap = el('div'); wrap.append(el('dt', '', label));
            const dd = el('dd'); dd.append(el('code', 'srv-mono', value));
            if (label === 'Payload URL' || label === 'Secret') dd.append(btn('Copy', 'srv-mini', () => api.copy(value, label)));
            wrap.append(dd); dl.append(wrap);
        }
        box.append(dl, btn('I have saved it', 'srv-primary', close));
        return box;
    };
    const stepsList = steps => {
        const ul = el('ul', 'srv-test');
        for (const step of steps) {
            const li = el('li', step.ok ? 'ok' : 'bad'); li.append(el('b', '', (step.ok ? '✔ ' : '✖ ') + step.name), el('span', 'srv-muted', step.ms ? ` ${step.ms} ms` : ''));
            if (step.detail) li.append(el('div', 'srv-detail', step.detail)); ul.append(li);
        }
        return ul;
    };
    const decorate = card => {
        if (card.dataset.fleet) return; card.dataset.fleet = '1';
        const id = card.dataset.id, name = card.dataset.name;
        const tools = card.querySelector('.srv-sections') || card;
        // Existing mappings get a Test and a Delete button.
        for (const li of card.querySelectorAll('.srv-maps li[data-repository]')) {
            const repository = li.dataset.repository; li.classList.add('srv-map');
            const result = el('div', 'srv-map-result'); result.hidden = true;
            const test = btn('Test', 'srv-mini', async () => {
                test.disabled = true; result.hidden = false; result.replaceChildren(el('span', 'srv-muted', 'Sending a signed test event…'));
                try { const r = await api.change(`/api/mappings/${repository}/test`, {}); result.replaceChildren(stepsList(r.steps)); }
                catch (error) { result.replaceChildren(el('span', 'bad', '✖ ' + error.message)); } finally { test.disabled = false; }
            });
            const del = btn('Delete', 'srv-mini srv-bad', async () => {
                if (!confirm(`Delete the webhook mapping for ${repository}? GitHub pushes to it will be rejected until you map it again.`)) return;
                try { await api.change(`/api/mappings/${repository}`, {}, 'DELETE'); await api.reload(); say(`Mapping for ${repository} deleted.`); }
                catch (error) { say(error.message, true); }
            });
            li.append(' ', test, ' ', del, result);
        }
        if (card.dataset.paired !== '1' || card.dataset.local === '1') return;
        const secretSlot = el('div');
        const form = el('form', 'server-edit'); form.autocomplete = 'off';
        const input = (label, key, placeholder, pattern) => { const wrap = el('label', '', label); const i = el('input'); i.name = key; i.placeholder = placeholder; i.required = key !== 'branch'; i.autocomplete = 'off'; i.spellcheck = false; if (pattern) i.pattern = pattern; wrap.append(i); return wrap; };
        const submit = el('button', 'term-btn srv-primary', 'Create mapping'); submit.type = 'submit';
        form.append(input('GitHub repository', 'repository', 'owner/name', '[A-Za-z0-9_.\\-]+/[A-Za-z0-9_.\\-]+'), input('Service on this server', 'service', 'service name', '[A-Za-z0-9_\\-]+'), input('Branch', 'branch', 'main (default)'), submit);
        form.addEventListener('submit', async event => {
            event.preventDefault(); submit.disabled = true;
            try {
                const info = await api.change(`/api/servers/${id}/mappings`, {repository: form.elements.repository.value, service: form.elements.service.value, branch: form.elements.branch.value || 'main'});
                form.reset(); secretSlot.replaceChildren(secretBox(info, async () => { secretSlot.replaceChildren(); await api.reload(); }));
                say('Mapping created. Copy the secret into GitHub before leaving this page.');
            } catch (error) { say(error.message, true); } finally { submit.disabled = false; }
        });
        tools.prepend(section('Add a webhook mapping', el('p', 'srv-hint', 'Create the secret here and paste it into the repository\'s GitHub webhook. Pushes then update that service on this server.'), form, secretSlot));
        if (card.dataset.connected === '1') {
            const rotate = btn('Rotate key now…', '', async () => {
                if (!confirm(`Rotate the key for ${name}? A new key is created on that server over the signed channel, checked, and then saved here. The old key keeps working for 10 minutes. Nothing needs to be copied.`)) return;
                rotate.disabled = true; say('Rotating…');
                try { const r = await api.change(`/api/servers/${id}/rotate`, {}); say(`Key rotated and verified. The old key works for ${Math.round(r.grace_seconds / 60)} more minutes.`); await api.reload(); }
                catch (error) { say(error.message, true); } finally { rotate.disabled = false; }
            });
            tools.prepend(section('Rotate key', el('p', 'srv-hint', 'Replace this server\'s key without pasting anything. Do this on a schedule, or when someone who had access leaves.'), rotate));
        }
    };
    const watchCards = () => {
        const list = $('serverList');
        const run = () => list.querySelectorAll('.srv-card').forEach(decorate);
        new MutationObserver(run).observe(list, {childList: true});
        run();
    };

    const start = () => {
        api = window.atsServers; if (!api) return;
        renderOverview(); renderAlerts(); renderBackup(); watchCards();
        document.getElementById('refreshServers')?.addEventListener('click', () => { live = null; loadFleet(); renderAlerts(); renderBackup(); });
        document.getElementById('st-nav-servers')?.addEventListener('click', () => { live = null; loadFleet(); });
        poll();
    };
    if (window.atsServers) start(); else document.addEventListener('ats-servers-ready', start, {once: true});
})();

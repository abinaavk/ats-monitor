'use strict';
// One immutable target per page lifetime. Switching reloads the document, which
// destroys old views, promises, dialogs, sockets, polling and subscriptions.
(() => {
    const originalFetch = window.fetch.bind(window);
    const controller = new AbortController();
    const selectedKey = 'ats.activeServer';
    let switching = false;
    // The sticky "Target server" bar is taller on some screens; everything that sticks or scrolls below it follows its real height.
    const bar = document.querySelector('.server-control');
    if (bar && window.ResizeObserver) new ResizeObserver(() => document.documentElement.style.setProperty('--srv-bar-h', Math.ceil(bar.getBoundingClientRect().height) + 'px')).observe(bar);
    const selector = document.getElementById('activeServer');
    const status = document.getElementById('activeServerStatus');
    const message = document.getElementById('serversMessage');
    const hostRoutes = path => ['/api/overview','/api/logs','/api/database','/api/stats','/api/audit'].includes(path) || path.startsWith('/api/manage/') || path.startsWith('/api/docker/');
    const show = (text, bad=false) => { message.textContent=text; message.classList.toggle('error',bad); };
    const json = async (path, options={}) => {
        const response = await originalFetch(path, {credentials:'same-origin',...options});
        if (response.status===401) {location.assign('/login');throw Error('Sign in again');}
        const data=await response.json();
        if(!response.ok) throw Error(data.error||'Server unavailable');
        return data;
    };
    // A pairing file holds the Global's ID, name, address and passkey. Pasting it fills the form
    // and the textarea is emptied at once, so the key is never left sitting in the page.
    const parsePairing = text => {
        try {
            const value = JSON.parse(text);
            if (value && typeof value === 'object' && ['id','domain','secret'].every(key => typeof value[key] === 'string')) return value;
        } catch (error) { /* not a pairing file yet */ }
        return null;
    };
    const watchPaste = (area, apply) => area.addEventListener('input', () => {
        const value = parsePairing(area.value);
        if (!value) return;
        apply(value);
        area.value = '';
        show('Pairing details filled in. Review them, then submit.');
    });
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const clock = at => new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const activeId = () => { try { return localStorage.getItem(selectedKey); } catch (error) { return null; } };
    const BADGES = {local:['Primary','ok'],checking:['Checking…','muted'],online:['Online','ok'],attention:['Needs attention','warn'],
        offline:['Unreachable','bad'],disconnected:['Disconnected','warn'],revoked:['Access revoked','bad'],pending:['Revocation unconfirmed','bad']};
    const results = new Map();
    const stateOf = server => server.local ? 'local' : server.revocation_pending ? 'pending' : !server.paired ? 'revoked'
        : !server.connected ? 'disconnected' : (results.get(server.id)?.state || 'checking');
    const PROBLEMS = {
        pending: 'This Global never confirmed the revocation, so its old key may still work. Update ID and passkey with a fresh pairing file from that Global.',
        revoked: 'Access was revoked and no key is saved. Pair this server again with a fresh pairing file.',
        disconnected: 'You disconnected this server. Nothing is sent to it until you reconnect.',
        attention: 'Reachable, but its Monitor adapter is not configured. On that Global run: sudo python3 app.py server setup --apply'
    };
    const summarize = servers => {
        const remote = servers.filter(server => !server.local);
        const states = remote.map(stateOf);
        const online = states.filter(state => state === 'online').length;
        const trouble = states.filter(state => !['online', 'checking'].includes(state)).length;
        const parts = ['1 Local', `${remote.length} Global`];
        if (remote.length) parts.push(`${online} online`);
        if (trouble) parts.push(`${trouble} need${trouble === 1 ? 's' : ''} attention`);
        document.getElementById('serversSummary').textContent = parts.join(' · ');
        const glance = document.getElementById('glanceServers');
        if (glance) glance.textContent = remote.length ? `${online} of ${remote.length} Global online` : 'Local only';
    };
    const copy = async (text, label) => {
        try { await navigator.clipboard.writeText(text); show(`${label} copied.`); return true; }
        catch (error) { show(`Copy ${label.toLowerCase()} manually: ${text}`); return false; }
    };
    const focusPairing = prefill => {
        const form = document.getElementById('pairServer');
        if (prefill) {
            form.elements.serverName.value = prefill.name || '';
            form.elements.serverDomain.value = prefill.domain || '';
            form.elements.serverId.value = prefill.id || '';
        }
        document.getElementById('addServer').scrollIntoView({behavior:'smooth', block:'start'});
        document.getElementById('pairPaste').focus({preventScroll:true});
    };
    const fact = (label, ...content) => {
        const wrap = el('div'); wrap.append(el('dt', '', label)); const value = el('dd'); value.append(...content); wrap.append(value);
        return [wrap, value];
    };
    const button = (text, className, handler) => {
        const node = el('button', 'term-btn ' + (className || ''), text); node.type = 'button';
        node.addEventListener('click', handler); return node;
    };
    const render = data => {
        const list = document.getElementById('serverList');
        list.replaceChildren();
        for (const server of data.servers) {
            const card = el('article', 'srv-card st-device');
            Object.assign(card.dataset, {id: server.id, local: server.local ? '1' : '0', paired: server.paired ? '1' : '0', connected: server.connected ? '1' : '0', name: server.name});
            const head = el('header', 'srv-head');
            const dot = el('span', 'srv-dot'); dot.setAttribute('aria-hidden', 'true');
            const titles = el('div', 'srv-title');
            titles.append(el('h3', '', server.name), el('span', 'srv-role', server.local ? 'Local · this server' : 'Global'));
            const chip = el('span', 'srv-chip', 'Active'); chip.hidden = server.id !== (activeId() || data.primary_id);
            const badge = el('span', 'srv-badge'); badge.setAttribute('role', 'status');
            head.append(dot, titles, chip, badge);
            const problem = el('p', 'srv-problem'); problem.hidden = true;
            const facts = el('dl', 'srv-facts');
            // Same five fields in the same order on every card; a field that does not apply says so instead of vanishing.
            const addr = el('span', 'srv-mono srv-addr', server.local ? (data.webhook || 'not set') : server.domain);
            addr.title = server.local ? (data.webhook ? 'https://' + data.webhook : 'No webhook host is configured') : server.domain;
            const [addressRow] = fact(server.local ? 'Webhook receiver' : 'Address', addr);
            const idCode = el('code', 'srv-mono srv-id', server.id.slice(0, 8) + '…');
            idCode.title = server.id;
            const idCopy = button('Copy', 'srv-mini srv-copy', async () => {
                if (!await copy(server.id, 'Server ID')) return;
                idCopy.textContent = 'Copied';
                clearTimeout(idCopy._reset);
                idCopy._reset = setTimeout(() => { idCopy.textContent = 'Copy'; }, 1500);
            });
            idCopy.setAttribute('aria-label', 'Copy the full server ID');
            const [idRow, idValue] = fact('Server ID', idCode, idCopy);
            idValue.classList.add('srv-idrow');
            const [adapterRow, adapterValue] = fact('Management', server.local ? 'Local · runs here' : '—');
            const [lastRow, lastValue] = fact('Last check', server.local ? 'N/A · local' : '—');
            const mapped = server.mappings || [];
            const [mapRow, mapValue] = fact('GitHub webhooks');
            if (mapped.length) {
                const ul = el('ul', 'srv-maps');
                for (const item of mapped) { const li = el('li', 'srv-mono', `${item.repository} → ${item.service} @ ${item.branch}`); li.dataset.repository = item.repository; ul.append(li); }
                mapValue.append(ul);
            } else mapValue.append(el('span', 'srv-muted', server.local ? 'None mapped. Map a service: server map --from-service NAME' : 'None mapped. On this server: server map --generate-secret'));
            for (const row of [addressRow, idRow, mapRow]) row.classList.add('srv-span');
            facts.append(addressRow, idRow, adapterRow, lastRow, mapRow);
            const apply = (state, detail, ms) => {
                const [label, tone] = BADGES[state];
                badge.textContent = label; badge.dataset.tone = tone; card.dataset.state = state;
                const text = detail || PROBLEMS[state] || '';
                problem.textContent = text; problem.hidden = !text; problem.dataset.tone = tone;
                if (state === 'online' || state === 'attention') adapterValue.textContent = state === 'online' ? 'Adapter ready' : 'Adapter missing';
                else if (state === 'offline') adapterValue.textContent = 'Unknown';
                if (ms !== undefined) lastValue.textContent = `${clock(Date.now())} · ${ms} ms`;
                summarize(data.servers);
            };
            const actions = el('div', 'srv-actions');
            const testBox = el('ul', 'srv-test'); testBox.hidden = true; testBox.setAttribute('role', 'status');
            const state = stateOf(server);
            if (server.local || (server.paired && server.connected)) {
                if (server.id === (activeId() || data.primary_id)) {
                    const current = button('Managing now', '', () => {}); current.disabled = true;
                    actions.append(current);
                } else {
                    actions.append(button('Manage this server', 'srv-primary', () => {
                        try { localStorage.setItem(selectedKey, server.id); } catch (error) { /* selection is a convenience */ }
                        location.reload();
                    }));
                }
            }
            if (server.local || (server.paired && server.connected)) {
                const test = button('Test connection', '', async () => {
                    test.disabled = true; testBox.hidden = false; testBox.replaceChildren(el('li', 'srv-muted', 'Testing…'));
                    try {
                        const result = await json(`/api/servers/${server.id}/test`);
                        testBox.replaceChildren(...result.steps.map(step => {
                            const li = el('li', step.ok ? 'ok' : 'bad');
                            li.append(el('b', '', (step.ok ? '✔ ' : '✖ ') + step.name), el('span', 'srv-muted', step.ms ? ` ${step.ms} ms` : ''));
                            if (step.detail) li.append(el('div', 'srv-detail', step.detail));
                            return li;
                        }));
                    } catch (error) { testBox.replaceChildren(el('li', 'bad', '✖ ' + error.message)); }
                    finally { test.disabled = false; }
                });
                actions.append(test);
            }
            if (!server.local && server.paired && server.connected) actions.append(button('Disconnect', '', () => connectionAction(server, 'disconnect')));
            if (!server.local && server.paired && !server.connected && !server.revocation_pending)
                actions.append(button('Reconnect', 'srv-primary', () => connectionAction(server, 'reconnect')));
            if (!server.local && (!server.paired || server.revocation_pending))
                actions.append(button('Pair again', 'srv-primary', () => focusPairing(server)));
            const foot = el('div', 'srv-foot');
            card.append(head, problem, facts, foot);
            foot.append(testBox);
            const more = el('div', 'srv-sections');

            if (!server.local && server.paired) {
                const details = el('details', 'srv-section');
                details.append(el('summary', '', 'Edit name and address'));
                const form = el('form', 'server-edit');
                const label = el('label', '', 'Server name');
                const name = el('input'); name.value = server.name; name.required = true; name.maxLength = 64; label.append(name);
                const endpoint = el('label', '', 'HTTPS API origin');
                const domain = el('input'); domain.value = server.domain; domain.required = true; domain.type = 'url'; endpoint.append(domain);
                const save = el('button', 'term-btn srv-primary', 'Save and verify'); save.type = 'submit';
                form.append(label, endpoint, save); details.append(form); more.append(details);
                form.addEventListener('submit', async event => {
                    event.preventDefault(); save.disabled = true; show('Checking the address before saving…');
                    try {
                        await change(`/api/servers/${server.id}`, {name:name.value, domain:domain.value}, 'PATCH');
                        await load(); show('Server settings saved and verified.');
                        if (window.atsTarget?.id === server.id) location.reload();
                    } catch (error) { show(error.message, true); } finally { save.disabled = false; }
                });
            }
            if (!server.local) {
                const details = el('details', 'srv-section');
                details.append(el('summary', '', 'Update ID and passkey'));
                details.append(el('p', 'srv-hint', 'Paste the current pairing file from this Global (files/pairing.json). The new credentials are verified before anything is saved. Connection state and webhook mappings are preserved.'));
                const form = el('form', 'server-edit cred-form'); form.autocomplete = 'off';
                const fields = {};
                const paste = el('label', 'paste', 'Pairing file contents (optional, fills the fields)');
                const area = el('textarea'); area.rows = 3; area.spellcheck = false; area.autocomplete = 'off'; paste.append(area); form.append(paste);
                for (const [key, text, value, type, pattern] of [
                    ['name', 'Server name', server.name, 'text', ''],
                    ['domain', 'HTTPS API origin', server.domain, 'url', ''],
                    ['id', 'Global server ID', server.id, 'text', '[0-9a-f]{32}'],
                    ['secret', 'New private passkey', '', 'password', '[0-9a-f]{64}']]) {
                    const field = el('label', '', text);
                    const input = el('input'); input.type = type; input.value = value; input.required = true; input.autocomplete = 'off';
                    if (pattern) input.pattern = pattern;
                    if (key === 'name') input.maxLength = 64;
                    fields[key] = input; field.append(input); form.append(field);
                }
                watchPaste(area, value => {
                    if (typeof value.name === 'string' && value.name) fields.name.value = value.name;
                    fields.domain.value = value.domain; fields.id.value = value.id; fields.secret.value = value.secret;
                });
                const save = el('button', 'term-btn srv-primary', 'Verify and replace credentials'); save.type = 'submit'; form.append(save);
                form.addEventListener('submit', async event => {
                    event.preventDefault();
                    if (fields.id.value !== server.id && !confirm(`Replace the identity of ${server.name} and move its webhook mappings to the verified new ID? Old jobs will retain the old ID.`)) return;
                    save.disabled = true; show('Verifying new credentials…');
                    const body = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
                    fields.secret.value = '';
                    try {
                        await change(`/api/servers/${server.id}/credentials`, body);
                        if (window.atsTarget?.id === server.id) { try { localStorage.setItem(selectedKey, body.id); } catch (error) { /* convenience only */ } location.reload(); return; }
                        await load(); show('Credentials verified and updated. Connection state preserved.');
                    } catch (error) { show(error.message, true); } finally { body.secret = ''; fields.secret.value = ''; save.disabled = false; }
                });
                details.append(form); more.append(details);
            }
            if (!server.local && server.paired) {
                const details = el('details', 'srv-section srv-danger');
                details.append(el('summary', '', 'Danger zone'));
                details.append(el('p', 'srv-hint', 'Revoking invalidates this Global\'s key on the Global itself, then removes the saved copy here. You will need a fresh pairing file to use it again.'));
                details.append(button('Revoke access…', 'srv-bad', () => connectionAction(server, 'revoke')));
                more.append(details);
            }
            if (server.local) more.append(el('span', 'srv-muted srv-note', 'Local identity is set in the ATS CLI (server configuration).'));
            foot.append(more, actions);
            list.append(card);
            apply(state, '');
            if (!server.local && server.paired && server.connected) {
                const started = performance.now();
                json(`/api/servers/${server.id}/health`).then(result => {
                    const ms = Math.round(performance.now() - started);
                    results.set(server.id, {state: result.management_ready === false ? 'attention' : 'online'});
                    apply(results.get(server.id).state, '', ms);
                }).catch(error => {
                    results.set(server.id, {state: 'offline'});
                    apply('offline', error.message && error.message !== 'Server unavailable' ? error.message : 'Cannot reach this Global. Check its daemon and HTTPS tunnel.', Math.round(performance.now() - started));
                });
            }
        }
        if (!data.servers.some(item => !item.local)) {
            const empty = el('div', 'srv-empty');
            empty.append(el('h3', '', 'No Global servers yet'), el('p', '', 'Add one to deploy and manage services on another machine from this dashboard.'),
                button('Add your first server', 'srv-primary', () => focusPairing()));
            list.append(empty);
        }
        summarize(data.servers);
    };
    async function connectionAction(server, action) {
        if (action === 'revoke' && !confirm(`Revoke ${server.name}? New credentials must be generated on that Global server to pair again.`)) return;
        show(action === 'disconnect' ? 'Disconnecting…' : action === 'revoke' ? 'Revoking access on Global…' : 'Verifying Global connectivity…');
        try {
            await change(`/api/servers/${server.id}/${action}`, {}); await load(); show('Connection updated.');
            if (window.atsTarget?.id === server.id) location.reload();
        } catch (error) { await load().catch(() => {}); show(error.message, true); }
    }
    async function load() {
        const data=await json('/api/servers');render(data);
        if(window.atsTarget) {
            const id=window.atsTarget.id;
            selector.replaceChildren(...data.servers.map(server=>new Option(`${server.name} · ${server.local?'Local':'Global'}`,server.id)));
            if(!data.servers.some(server=>server.id===id))selector.add(new Option('Selected server unavailable',id));
            selector.value=id;
        }
        return data;
    }
    async function change(path,body,method='POST') {
        const settings=await json('/api/settings');
        return json(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':settings.csrf_token},body:JSON.stringify(body)});
    }
    window.atsServerReady=(async()=>{
        try {
            const data=await load();
            let id=localStorage.getItem(selectedKey);
            if(!id){id=data.primary_id;localStorage.setItem(selectedKey,id);}
            for(const server of data.servers){
                const option=new Option(`${server.name} · ${server.local?'Local':'Global'}`,server.id);selector.add(option);
            }
            let selected=data.servers.find(s=>s.id===id);
            if(!selected){selector.add(new Option('Selected server unavailable',id));selected={id,local:0,connected:0};}
            selector.value=id;selector.disabled=false;window.atsTarget=Object.freeze(selected);
            status.textContent=selected.connected?'Checking':'Disconnected';
            json(`/api/servers/${id}/health`).then(result=>{status.textContent=result.management_ready===false?'API online · Adapter missing':'Online';}).catch(()=>{status.textContent='Offline';});
            // Preserve navigation across target changes, never service panels or job dialogs.
            const tab=sessionStorage.getItem('ats.activeTab');
            if(tab)document.querySelector(`.nav-link[data-tab="${CSS.escape(tab)}"]`)?.click();
            const section=sessionStorage.getItem('ats.settingsSection');
            if(tab==='settings'&&section)document.querySelector(`[data-settings="${CSS.escape(section)}"]`)?.click();
            return selected;
        }catch(error){status.textContent='Unavailable';show(error.message,true);throw error;}
    })();
    // Avoid an unhandled rejection while every target request remains fail-closed.
    window.atsServerReady.catch(()=>{});
    window.fetch=async function(input,options={}) {
        const url=new URL(input instanceof Request?input.url:input,location.href);
        if(url.origin!==location.origin||!hostRoutes(url.pathname))return originalFetch(input,options);
        const server=await window.atsServerReady;
        if(switching)throw new DOMException('Server changed','AbortError');
        const request=new Request(input,options);
        const headers=new Headers(request.headers);headers.set('X-ATS-Target',server.id);
        const combined=new AbortController();
        const abort=()=>combined.abort();
        for(const signal of [request.signal,controller.signal]) {
            if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
        }
        let response;
        try {response=await originalFetch(request,{headers,signal:combined.signal});}
        finally {request.signal.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',abort);}
        if(switching)throw new DOMException('Server changed','AbortError');
        if(response.status===503)status.textContent='Offline';
        else if(response.ok)status.textContent='Online';
        return response;
    };
    selector.addEventListener('change',()=>{
        switching=true;controller.abort();
        document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close());
        document.querySelectorAll('.tabcontent').forEach(section=>{section.inert=true;section.style.visibility='hidden';});
        status.textContent='Connecting';localStorage.setItem(selectedKey,selector.value);
        location.reload();
    });
    document.addEventListener('click',event=>{const section=event.target.closest('[data-settings]');if(section)sessionStorage.setItem('ats.settingsSection',section.dataset.settings);const tab=event.target.closest('[data-tab]');if(tab?.classList.contains('nav-link'))sessionStorage.setItem('ats.activeTab',tab.dataset.tab);});
    watchPaste(document.getElementById('pairPaste'),value=>{
        const form=document.getElementById('pairServer');
        if(typeof value.name==='string'&&value.name)form.elements.serverName.value=value.name;
        form.elements.serverDomain.value=value.domain;form.elements.serverId.value=value.id;
        document.getElementById('serverSecret').value=value.secret;
    });
    document.getElementById('pairServer').addEventListener('submit',async event=>{
        event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');button.disabled=true;
        const secret=document.getElementById('serverSecret');
        try {await change('/api/servers',{id:form.elements.serverId.value,name:form.elements.serverName.value,domain:form.elements.serverDomain.value,secret:secret.value});form.reset();await load();show('Paired and verified. Reload to refresh the selector.');}
        catch(error){show(error.message,true);}finally{secret.value='';button.disabled=false;}
    });
    document.getElementById('refreshServers').addEventListener('click',()=>{results.clear();show('Refreshing…');load().then(()=>show('')).catch(error=>show(error.message,true));});
    document.getElementById('addServerJump').addEventListener('click',()=>focusPairing());
    document.addEventListener('click',event=>{const target=event.target.closest('[data-copy]');if(target)copy(target.dataset.copy,'Command');});
    document.getElementById('pairCode').addEventListener('submit',async event=>{
        event.preventDefault();const form=event.currentTarget;const submit=form.querySelector('button[type="submit"]');submit.disabled=true;show('Pairing with the one-time code…');
        try {await change('/api/servers/pair-code',{domain:form.elements.codeDomain.value,code:form.elements.codeValue.value,name:form.elements.codeName.value});form.reset();await load();show('Paired and verified. No key was copied by hand.');}
        catch(error){show(error.message,true);}finally{form.elements.codeValue.value='';submit.disabled=false;}
    });
    // The fleet panel (fleet.js) reuses these so it shares one session, CSRF and message line.
    window.atsServers={json,change,show,el,button,copy,reload:load};
    document.dispatchEvent(new Event('ats-servers-ready'));
})();

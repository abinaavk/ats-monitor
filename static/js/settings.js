'use strict';
(() => {
const $ = id => document.getElementById(id);
let settings = null, devices = [], loadedAt = 0, pending = null, busy = false, returnFocus = null;
const when = value => value ? new Date(value * 1000).toLocaleString() : 'Unavailable';
const trusted = device => device.trusted_until && device.trusted_until > Date.now()/1000 && !device.revoked_at;
let session = null;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function sessionText() {
    if (!session) return 'Session details are unavailable right now.';
    if (session.trusted) return `Trusted device: this browser stays signed in until ${new Date(session.expires_at*1000).toLocaleString()}.`;
    const minutes = Math.max(0, Math.round((session.expires_at*1000 - Date.now())/60000));
    return `Standard session: you will be signed out in ${plural(minutes, 'minute')}. Active use does not extend it.`;
}
function showSession() {
    $('glanceSecurity').textContent = !session ? 'Unavailable' : session.trusted ? 'Trusted device' : `Standard · ${Math.max(0, Math.round((session.expires_at*1000 - Date.now())/60000))} min left`;
    $('stSessionInfo').textContent = sessionText();
    $('stSecSession').textContent = sessionText();
    $('stPolicyTrusted').classList.toggle('is-current', !!session?.trusted);
    $('stPolicyStandard').classList.toggle('is-current', !!session && !session.trusted);
}
async function refreshSession() {
    try { const response = await fetch('/api/auth/status',{credentials:'same-origin'}); if (response.status===401) { window.location.assign('/login'); return; }
          session = await response.json(); } catch (_) { /* keep the last known state */ }
    showSession();
}
function message(text, error=false) { $('stMessage').textContent=text; $('stMessage').classList.toggle('error',error); }
async function api(path, options={}) {
    const response = await fetch(path,{credentials:'same-origin',...options});
    const result = await response.json().catch(()=>({error:'Invalid server response'}));
    if (response.status===401) { window.location.assign('/login'); throw new Error('Sign in again to continue.'); }
    if (!response.ok) throw new Error(result.error || 'Unable to save. Try again.');
    return result;
}
function section(name) {
    document.querySelectorAll('[data-settings]').forEach(button=>{
        const on=button.dataset.settings===name;
        button.classList.toggle('active',on);
        if(on) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
        $('st-'+button.dataset.settings).hidden=!on;
    });
    message('');
    document.querySelector('[data-settings="'+name+'"]')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
    try { history.replaceState(null,'','#settings/'+name); } catch(_) { /* a convenience only */ }
    if(name==='devices' || name==='security') loadDevices();
    if(name==='general') loadHost();
    if(name==='account' || name==='security') refreshSession();
}
let hostLoadedAt = 0;
window.fetchSettings = async function(force=false) {
    // Opening Settings shows General first: load its host overview then, not at page load.
    if(!$('st-general').hidden && (force || Date.now()-hostLoadedAt>60000)) loadHost();
    refreshSession();
    if(!devices.length && !$('stDevices').getAttribute('aria-busy')) loadDevices();
    if(!force && settings && Date.now()-loadedAt<30000) return;
    try {
        settings=await api('/api/settings'); loadedAt=Date.now();
        if(document.activeElement!==$('stDisplayName')) $('stDisplayName').value=settings.profile.display_name;
        $('stAvatar').textContent=(settings.profile.display_name||'A').trim().charAt(0).toUpperCase()||'A';
    } catch(error) { message(error.message,true); }
};
async function loadDevices() {
    $('stDevices').setAttribute('aria-busy','true');
    $('stRefreshDevices').disabled=true;
    if(!devices.length) $('stDevices').textContent='Loading registered devices…';
    try {
        const result=await api('/api/settings/devices'); devices=result.devices;
        const live = devices.filter(device=>!device.revoked_at);
        const trustedCount = live.filter(trusted).length, activeCount = live.filter(device=>device.active_sessions).length;
        $('stDeviceSummary').textContent = `${plural(live.length,'device')} · ${trustedCount} trusted · ${activeCount} signed in`;
        $('glanceDevices').textContent = `${plural(live.length,'device')} · ${trustedCount} trusted`;
        $('stSecStats').innerHTML = [['Devices',live.length],['Trusted',trustedCount],['Signed in',activeCount],['Other devices',live.filter(device=>!device.current).length]]
            .map(([label,value])=>`<div class="st-stat"><b>${value}</b><span>${label}</span></div>`).join('');
        $('stDevices').innerHTML=devices.length ? devices.map(device=>`<article class="st-device ${device.current?'is-current':''}"><header class="st-dhead"><h3>${esc(device.name)}</h3><div class="st-badges">${device.current?'<span class="st-badge current">This device</span>':''}<span class="st-badge ${trusted(device)?'trusted':''}">${device.revoked_at?'Revoked':trusted(device)?'Trusted':'Standard security'}</span><span class="st-badge">${device.active_sessions?'Signed in':'Signed out'}</span></div></header><dl class="st-facts"><div><dt>Device</dt><dd>${esc(device.device_type)} · ${esc(device.browser)}</dd></div><div><dt>Network address</dt><dd>${esc(device.ip)}</dd></div><div><dt>Last active</dt><dd>${esc(when(device.last_active))}</dd></div></dl><div class="st-actions"><button class="term-btn" data-device="${esc(device.id)}" data-device-action="details">Details</button>${device.revoked_at?'':`<button class="term-btn" data-device="${esc(device.id)}" data-device-action="${trusted(device)?'untrust':'trust'}">${trusted(device)?'Remove trust':'Trust device'}</button><button class="term-btn" data-device="${esc(device.id)}" data-device-action="logout">Log out device</button><button class="term-btn st-sensitive" data-device="${esc(device.id)}" data-device-action="revoke">Revoke access</button>`}</div></article>`).join('') : '<p>No registered devices.</p>';
        $('stAudit').innerHTML=result.audit.map(entry=>`<li>${esc(entry.action.replaceAll('_',' '))}${entry.detail?` <span class="st-audit-detail">${esc(entry.detail)}</span>`:''}<time>${esc(when(entry.at))} · ${entry.device_name?esc(entry.device_name)+' · ':''}${esc(entry.ip)}</time></li>`).join('') || '<li>No security activity yet.</li>';
    } catch(error) {
        if(!devices.length) $('stDevices').textContent='Devices could not be loaded. Use Refresh to try again.';
        message(error.message,true);
    } finally { $('stDevices').setAttribute('aria-busy','false'); $('stRefreshDevices').disabled=false; }
}
function details(device) {
    const opener=document.activeElement;
    $('stDetails').addEventListener('close',()=>opener?.focus(),{once:true});
    const values={ 'Device name':device.name,'Hostname':'Unavailable from remote browser','Operating system':device.os,'Browser':device.browser,'Type':device.device_type,'Observed IP':device.ip,'MAC address':'Unavailable from remote browser','Location':device.location||'Unavailable','First login':when(device.first_login),'Last active':when(device.last_active),'Authentication':device.active_sessions?'Authenticated':'Signed out','Active sessions':device.active_sessions,'Security mode':device.revoked_at?'Revoked':trusted(device)?'Trusted':'Standard','Trust expires':device.trusted_until?when(device.trusted_until):'Not trusted','Current device':device.current?'Yes':'No'};
    $('stDetailsBody').innerHTML=Object.entries(values).map(([key,value])=>`<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('');
    $('stDetails').showModal();
}
function confirmChange(title,text,path,body={}) {
    returnFocus=document.activeElement; pending={path,body};
    $('stConfirmTitle').textContent=title; $('stConfirmText').textContent=text;
    $('stConfirmError').textContent=''; $('stPassword').value=''; $('stConfirmSubmit').disabled=false;
    $('stConfirm').showModal(); $('stPassword').focus();
}
function closeConfirm() { if(busy) return; $('stPassword').value=''; pending=null; $('stConfirm').close(); }
$('stConfirm').addEventListener('close',()=>{ $('stPassword').value=''; returnFocus?.focus(); });
$('stConfirm').addEventListener('cancel',event=>{ if(busy)event.preventDefault();else pending=null; });
$('stConfirmForm').addEventListener('submit',async event=>{
    event.preventDefault(); if(busy || !pending)return;
    busy=true; $('stConfirmSubmit').disabled=true;
    try {
        // Reload the CSRF token in case trusted authentication renewed this session.
        settings=await api('/api/settings');
        const result=await api(pending.path,{method:pending.path==='/api/settings'?'PATCH':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':settings.csrf_token},body:JSON.stringify({...pending.body,password:$('stPassword').value})});
        $('stPassword').value=''; pending=null; $('stConfirm').close();
        if(result.reauthenticate) { window.location.assign('/login');return; }
        message('Changes saved.'); await window.fetchSettings(true); await loadDevices();
    } catch(error) { $('stConfirmError').textContent=error.message; }
    finally {busy=false; $('stConfirmSubmit').disabled=false;}
});
$('stCancel').addEventListener('click',closeConfirm);
$('stDetailsClose').addEventListener('click',()=>$('stDetails').close());
document.querySelectorAll('[data-settings]').forEach(button=>button.addEventListener('click',()=>section(button.dataset.settings)));
$('stOpenDevices').addEventListener('click',()=>section('devices'));
$('stRefreshDevices').addEventListener('click',loadDevices);
$('stLogoutOthers').addEventListener('click',()=>confirmChange('Log out all other devices','All other devices will need to enter the password again. Their trusted access will be removed. This device stays signed in.','/api/settings/logout-others'));
$('stProfile').addEventListener('submit',event=>{event.preventDefault();confirmChange('Save administrator profile','This display name is shared by all authenticated devices.','/api/settings',{display_name:$('stDisplayName').value});});
$('stDevices').addEventListener('click',event=>{
    const button=event.target.closest('[data-device-action]');if(!button)return;
    const device=devices.find(item=>item.id===button.dataset.device);if(!device)return;
    const action=button.dataset.deviceAction;if(action==='details'){details(device);return;}
    const labels={trust:['Trust this device','Allow this registered browser to stay authenticated for 30 days. Only trust a browser you own and control.'],untrust:['Remove device trust','Remove persistent authentication and end active sessions. This device will use the standard 10-minute mode after password login.'],logout:['Log out device','End active sessions and remove persistent authentication. This browser can sign in again with the password.'],revoke:['Revoke device access','Invalidate this registration, all active sessions and trusted credentials. Password login will be required to register again.']};
    confirmChange(labels[action][0],device.name+': '+labels[action][1]+(device.current?' You will be signed out if access is removed.':''),'/api/settings/devices/'+encodeURIComponent(device.id)+'/'+action);
});
$('stHostSettings').addEventListener('click',async()=>{
    try {
        // Reuse the existing host Settings dialog and backend.
        await window.fetchManage(true);
        if($('mgSettingsBtn').disabled) throw new Error('Host settings are unavailable. Check the ATS connection in Manage.');
        $('mgSettingsBtn').click();
    } catch(error) {message(error.message,true);}
});
const field = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const code = value => (value === undefined || value === null || value === '') ? '<span class="st-muted">—</span>' : `<code>${esc(value)}</code>`;
async function loadHost() {
    hostLoadedAt = Date.now();
    const box = $('stHostOverview'); box.setAttribute('aria-busy','true');
    const selected = document.querySelector('#activeServer option:checked')?.textContent;
    $('stHostTarget').innerHTML = selected ? `Showing settings for <strong>${esc(selected)}</strong>` : '';
    try {
        const reply = await api('/api/manage/settings'); const d = reply.data || reply;
        const defaults = d.defaults || {}, hook = d.webhook || {}, drive = d.gdrive || {};
        $('glanceHost').textContent = d.main_domain || 'Not set';
        const card = (title, rows) => `<article class="st-card"><h3>${esc(title)}</h3><dl class="st-facts">${rows.join('')}</dl></article>`;
        box.innerHTML = [
            card('Deployment', [field('Main domain', code(d.main_domain)), field('Saved domains', (d.domains||[]).map(code).join(' ') || '—'),
                field('Storage root', code(d.storage_root)), field('Service user', code(d.service_user)), field('ATS home', code(d.ats_home))]),
            card('Cloudflare tunnel', [field('Config file', code(d.cloudflare_config)), field('Tunnel service', code(d.cloudflared_service))]),
            card('GitHub webhooks', [field('Receiver', code(hook.domain ? `${hook.domain}:${hook.port}` : '—'))]),
            card('Defaults for new services', [field('Runtime', esc(defaults.runtime ?? '—')), field('Branch', code(defaults.branch)),
                field('Workers', esc(defaults.workers ?? '—')), field('Memory', esc(defaults.max_memory_mb ? defaults.max_memory_mb+' MB' : '—')),
                field('CPU quota', esc(defaults.cpu_quota ? defaults.cpu_quota+' %' : '—')), field('Container port', esc(defaults.container_port ?? '—'))]),
            card('Backups', [field('Google Drive remote', code(drive.remote)), field('Retention', esc(drive.retention_days ? drive.retention_days+' days' : '—'))])
        ].join('');
    } catch (error) {
        box.innerHTML = `<article class="st-card st-error"><h3>Host settings unavailable</h3><p>${esc(error.message)}</p><button class="term-btn" id="stHostRetry" type="button">Try again</button></article>`;
        $('stHostRetry').addEventListener('click', loadHost);
    } finally { box.setAttribute('aria-busy','false'); }
}
$('stRefreshHost').addEventListener('click', loadHost);
$('stCloudflareSettings').addEventListener('click', async()=>{
    try { await window.fetchManage(true); if($('mgSettingsBtn').disabled) throw new Error('Host settings are unavailable. Check the ATS connection in Manage.');
          if (typeof openSettings === 'function') openSettings('cf'); else $('mgSettingsBtn').click(); }
    catch(error){ message(error.message,true); }
});
$('stSecLogoutOthers').addEventListener('click',()=>$('stLogoutOthers').click());
const strength = value => { let score = Math.min(value.length, 20) / 20 * 55; for (const re of [/[a-z]/,/[A-Z]/,/\d/,/[^A-Za-z0-9]/]) if (re.test(value)) score += 11; return Math.min(100, Math.round(score)); };
$('stNewPw').addEventListener('input',()=>{
    const value = $('stNewPw').value, score = value ? strength(value) : 0;
    $('stPwBar').style.width = score+'%'; $('stPwBar').dataset.level = score < 45 ? 'weak' : score < 75 ? 'fair' : 'strong';
    $('stPwHint').textContent = !value ? 'At least 10 characters.' : value.length < 10 ? `${10-value.length} more character${10-value.length===1?'':'s'} needed.` : score < 75 ? 'Acceptable. Longer or mixed characters are stronger.' : 'Strong.';
});
$('stPwToggle').addEventListener('click',()=>{
    const show = $('stNewPw').type === 'password';
    for (const id of ['stNewPw','stNewPw2']) $(id).type = show ? 'text' : 'password';
    $('stPwToggle').textContent = show ? 'Hide' : 'Show'; $('stPwToggle').setAttribute('aria-pressed', String(show));
});
$('stPwForm').addEventListener('submit',event=>{
    event.preventDefault();
    const value = $('stNewPw').value;
    if (value.length < 10) { message('The new password must be at least 10 characters.',true); return; }
    if (value !== $('stNewPw2').value) { message('The two new passwords do not match.',true); return; }
    confirmChange('Change administrator password','Enter your current password to confirm. Every other device will be signed out; this one stays signed in.','/api/settings/password',{new_password:value});
    $('stNewPw').value=''; $('stNewPw2').value=''; $('stNewPw').dispatchEvent(new Event('input'));
});
// ── finding things: search, jump tiles, "/" shortcut and deep links ──
function filterSections() {
    const query = $('stSearch').value.trim().toLowerCase(), words = query.split(/\s+/).filter(Boolean);
    let shown = 0;
    document.querySelectorAll('#stNavList .st-group').forEach(group => {
        let any = false;
        group.querySelectorAll('[data-settings]').forEach(button => {
            const haystack = (button.textContent + ' ' + (button.dataset.keywords || '')).toLowerCase();
            const match = words.every(word => haystack.includes(word));
            button.hidden = !match; any = any || match; shown += match ? 1 : 0;
        });
        group.hidden = !any;
    });
    $('stNoMatch').hidden = shown > 0;
}
$('stSearch').addEventListener('input', filterSections);
$('stSearch').addEventListener('keydown', event => {
    if (event.key === 'Enter') { const first = document.querySelector('#stNavList [data-settings]:not([hidden])'); if (first) { section(first.dataset.settings); first.focus(); } }
    if (event.key === 'Escape') { $('stSearch').value = ''; filterSections(); $('stSearch').blur(); }
});
document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || !$('tab-settings').classList.contains('active')) return;
    const typing = event.target.closest && event.target.closest('input, textarea, select, [contenteditable]');
    if (typing) return;
    event.preventDefault(); $('stSearch').focus();
});
document.querySelectorAll('[data-jump]').forEach(tile => tile.addEventListener('click', () => { $('stSearch').value = ''; filterSections(); section(tile.dataset.jump); }));
{   // #settings/<section> opens Settings on that section (shareable, survives reload)
    const match = /^#settings\/(general|account|security|appearance|devices|servers)$/.exec(location.hash);
    if (match) { document.querySelector('.nav-link[data-tab="settings"]')?.click(); section(match[1]); }
}
// Display expiry according to server policy. Never extend Standard sessions here.
async function checkAuthentication() {
    try {const response=await fetch('/api/auth/status',{credentials:'same-origin'});if(response.status===401)window.location.assign('/login');}
    catch(_) { /* Leave connection errors visible through the normal dashboard. */ }
}
setInterval(()=>{checkAuthentication();refreshSession();},30000);
})();

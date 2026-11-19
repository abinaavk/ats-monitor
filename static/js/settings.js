'use strict';
(() => {
const $ = id => document.getElementById(id);
let settings = null, devices = [], loadedAt = 0, pending = null, busy = false, returnFocus = null;
const when = value => value ? new Date(value * 1000).toLocaleString() : 'Unavailable';
const trusted = device => device.trusted_until && device.trusted_until > Date.now()/1000 && !device.revoked_at;
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
    if(name==='devices') loadDevices();
}
window.fetchSettings = async function(force=false) {
    if(!force && settings && Date.now()-loadedAt<30000) return;
    try {
        settings=await api('/api/settings'); loadedAt=Date.now();
        if(document.activeElement!==$('stDisplayName')) $('stDisplayName').value=settings.profile.display_name;
    } catch(error) { message(error.message,true); }
};
async function loadDevices() {
    $('stDevices').setAttribute('aria-busy','true');
    $('stRefreshDevices').disabled=true;
    if(!devices.length) $('stDevices').textContent='Loading registered devices…';
    try {
        const result=await api('/api/settings/devices'); devices=result.devices;
        $('stDevices').innerHTML=devices.length ? devices.map(device=>`<article class="st-device"><h3>${esc(device.name)}</h3><div class="st-badges">${device.current?'<span class="st-badge current">This device</span>':''}<span class="st-badge ${trusted(device)?'trusted':''}">${device.revoked_at?'Revoked':trusted(device)?'Trusted':'Standard security'}</span><span class="st-badge">${device.active_sessions?'Authenticated · Active session':'Signed out'}</span></div><p>${esc(device.device_type)} · ${esc(device.browser)}<br>IP ${esc(device.ip)} · Last active ${esc(when(device.last_active))}</p><div class="st-actions"><button class="term-btn" data-device="${esc(device.id)}" data-device-action="details">Details</button>${device.revoked_at?'':`<button class="term-btn" data-device="${esc(device.id)}" data-device-action="${trusted(device)?'untrust':'trust'}">${trusted(device)?'Remove trust':'Trust device'}</button><button class="term-btn" data-device="${esc(device.id)}" data-device-action="logout">Log out device</button><button class="term-btn st-sensitive" data-device="${esc(device.id)}" data-device-action="revoke">Revoke access</button>`}</div></article>`).join('') : '<p>No registered devices.</p>';
        $('stAudit').innerHTML=result.audit.map(entry=>`<li>${esc(entry.action.replaceAll('_',' '))}<time>${esc(when(entry.at))} · ${esc(entry.ip)}</time></li>`).join('') || '<li>No security activity yet.</li>';
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
// Display expiry according to server policy. Never extend Standard sessions here.
async function checkAuthentication() {
    try {const response=await fetch('/api/auth/status',{credentials:'same-origin'});if(response.status===401)window.location.assign('/login');}
    catch(_) { /* Leave connection errors visible through the normal dashboard. */ }
}
setInterval(checkAuthentication,30000);
})();

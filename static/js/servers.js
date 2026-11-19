'use strict';
// One immutable target per page lifetime. Switching reloads the document, which
// destroys old views, promises, dialogs, sockets, polling and subscriptions.
(() => {
    const originalFetch = window.fetch.bind(window);
    const controller = new AbortController();
    const selectedKey = 'ats.activeServer';
    let switching = false;
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
    const render = data => {
        const list=document.getElementById('serverList');
        list.replaceChildren();
        for(const server of data.servers) {
            const article=document.createElement('article'); article.className='st-device';
            const title=document.createElement('h3');title.textContent=server.name;
            const detail=document.createElement('p');detail.textContent=`${server.local?'Local · Primary':'Global'} · ${server.domain||'Central control point'} · ${server.connected?'Connected':'Disconnected'}`;
            article.append(title,detail);
            if(!server.local) for(const action of ['disconnect','reconnect','revoke']) {
                const button=document.createElement('button');button.className='term-btn';button.textContent=action[0].toUpperCase()+action.slice(1);
                button.addEventListener('click',async()=>{
                    if(action==='revoke'&&!confirm(`Revoke ${server.name}? New credentials must be generated on that Global server to pair again.`))return;
                    button.disabled=true;
                    try {await change(`/api/servers/${server.id}/${action}`,{});await load();show('Connection updated.');}
                    catch(error){show(error.message,true);}finally{button.disabled=false;}
                });article.append(button);
            }
            list.append(article);
        }
    };
    async function load() {const data=await json('/api/servers');render(data);return data;}
    async function change(path,body) {
        const settings=await json('/api/settings');
        return json(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':settings.csrf_token},body:JSON.stringify(body)});
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
            status.textContent='Connecting';
            json(`/api/servers/${id}/health`).then(()=>{status.textContent='Online';}).catch(()=>{status.textContent='Offline';});
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
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        if(url.origin!==location.origin||!hostRoutes(url.pathname))return originalFetch(input,options);
        const server=await window.atsServerReady;
        if(switching)throw new DOMException('Server changed','AbortError');
        const headers=new Headers(options.headers||{});headers.set('X-ATS-Target',server.id);
        const response=await originalFetch(input,{...options,headers,signal:controller.signal});
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
    document.getElementById('pairServer').addEventListener('submit',async event=>{
        event.preventDefault();const form=event.currentTarget;const button=form.querySelector('button[type="submit"]');button.disabled=true;
        const secret=document.getElementById('serverSecret');
        try {await change('/api/servers',{id:form.elements.serverId.value,name:form.elements.serverName.value,domain:form.elements.serverDomain.value,secret:secret.value});form.reset();await load();show('Paired and verified. Reload to refresh the selector.');}
        catch(error){show(error.message,true);}finally{secret.value='';button.disabled=false;}
    });
    document.getElementById('refreshServers').addEventListener('click',()=>load().catch(error=>show(error.message,true)));
})();

"""Run browser validation against temporary Local/Global fixtures only.

PYTHONPATH=<deps>:.:../ats:tests python3 tests/browser_servers.py
BROWSER_EXECUTABLE may select an existing Chromium; no production services start.
"""
import json
import os
from pathlib import Path
import threading
import time
import unittest
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server
from test_servers import ServersTests

fixture=ServersTests(methodName='test_all_host_reads_use_real_global_http_with_zero_local_calls')
fixture.setUp()
from unittest.mock import patch as _patch
# Key rotation on the fixture Global rewrites its pairing file; keep that inside the fixture directory.
_pairing=_patch('ats_server_cli.default_pairing_path',return_value=fixture.root/'pairing'/'pairing.json');_pairing.start()
_units=_patch('ats_status.failed_units',return_value=['demo.service']);_units.start()      # never read the real host's units in a test
try:
    os.environ['ATS_ACCESS_PASSWORD']='password'
    import app as host
    server=make_server('127.0.0.1',0,host.app,threaded=True)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    origin='http://127.0.0.1:'+str(server.server_port)
    report={'layouts':[],'switches':[],'errors':[]}
    with sync_playwright() as p:
        options={'headless':True,'args':['--no-sandbox']}
        if os.environ.get('BROWSER_EXECUTABLE'):options['executable_path']=os.environ['BROWSER_EXECUTABLE']
        browser=p.chromium.launch(**options)
        context=browser.new_context(service_workers='block')
        if os.environ.get('BROWSER_ASSETS'):
            def asset(route):
                filename=route.request.url.rsplit('/',1)[-1]
                route.fulfill(path=str(Path(os.environ['BROWSER_ASSETS'])/filename))
            context.route('https://cdn.jsdelivr.net/**',asset)
            context.route('https://cdn.socket.io/**',asset)
        context.route('https://fonts.googleapis.com/**',lambda route:route.abort())
        context.route('https://fonts.gstatic.com/**',lambda route:route.abort())
        page=context.new_page()
        page.on('requestfailed',lambda request:print('REQUEST FAILED',request.url,request.failure,flush=True))
        page.on('pageerror',lambda error:report['errors'].append(str(error)))
        import re
        login=context.request.get(origin+'/login')
        csrf=re.search(r'name="csrf_token" value="([^"]+)"',login.text())[1]
        response=context.request.post(origin+'/login',form={'password':'password','csrf_token':csrf})
        assert response.ok,response.text()
        page.goto(origin)
        page.wait_for_selector('#activeServer:not([disabled])')
        # No fixture credentials may appear in any web storage.
        assert fixture.node['secret'] not in page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')
        for width,height in [(360,800),(390,844),(768,1024),(1440,1000),(1920,1080)]:
            page.set_viewport_size({'width':width,'height':height})
            for theme in ['jetblack','light','midnight','rose']:
                page.evaluate('(theme)=>setTheme(theme)',theme)
                page.evaluate("document.querySelector('.nav-link[data-tab=settings]').click()")
                page.locator('[data-settings=servers]').click()
                assert page.locator('#st-servers').is_visible()
                page.locator('#serverList details').evaluate_all('(items)=>items.forEach(item=>item.open=true)')
                assert page.locator('#serverList article').count()==2
                assert page.locator('#activeServer').is_visible()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,theme,'horizontal overflow',page.evaluate("[document.documentElement.scrollWidth,innerWidth,...[...document.querySelectorAll('html,body,body *')].filter(e=>e.scrollWidth>e.clientWidth+1&&getComputedStyle(e).overflowX==='visible'&&e.clientWidth>0).slice(0,8).map(e=>e.tagName+'.'+e.className+'#'+e.id+' scroll='+e.scrollWidth+' client='+e.clientWidth)]"))
                form=page.locator('#pairServer').bounding_box();assert form['x']>=0 and form['x']+form['width']<=width+1
                update=page.locator('#serverList details .cred-form').bounding_box();assert update['x']>=0 and update['x']+update['width']<=width+1
                # Every Settings section must fit the viewport and render its content.
                for section in ('general','account','security','appearance','devices','servers'):
                    page.locator(f'[data-settings={section}]').click()
                    assert page.locator(f'#st-{section}').is_visible(),(width,theme,section)
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,theme,section,'horizontal overflow')
                    assert page.evaluate("[...document.querySelectorAll('#st-%s button, #st-%s input')].filter(e=>e.offsetParent).every(e=>e.getBoundingClientRect().right<=innerWidth+1)"%(section,section)),(width,theme,section,'control clipped')
                # Servers page layout invariants (cards, addresses, IDs, sticky header and section list).
                metrics=page.evaluate('''() => {
                    const box=e=>e.getBoundingClientRect(), cards=[...document.querySelectorAll('#serverList .srv-card')];
                    const rows={};cards.forEach(c=>{(rows[Math.round(box(c).top+scrollY)]=rows[Math.round(box(c).top+scrollY)]||[]).push(c);});
                    const addr=cards.map(c=>c.querySelector('.srv-addr'));
                    const long=addr[addr.length-1];const original=long.textContent;long.textContent='https://'+'a-very-long-server-name-'.repeat(8)+'gaiasentinel.online';
                    const probe={ellipsis:getComputedStyle(long).textOverflow==='ellipsis'&&getComputedStyle(long).whiteSpace==='nowrap',clipped:long.scrollWidth>long.clientWidth,lines:Math.round(box(long).height/parseFloat(getComputedStyle(long).lineHeight||18))};
                    long.textContent=original;
                    return {count:cards.length,sameWidth:new Set(cards.map(c=>Math.round(box(c).width))).size===1,
                      equalRowHeights:Object.values(rows).every(r=>new Set(r.map(c=>Math.round(box(c).height))).size===1),
                      sameFields:new Set(cards.map(c=>[...c.querySelectorAll('.srv-facts dt')].map(x=>x.textContent.replace(/Webhook receiver/,'Address')).join('|'))).size===1,
                      addrTitles:addr.every(a=>a.title&&a.title.length>=a.textContent.length-1),idTitles:cards.every(c=>c.querySelector('.srv-id').title.length===32),
                      idOneRow:cards.every(c=>Math.abs(box(c.querySelector('.srv-id')).top-box(c.querySelector('.srv-copy')).top)<8),
                      actionsLast:cards.every(c=>c.querySelector('.srv-foot').lastElementChild.classList.contains('srv-actions')),
                      actionGaps:new Set(cards.map(c=>Math.round(box(c).bottom-box(c.querySelector('.srv-actions')).bottom))).size===1,
                      pillsInside:cards.every(c=>[...c.querySelectorAll('.srv-sections .srv-section')].every(p=>box(p).bottom<=box(c).bottom&&box(p).right<=box(c).right+1)),
                      long:probe};
                }''')
                assert metrics['count']>=1 and metrics['sameWidth'] and metrics['equalRowHeights'] and metrics['sameFields'],(width,theme,metrics)
                assert metrics['addrTitles'] and metrics['idTitles'] and metrics['idOneRow'] and metrics['actionsLast'] and metrics['actionGaps'] and metrics['pillsInside'],(width,theme,metrics)
                assert metrics['long']['ellipsis'] and metrics['long']['clipped'] and metrics['long']['lines']==1,(width,theme,'address must stay on one line',metrics['long'])
                if width>=901:   # the section list sticks below the target bar and never slides under it
                    page.evaluate('window.scrollTo(0,500)');page.wait_for_timeout(120)
                    gap=page.evaluate("document.getElementById('stSearch').getBoundingClientRect().top-document.querySelector('.server-control').getBoundingClientRect().bottom")
                    page.evaluate('window.scrollTo(0,0)')
                    assert gap>=0,(width,theme,'section list is under the sticky header',gap)
                assert page.locator('#stGlance .st-tile').count()==4 and page.locator('#stGlance').is_visible(),(width,theme,'glance strip')
                if width>=1440:   # a PC uses the whole page, not a narrow column
                    box=page.locator('#st-servers').bounding_box();assert box['x']+box['width']>=width-80,(width,theme,'content does not reach the right edge',box)
                    if width>=1800:
                        assert page.locator('#serverList .srv-card').first.bounding_box()['width']<box['width']*0.6,(width,theme,'server cards should sit in columns')
                page.locator('#stSearch').fill('password')
                assert page.locator('#stNavList [data-settings]:not([hidden])').count()==1 and page.locator('[data-settings=account]').is_visible(),(width,theme,'search')
                page.locator('#stSearch').fill('zzzz');assert page.locator('#stNoMatch').is_visible(),(width,theme,'no-match message')
                page.locator('#stSearch').fill('');assert page.locator('#stNavList [data-settings]:not([hidden])').count()==6,(width,theme,'search reset')
                # Fleet panel: overview table (stacked cards on phones), alerts, backup and one-time-code form all fit the viewport.
                for panel in ('#fleetOverview','#fleetAlerts','#fleetBackup','#pairCode'):
                    assert page.locator(panel).is_visible(),(width,theme,panel,'missing')
                    bounds=page.locator(panel).bounding_box();assert bounds['x']>=0 and bounds['x']+bounds['width']<=width+1,(width,theme,panel,bounds)
                assert page.evaluate("getComputedStyle(document.querySelector('.fleet-table thead')).display==='none'")==(width<=700),(width,theme,'table should stack on phones only')
                assert page.evaluate("[...document.querySelectorAll('#fleetAlerts input:not([type=checkbox]),#fleetBackup input,#pairCode input')].every(e=>e.getBoundingClientRect().height>=40)"),(width,theme,'inputs must be touch sized')
                assert page.locator('#st-servers .srv-setup').is_visible() and page.locator('#st-servers [data-copy]').count()==5,(width,theme,'setup guide')
                assert 'server setup --apply' in page.locator('#st-servers .srv-setup').inner_text(),(width,theme,'setup command')
                report['layouts'].append({'width':width,'theme':theme,'pass':True})
        page.set_viewport_size({'width':1440,'height':1000})
        requests=[]
        def record(request):
            if '/api/' in request.url:
                requests.append({'url':request.url.split(origin)[-1],'target':request.headers.get('x-ats-target'),'method':request.method})
        page.on('request',record)
        page.locator('#activeServer').select_option(fixture.node['id'])
        page.wait_for_selector('#activeServer:not([disabled])')
        assert page.locator('#activeServer').input_value()==fixture.node['id']
        assert page.evaluate('window.atsTarget.local')==0
        for tab,path in [('overview','/api/overview'),('manage','/api/manage/services'),('docker','/api/docker/containers'),('logs','/api/logs'),('metrics','/api/overview'),('stats','/api/stats'),('audit','/api/audit'),('database','/api/database')]:
            start=len(requests)
            page.evaluate('(tab)=>document.querySelector(`.nav-link[data-tab="${tab}"]`).click()',tab)
            page.wait_for_timeout(1300)
            calls=[r for r in requests[start:] if r['url'].startswith(path)]
            # Metrics shares overview data and may reuse its current page cache.
            if tab!='metrics':assert calls,(tab,requests[start:])
            assert all(r['target']==fixture.node['id'] for r in calls),(tab,calls)
            report['switches'].append({'tab':tab,'target':'global','pass':True})
        # Terminals on a Global are relayed (covered end to end by the ATS rehearsal); no local shell may be opened for one.
        assert len(host._term_sessions)==0
        # A delayed old-server response cannot enter the newly loaded page.
        import servers_api
        actual_remote=servers_api.remote
        slow_started=threading.Event()
        def slow_remote(server,value):
            result=actual_remote(server,value)
            if server['id']==fixture.node['id'] and value.get('path','').startswith('/api/logs'):
                slow_started.set();time.sleep(1.2)
                result['body']={'lines':['OLD TARGET DELAYED DATA'],'type':'ats'}
            return result
        servers_api.remote=slow_remote
        page.evaluate("document.querySelector('.nav-link[data-tab=logs]').click()")
        assert slow_started.wait(5),'Old-server request did not start'
        page.locator('#activeServer').select_option(fixture.local['id'])
        page.wait_for_selector('#activeServer:not([disabled])')
        servers_api.remote=actual_remote
        page.wait_for_timeout(1400)
        assert 'OLD TARGET DELAYED DATA' not in page.locator('body').inner_text()
        assert page.evaluate('window.atsTarget.local')==1
        report['switches'].append({'tab':'delayed response isolation','target':'local','pass':True})
        # Local socket selection guard rejects a forged remote target.
        with host.app.test_client() as c:
            c.get('/login')
            with c.session_transaction() as session:csrf=session['login_csrf']
            c.post('/login',data={'password':'password','csrf_token':csrf})
            # A forged or unknown target is never given a local shell: the terminal itself says why and ends.
            from unittest.mock import patch
            with patch('cluster_support.configured_node',return_value=fixture.local):   # the fixture's env registry is a Global's
                socket=host.socketio.test_client(host.app,namespace='/terminal',flask_test_client=c,query_string='server='+('f'*32))
            assert socket.is_connected('/terminal')
            host.socketio.sleep(1)
            said=str(socket.get_received('/terminal'))
            assert 'Unknown server' in said,said
            assert not any(session.get('fd') for session in host._term_sessions.values())
        # The target wrapper must retain Request headers and caller cancellation.
        result=page.evaluate('''async () => {
            const request=new Request('/api/manage/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Requested-With':'ats-monitor'},body:JSON.stringify({storage_root:'/tmp/browser-fixture'})});
            const controller=new AbortController();controller.abort();
            try {await fetch(request,{signal:controller.signal});return 'not aborted';}
            catch(error){return error.name;}
        }''')
        assert result=='AbortError',result
        # ── Fleet panel, end to end through the UI ──
        import fleet_api, re as regex
        from unittest.mock import patch as patch_
        page.on('dialog',lambda dialog:dialog.accept())
        page.set_viewport_size({'width':1440,'height':1000})
        page.evaluate("document.querySelector('.nav-link[data-tab=settings]').click()")
        page.locator('[data-settings=servers]').click()
        page.locator('#fleetRefresh').click()
        page.wait_for_selector('#fleetOverview [role=meter]')
        rows=page.locator('#fleetOverview tbody tr');assert rows.count()==2,rows.count()
        assert page.locator('#fleetOverview .srv-badge',has_text='Online').count()==2
        assert page.locator('#fleetOverview [role=meter][aria-valuenow]').count()>=6      # CPU, memory and disk for both servers
        badge=page.locator('#fleetOverview .fleet-flags .srv-badge',has_text='1 failed service')
        assert badge.count()==2 and badge.first.get_attribute('title')=='demo.service',badge.count()      # both servers report it, with the unit name on hover
        # Create a webhook mapping: the secret is shown once, in the page only, and never listed afterwards.
        page.locator('#serverList details').evaluate_all('(items)=>items.forEach(item=>item.open=true)')
        card=page.locator('#serverList .srv-card[data-local="0"]')
        card.locator('input[name=repository]').fill('Browser/Fixture');card.locator('input[name=service]').fill('service')
        card.locator('button',has_text='Create mapping').click()
        page.wait_for_selector('.fleet-secret')
        secret=page.locator('.fleet-secret code').nth(2).inner_text()
        assert regex.fullmatch('[0-9a-f]{64}',secret),secret
        assert page.locator('.fleet-secret code').nth(0).inner_text()=='https://hooks.example.com/webhook'
        with fixture.primary.db() as db:assert db.execute('SELECT secret FROM routes').fetchone()[0]==secret      # stored on the server, shown to the browser once
        page.locator('.fleet-secret button',has_text='I have saved it').click()
        page.wait_for_selector('#serverList .srv-maps li[data-repository="browser/fixture"]')
        assert secret not in page.content() and secret not in page.locator('body').inner_text()
        assert secret not in page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')
        with patch_.object(fleet_api,'deliver',return_value=200):
            page.locator('.srv-maps li[data-repository="browser/fixture"] button',has_text='Test').click()
            page.wait_for_selector('.srv-map-result .ok')
        assert page.locator('.srv-map-result li.ok').count()==4 and page.locator('.srv-map-result li.bad').count()==0
        page.locator('.srv-maps li[data-repository="browser/fixture"] button',has_text='Delete').click()
        page.wait_for_function("!document.querySelector('.srv-maps li[data-repository=\"browser/fixture\"]')")
        # Alerts: tokens are masked after saving and never come back to the page.
        page.locator('#fleetAlerts input[name="ntfy.url"]').fill('https://ntfy.example.com/browser')
        page.locator('#fleetAlerts input[name="ntfy.token"]').fill('tk_browser1234')
        page.locator('#fleetAlerts input[name="ntfy.enabled"]').check()
        page.locator('#fleetAlerts input[data-kind=backup]').uncheck()
        page.locator('#fleetAlerts input[name="watch.ignore_units"]').fill('atopacct.service morphic.service')
        page.locator('#fleetAlerts button[type=submit]').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('Alert settings saved')")
        page.locator('#refreshServers').click()
        page.wait_for_function("document.querySelector('#fleetAlerts input[name=\"ntfy.token\"]')?.value==='********'")
        assert page.locator('#fleetAlerts input[name="watch.ignore_units"]').input_value()=='atopacct.service morphic.service'
        assert page.locator('#fleetAlerts input[data-kind=backup]').is_checked()==False and page.locator('#fleetAlerts input[data-kind=deployment]').is_checked()
        assert 'tk_browser1234' not in page.content() and 'tk_browser1234' not in page.evaluate("[...document.querySelectorAll('#fleetAlerts input')].map(i=>i.value).join()")
        # Registry backup.
        page.locator('#fleetBackup button',has_text='Back up now').click()
        page.wait_for_function("document.querySelector('#fleetBackup').innerText.includes('Newest backup')")
        # An encrypted copy goes to the Global; plaintext cannot.
        page.locator('#fleetBackup .fleet-offsite').wait_for()
        assert 'No copy has left this server yet' in page.locator('#fleetBackup .fleet-offsite').inner_text()
        page.locator('#fleetBackup .fleet-offsite input[type=password]').fill('short')
        page.locator('#fleetBackup .fleet-offsite button',has_text='Send a copy now').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('at least 8')")
        page.locator('#fleetBackup .fleet-offsite input[type=password]').fill('a long enough passphrase')
        page.locator('#fleetBackup .fleet-offsite button',has_text='Send a copy now').click()
        page.wait_for_function("document.querySelector('#fleetBackup .fleet-offsite')?.innerText.includes('copy stored')")
        stored=list((Path(fixture.global_store.path).parent/'offsite-backups').glob('registry-*.sqlite3.enc'))
        assert len(stored)==1 and fixture.node['secret'].encode() not in stored[0].read_bytes()
        assert 'a long enough passphrase' not in page.content() and 'a long enough passphrase' not in page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')
        # Rotate the key on the Global over the signed channel.
        before=fixture.primary.server(fixture.node['id'])['secret']
        page.locator('#serverList details').evaluate_all('(items)=>items.forEach(item=>item.open=true)')
        page.locator('#serverList .srv-card[data-local="0"] button',has_text='Rotate key now').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('Key rotated and verified')")
        assert fixture.primary.server(fixture.node['id'])['secret']==fixture.global_store.node()['secret']!=before
        # Settings → Devices shows who did what, with the device name.
        page.locator('[data-settings=devices]').click()
        page.wait_for_function("document.querySelector('#stAudit').innerText.includes('webhook mapping created')")
        text=page.locator('#stAudit').inner_text()
        assert 'server key rotated' in text and 'browser/fixture' in text and secret not in text,text
        # Cloudflare editor: list backups and restore one (the API answers are fixtures; the restore job is checked in the API tests).
        digest='c'*64
        def cloudflare(route):
            url=route.request.url
            if url.endswith('/cloudflare/config'):data={'path':'/etc/cloudflared/config.yml','exists':True,'content':'tunnel: t\n','sha256':digest,'service':'cloudflared','active':True,'validator':True}
            elif url.endswith('/cloudflare/backups'):data={'path':'/etc/cloudflared/config.yml','backups':[
                {'name':'config.yml.bak-20240102-100000','at':1704189600,'size':120,'sha256':'d'*64,'hostnames':['a.example.com','b.example.com']},
                {'name':'config.yml.bak-20240101-100000','at':1704103200,'size':100,'sha256':digest,'hostnames':[]}]}
            elif url.endswith('/cloudflare/restore'):
                posted.append(json.loads(route.request.post_data));return route.fulfill(status=202,json={'ok':True,'data':{'job_id':'abcdef0123456789','op':'cloudflare.config.restore','name':'cloudflare'}})
            else:data={'service':'cloudflared','active':True,'config_path':'/etc/cloudflared/config.yml','missing':[],'orphans':[],'routes':[]}
            route.fulfill(json={'ok':True,'data':data})
        posted=[]
        page.route('**/api/manage/cloudflare**',cloudflare)
        page.evaluate("document.querySelector('.nav-link[data-tab=manage]').click()")
        page.wait_for_function("!document.getElementById('mgSettingsBtn').disabled")
        page.locator('#mgSettingsBtn').click();page.locator('[data-st=cf]').click()
        page.locator('[data-cf=edit]').click()
        page.locator('#mgCfBackups summary').click()
        page.wait_for_selector('#mgCfBackupList [data-cf-restore]')
        assert page.locator('#mgCfBackupList li').count()==2 and 'a.example.com, b.example.com' in page.locator('#mgCfBackupList').inner_text()
        assert page.locator('#mgCfBackupList [data-cf-restore]').nth(1).is_disabled()          # the one identical to the current file
        assert page.evaluate("document.getElementById('mgCfEdit').scrollWidth<=document.getElementById('mgCfEdit').clientWidth+1")
        page.locator('#mgCfBackupList [data-cf-restore]').nth(0).click()
        page.locator('#mgConfirmGo').click()
        page.wait_for_function('!document.getElementById("mgCfEdit").open')
        page.wait_for_timeout(600)
        assert posted==[{'name':'config.yml.bak-20240102-100000','base_sha256':digest,'restart':True}],posted
        page.unroute('**/api/manage/cloudflare**')
        page.evaluate("document.querySelectorAll('dialog[open]').forEach(dialog=>dialog.close())")      # the fixture job dialog and Settings
        page.evaluate("document.querySelector('.nav-link[data-tab=settings]').click()")
        # Rotate on the fixture Global, then repair the existing entry through the UI.
        fresh=__import__('secrets').token_hex(32)
        with fixture.global_store.db() as db:db.execute('UPDATE node SET secret=?',(fresh,))
        page.evaluate("document.querySelector('.nav-link[data-tab=settings]').click()")
        page.locator('[data-settings=servers]').click()
        page.locator('#serverList details').evaluate_all('(items)=>items.forEach(item=>item.open=true)')
        form=page.locator('#serverList details .cred-form')
        form.locator('input[type=password]').fill(fresh)
        form.locator('button').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('Credentials verified')")
        assert fixture.primary.server(fixture.node['id'])['secret']==fresh
        assert page.locator('#serverList details .cred-form input[type=password]').input_value()==''
        assert fresh not in page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')
        assert fresh not in page.content()
        page.set_viewport_size({'width':390,'height':844})
        page.locator('#serverList details').evaluate_all('(items)=>items.forEach(item=>item.open=true)')
        page.screenshot(path='/tmp/gai18-servers-mobile.png',full_page=True)
        report['switches'].append({'tab':'credential replacement','target':'global','pass':True})
        assert not report['errors'],report['errors']
        context.close();browser.close()
    print(json.dumps(report,indent=2))
    server.shutdown()
finally:
    _units.stop()
    _pairing.stop()
    fixture.doCleanups()

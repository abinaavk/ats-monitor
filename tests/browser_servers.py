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
        for width,height in [(360,800),(390,844),(768,1024),(1440,1000)]:
            page.set_viewport_size({'width':width,'height':height})
            for theme in ['jetblack','light','midnight','rose']:
                page.evaluate('(theme)=>setTheme(theme)',theme)
                page.evaluate("document.querySelector('.nav-link[data-tab=settings]').click()")
                page.locator('[data-settings=servers]').click()
                assert page.locator('#st-servers').is_visible()
                page.locator('#serverList details').evaluate_all('(items)=>items.forEach(item=>item.open=true)')
                assert page.locator('#serverList article').count()==2
                assert page.locator('#activeServer').is_visible()
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,theme,'horizontal overflow')
                form=page.locator('#pairServer').bounding_box();assert form['x']>=0 and form['x']+form['width']<=width+1
                update=page.locator('#serverList details .cred-form').bounding_box();assert update['x']>=0 and update['x']+update['width']<=width+1
                # Every Settings section must fit the viewport and render its content.
                for section in ('general','account','security','appearance','devices','servers'):
                    page.locator(f'[data-settings={section}]').click()
                    assert page.locator(f'#st-{section}').is_visible(),(width,theme,section)
                    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth'),(width,theme,section,'horizontal overflow')
                    assert page.evaluate("[...document.querySelectorAll('#st-%s button, #st-%s input')].filter(e=>e.offsetParent).every(e=>e.getBoundingClientRect().right<=innerWidth+1)"%(section,section)),(width,theme,section,'control clipped')
                assert page.locator('#st-servers .srv-setup').is_visible() and page.locator('#st-servers [data-copy]').count()==4,(width,theme,'setup guide')
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
        page.evaluate("document.querySelector('.nav-link[data-tab=terminal]').click()")
        assert page.locator('#term-overlay-title').inner_text()=='Remote terminal unavailable'
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
            socket=host.socketio.test_client(host.app,namespace='/terminal',flask_test_client=c,query_string='server='+fixture.node['id'])
            assert not socket.is_connected('/terminal')
        # The target wrapper must retain Request headers and caller cancellation.
        result=page.evaluate('''async () => {
            const request=new Request('/api/manage/settings',{method:'PUT',headers:{'Content-Type':'application/json','X-Requested-With':'ats-monitor'},body:JSON.stringify({storage_root:'/tmp/browser-fixture'})});
            const controller=new AbortController();controller.abort();
            try {await fetch(request,{signal:controller.signal});return 'not aborted';}
            catch(error){return error.name;}
        }''')
        assert result=='AbortError',result
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
    fixture.doCleanups()

"""Pairing layout and interaction checks using temporary fixtures.

Run with browser_servers.py's environment. SETTINGS_CAPTURE_DIR saves previews.
No production hosts, pairing codes or secrets are used.
"""
import json
import os
from pathlib import Path
import re
import threading
from playwright.sync_api import sync_playwright
from werkzeug.serving import make_server
from test_servers import ServersTests


fixture = ServersTests(methodName='test_all_host_reads_use_real_global_http_with_zero_local_calls')
fixture.setUp()
try:
    os.environ['ATS_ACCESS_PASSWORD'] = 'password'
    import app as host
    server = make_server('127.0.0.1', 0, host.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    report = {'layouts': [], 'errors': []}
    captures = Path(os.environ['SETTINGS_CAPTURE_DIR']) if os.environ.get('SETTINGS_CAPTURE_DIR') else None
    if captures:
        captures.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        options = {'headless': True, 'args': ['--no-sandbox']}
        if os.environ.get('BROWSER_EXECUTABLE'):
            options['executable_path'] = os.environ['BROWSER_EXECUTABLE']
        browser = p.chromium.launch(**options)
        context = browser.new_context(service_workers='block')
        if os.environ.get('BROWSER_ASSETS'):
            def asset(route):
                route.fulfill(path=str(Path(os.environ['BROWSER_ASSETS']) / route.request.url.rsplit('/', 1)[-1]))
            context.route('https://cdn.jsdelivr.net/**', asset)
            context.route('https://cdn.socket.io/**', asset)
        context.route('https://fonts.googleapis.com/**', lambda route: route.abort())
        context.route('https://fonts.gstatic.com/**', lambda route: route.abort())
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        login = context.request.get(origin + '/login')
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', login.text())[1]
        assert context.request.post(origin + '/login', form={'password': 'password', 'csrf_token': csrf}).ok
        page.goto(origin + '/#settings/servers')
        page.wait_for_selector('#serverList .srv-card')
        assert not page.locator('#globalSetup').evaluate('(e)=>e.open')
        assert not page.locator('#pairServer').is_visible()
        for width in (320, 390, 600, 768, 820, 1024, 1280, 1440, 1920):
            page.set_viewport_size({'width': width, 'height': 900})
            for theme in ('jetblack', 'light', 'midnight', 'rose'):
                page.evaluate('(theme) => setTheme(theme)', theme)
                for expanded in (False, True):
                    page.locator('#globalSetup, #pairingFile').evaluate_all('(items, open) => items.forEach(e => e.open = open)', expanded)
                    metrics = page.evaluate('''() => {
                        const box=e=>e.getBoundingClientRect();
                        const controls=[...document.querySelectorAll('#addServer input,#addServer button,#addServer textarea,#addServer summary')].filter(e=>e.checkVisibility());
                        const inputs=[...document.querySelectorAll('#pairCode input')];
                        const submit=box(document.querySelector('#pairCode button'));
                        return {overflow:document.documentElement.scrollWidth>innerWidth,
                            clipped:controls.some(e=>box(e).left<0 || box(e).right>innerWidth+1),
                            small:controls.filter(e=>box(e).height<44).map(e=>[e.tagName,e.id,e.name,box(e).height]),
                            submitBelow:inputs.every(e=>box(e).bottom<=submit.top),
                            aligned:Math.abs(submit.left-box(inputs[0]).left)<1,
                            formHeight:Math.round(box(document.querySelector('#pairCode')).height)};
                    }''')
                    report['layouts'].append({'width':width,'theme':theme,'expanded':expanded,**metrics})
                    assert not metrics['overflow'] and not metrics['clipped'] and not metrics['small'], report['layouts'][-1]
                    assert metrics['submitBelow'] and metrics['aligned'], report['layouts'][-1]
                page.locator('#globalSetup, #pairingFile').evaluate_all('(items) => items.forEach(e => e.open = false)')
                if captures and theme == 'jetblack' and width in (390, 1920):
                    page.locator('#addServer').evaluate('(e)=>window.scrollTo(0,e.getBoundingClientRect().top+scrollY-65)')
                    page.screenshot(path=str(captures/f'pairing-{width}.png'))
        # Native disclosure works from the keyboard; the main jump focuses the code form.
        for selector in ('#globalSetup', '#pairingFile'):
            page.locator(selector+' summary').focus()
            page.keyboard.press('Enter')
            assert page.locator(selector).get_attribute('open') is not None
            page.keyboard.press('Enter')
            assert page.locator(selector).get_attribute('open') is None
        page.set_viewport_size({'width':390,'height':844})
        page.locator('#addServerJump').click()
        assert page.locator('#pairCode input[name=codeDomain]').evaluate('(e)=>document.activeElement===e')
        assert not page.locator('#pairingFile').evaluate('(e)=>e.open')
        page.wait_for_function("(()=>{const r=document.querySelector('#pairCode input').getBoundingClientRect();return r.top>56 && r.bottom<innerHeight-60})()")
        # Verify copy still writes the exact command without invoking a terminal.
        page.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.copiedCommand=text}, configurable:true})")
        page.locator('.srv-codebox [data-copy]').click()
        page.wait_for_function("window.copiedCommand==='sudo python3 app.py server pair-code'")
        requests=[]
        def pair_code(route):
            requests.append(route.request.post_data_json)
            route.fulfill(status=400 if len(requests)==1 else 200,json={'error':'Fixture expired code'} if len(requests)==1 else {'ok':True})
        page.route('**/api/servers/pair-code',pair_code)
        code=page.locator('#pairCode')
        code.locator('[name=codeDomain]').fill('https://fixture.example.com')
        code.locator('[name=codeValue]').fill('ABCD-EFGH-JKLM')
        code.locator('[name=codeName]').fill('Fixture Global')
        code.locator('button').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('Fixture expired code')")
        assert code.locator('[name=codeValue]').input_value()==''
        assert code.locator('[name=codeDomain]').input_value()=='https://fixture.example.com'
        assert code.locator('button').is_enabled()
        code.locator('[name=codeValue]').fill('WXYZ-ABCD-EFGH')
        code.locator('button').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('Paired and verified')")
        assert requests[-1]=={'domain':'https://fixture.example.com','code':'WXYZ-ABCD-EFGH','name':'Fixture Global'}
        assert code.locator('[name=codeDomain]').input_value()==''
        # Pair-again opens and prefills the alternate form without hiding keyboard focus.
        servers=context.request.get(origin+'/api/servers').json()
        remote=next(s for s in servers['servers'] if not s['local'])
        remote.update(paired=False,connected=False)
        page.route('**/api/servers',lambda r:r.fulfill(json=servers))
        page.locator('#refreshServers').click()
        page.get_by_role('button',name='Pair again',exact=True).click()
        assert page.locator('#pairingFile').evaluate('(e)=>e.open')
        assert page.locator('#pairPaste').evaluate('(e)=>document.activeElement===e')
        page.wait_for_function("(()=>{const r=document.querySelector('#pairPaste').getBoundingClientRect();return r.top>56 && r.bottom<innerHeight-60})()")
        assert page.locator('#pairServer [name=serverId]').input_value()==remote['id']
        value={'name':'Pasted fixture','domain':'https://paste.example.com','id':'d'*32,'secret':'e'*64}
        page.locator('#pairPaste').fill(json.dumps(value))
        assert page.locator('#serverSecret').input_value()==value['secret']
        assert page.locator('#pairPaste').input_value()==''
        paired=[]
        # Simulate a successful pairing mutation; subsequent reads keep fixture state.
        def pair_file(route):
            if route.request.method=='POST':
                paired.append(route.request.post_data_json)
                route.fulfill(json={'ok':True})
            else:
                route.fulfill(json=servers)
        page.unroute('**/api/servers')
        page.route('**/api/servers',pair_file)
        page.locator('#pairServer button[type=submit]').click()
        page.wait_for_function("document.querySelector('#serversMessage').textContent.includes('Paired and verified')")
        assert paired==[value]
        assert page.locator('#serverSecret').input_value()==''
        assert value['secret'] not in page.evaluate('JSON.stringify({...localStorage,...sessionStorage})')
        report['interactions']=['keyboard disclosures','Add a server focus','copy command','expired-code retry and clearing','successful code submit','Pair again disclosure and prefill','pairing-file paste and submit','secret clearing and storage']
        assert not report['errors'],report['errors']
        print(json.dumps(report,indent=2),flush=True)
        browser.close()
    server.shutdown()
finally:
    fixture.doCleanups()

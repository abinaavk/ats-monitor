"""Settings layout and navigation checks against temporary fixtures.

Run like browser_servers.py, with ATS_MODULE_DIR pointing to an ATS checkout.
SETTINGS_CAPTURE_DIR saves optional screenshots. SETTINGS_PROBE_ONLY reports
layout failures without stopping, for comparing the unmodified page.
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
        # Long real-world paths must wrap inside their card, including at tablet widths.
        page.route('**/api/manage/settings', lambda route: route.fulfill(json={'ok': True, 'data': {
            'main_domain': 'monitor.example.com', 'domains': ['monitor.example.com', 'api.example.com'],
            'storage_root': '/opt/services/' + 'a-long-project-directory/' * 4,
            'service_user': 'monitor', 'ats_home': '/opt/ats',
            'cloudflare_config': '/etc/cloudflared/config.yml', 'cloudflared_service': 'cloudflared.service',
            'defaults': {'runtime': 'python', 'branch': 'main', 'workers': 2},
            'webhook': {'domain': 'hooks.example.com', 'port': 9998}, 'gdrive': {'retention_days': 14}
        }}))
        page.goto(origin + '/#settings/general')
        page.wait_for_selector('#activeServer:not([disabled])')
        page.wait_for_selector('#stHostOverview .st-card')
        for width, height in [(320, 740), (390, 844), (600, 900), (768, 1024), (820, 900), (1024, 900), (1280, 900), (1440, 1000), (1920, 1080)]:
            page.set_viewport_size({'width': width, 'height': height})
            for theme in ('jetblack', 'light', 'midnight', 'rose'):
                page.evaluate('(theme) => setTheme(theme)', theme)
                for section in ('general', 'account', 'security', 'appearance', 'devices', 'servers'):
                    page.locator(f'#st-nav-{section}').click()
                    page.wait_for_selector(f'#st-{section}:not([hidden])')
                    if section == 'devices':
                        page.wait_for_selector('#stDevices[aria-busy=false]')
                    if section == 'servers':
                        page.locator('#serverList details').evaluate_all('(items) => items.forEach(item => item.open = true)')
                    if captures and theme == 'jetblack' and width in (390, 1024, 1440):
                        page.screenshot(path=str(captures / f'{section}-{width}.png'), full_page=True)
                    clipped = page.evaluate('''() => [...document.querySelectorAll('.st-panel:not([hidden]) button, .st-panel:not([hidden]) input, .st-panel:not([hidden]) textarea, .st-panel:not([hidden]) .st-card')]
                        .filter(e => e.getClientRects().length && !e.closest('.fleet-scroll'))
                        .filter(e => { const r=e.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth+1; })
                        .map(e => e.id || e.className)''')
                    row = {'width': width, 'theme': theme, 'section': section, 'clipped': clipped,
                           'overflow': page.evaluate('document.documentElement.scrollWidth > innerWidth')}
                    report['layouts'].append(row)
                    if not os.environ.get('SETTINGS_PROBE_ONLY'):
                        assert not row['clipped'] and not row['overflow'], row
                        # All section choices fit at once; swiping a hidden row is unnecessary.
                        assert page.locator('#stNavList').evaluate('(e) => e.scrollWidth <= e.clientWidth'), (width, theme, 'navigation overflow')
                        assert page.locator('#stNavList [data-settings]').evaluate_all('''items => items.every(e => {
                            const r=e.getBoundingClientRect(), nav=e.closest('.st-nav').getBoundingClientRect();
                            return r.height >= 44 && r.left >= nav.left && r.right <= nav.right;
                        })'''), (width, theme, 'section control clipped')
                        if width <= 600:
                            assert page.locator('.st-panel:not([hidden]) button, .st-panel:not([hidden]) summary').evaluate_all('''items => items
                                .filter(e => e.getClientRects().length).every(e => e.getBoundingClientRect().height >= 44)'''), (width, section, 'small touch control')
        if not os.environ.get('SETTINGS_PROBE_ONLY'):
            # Search, keyboard selection and reset preserve section navigation.
            page.set_viewport_size({'width': 1440, 'height': 1000})
            page.locator('#stSearch').fill('password')
            assert page.locator('#stNavList [data-settings]:visible').count() == 1
            page.locator('#stSearch').press('Enter')
            assert page.locator('#st-account').is_visible()
            assert page.locator('#st-nav-account').get_attribute('aria-current') == 'page'
            page.locator('#stSearch').fill('no matching settings')
            assert page.locator('#stNoMatch').is_visible()
            page.locator('#stSearch').press('Escape')
            assert page.locator('#stNavList [data-settings]:visible').count() == 6
            page.keyboard.press('/')
            assert page.locator('#stSearch').evaluate('(e) => e === document.activeElement')
            page.locator('#stSearch').press('Escape')
            page.locator('[data-jump=security]').click()
            assert page.locator('#st-security').is_visible()
            # The real Settings endpoint remains password-confirmed through the dialog.
            page.locator('#st-nav-account').click()
            page.locator('#stDisplayName').fill('Layout review')
            page.locator('#stProfile button').click()
            page.locator('#stPassword').fill('password')
            page.locator('#stConfirmSubmit').click()
            page.wait_for_selector('#stConfirm:not([open])', state='attached')
            page.wait_for_function("document.querySelector('#stMessage').textContent === 'Changes saved.'")
            assert context.request.get(origin + '/api/settings').json()['profile']['display_name'] == 'Layout review'
            for width, height in [(320, 740), (390, 844), (844, 390), (1440, 1000)]:
                page.set_viewport_size({'width': width, 'height': height})
                page.locator('#st-nav-account').click()
                page.locator('#stProfile button').click()
                assert page.locator('#stPassword').evaluate('(e) => e === document.activeElement')
                for selector in ('#stConfirm', '#stConfirmSubmit'):
                    bounds = page.locator(selector).bounding_box()
                    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width + 1, (width, selector)
                page.keyboard.press('Escape')
                assert not page.locator('#stConfirm').is_visible()
                assert page.locator('#stProfile button').evaluate('(e) => e === document.activeElement')
                page.locator('#st-nav-devices').click()
                page.wait_for_selector('#stDevices[aria-busy=false]')
                page.locator('[data-device-action=details]').first.click()
                bounds = page.locator('#stDetails').bounding_box()
                assert bounds['x'] >= 0 and bounds['y'] >= 0 and bounds['height'] <= height + 1
                if captures and width == 390:
                    page.screenshot(path=str(captures / 'device-dialog-390.png'))
                page.keyboard.press('Escape')
            # A failed host read offers a working retry and fits the same panel.
            failed = lambda route: route.fulfill(status=503, json={'error': 'Fixture host unavailable'})
            page.route('**/api/manage/settings', failed)
            page.locator('#st-nav-general').click()
            page.wait_for_selector('#stHostRetry')
            page.unroute('**/api/manage/settings', failed)
            page.locator('#stHostRetry').click()
            page.wait_for_selector('#stHostOverview .st-card:not(.st-error)')
            page.goto(origin + '/#settings/devices')
            page.wait_for_selector('#st-devices:not([hidden])')
            assert page.locator('#st-nav-devices').get_attribute('aria-current') == 'page'
            report['interactions'] = ['search', 'keyboard', 'jump tiles', 'profile save', 'dialog focus and cancel', 'device details', 'host retry', 'deep link']
        print(json.dumps(report, indent=2), flush=True)
        assert not report['errors'], report['errors']
        context.close()
        browser.close()
    server.shutdown()
finally:
    fixture.doCleanups()

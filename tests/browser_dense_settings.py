"""Screenshot regression: 24 Local webhooks, two Globals and populated alert forms.

Run with browser_settings.py's environment. DENSE_CAPTURE_DIR saves previews;
DENSE_BASELINE_ASSETS can select a static/ snapshot for a before comparison.
All state belongs to temporary fixtures; no production services are contacted.
"""
import copy
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
    for i in range(24):
        fixture.primary.mapping(f'example/project-with-long-name-{i}', fixture.local['id'],
                                f'service-{i}', 'main', f'{i:064x}')
    os.environ['ATS_ACCESS_PASSWORD'] = 'password'
    import app as host
    server = make_server('127.0.0.1', 0, host.app, threaded=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    baseline_assets = os.environ.get('DENSE_BASELINE_ASSETS')
    baseline = bool(baseline_assets)
    capture = Path(os.environ['DENSE_CAPTURE_DIR']) if os.environ.get('DENSE_CAPTURE_DIR') else None
    if capture:
        capture.mkdir(parents=True, exist_ok=True)
    report = {'layouts': [], 'errors': []}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('BROWSER_EXECUTABLE'), args=['--no-sandbox'])
        context = browser.new_context(service_workers='block')
        if os.environ.get('BROWSER_ASSETS'):
            def asset(route):
                route.fulfill(path=str(Path(os.environ['BROWSER_ASSETS']) / route.request.url.rsplit('/', 1)[-1]))
            context.route('https://cdn.jsdelivr.net/**', asset)
            context.route('https://cdn.socket.io/**', asset)
        context.route('https://fonts.googleapis.com/**', lambda r: r.abort())
        context.route('https://fonts.gstatic.com/**', lambda r: r.abort())
        login = context.request.get(origin + '/login')
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', login.text())[1]
        assert context.request.post(origin + '/login', form={'password': 'password', 'csrf_token': csrf}).ok
        servers = context.request.get(origin + '/api/servers').json()
        third = copy.deepcopy(next(s for s in servers['servers'] if not s['local']))
        third.update(id='c' * 32, name='Second Global', domain='https://second-global.example.com')
        servers['servers'].append(third)
        page = context.new_page()
        page.on('pageerror', lambda error: report['errors'].append(str(error)))
        page.route('**/api/servers', lambda r: r.fulfill(json=servers))
        page.route('**/api/servers/' + third['id'] + '/health', lambda r: r.fulfill(json={'ok': True, 'management_ready': True}))
        if baseline:
            # Keep the legacy directory untouched; load only its original CSS/JS.
            for path in ('css/servers.css', 'css/settings.css', 'js/servers.js', 'js/fleet.js'):
                page.route('**/static/' + path, lambda r: r.fulfill(path=str(Path(baseline_assets) / r.request.url.split('/static/', 1)[1])))
        page.goto(origin + '/#settings/servers')
        page.wait_for_selector('#serverList .srv-card:nth-child(3)')
        page.wait_for_selector('#fleetAlerts .alert-check')
        page.wait_for_selector('#fleetBackup .backup-form')
        for width in (320, 390, 600, 768, 820, 1024, 1280, 1440, 1920):
            page.set_viewport_size({'width': width, 'height': 1000 if width > 600 else 844})
            for theme in ('jetblack', 'light', 'midnight', 'rose'):
                page.evaluate('(theme) => setTheme(theme)', theme)
                metrics = page.evaluate('''() => {
                    const cards=[...document.querySelectorAll('#serverList .srv-card')], b=e=>e.getBoundingClientRect();
                    const checks=[...document.querySelectorAll('#fleetAlerts input[type=checkbox]')];
                    return {overflow:document.documentElement.scrollWidth>innerWidth,
                        heights:cards.map(c=>Math.round(b(c).height)),
                        checkboxWidths:checks.map(c=>b(c).width), checkboxHeights:checks.map(c=>b(c).height),
                        labelTargets:checks.every(c=>c.closest('label') && b(c.closest('label')).height>=44),
                        labelLines:[...document.querySelectorAll('.alert-watch .alert-check span')].map(s=>b(s).height/parseFloat(getComputedStyle(s).lineHeight))};
                }''')
                report['layouts'].append({'width': width, 'theme': theme, **metrics})
                if not baseline:
                    assert not metrics['overflow'], (width, theme, metrics)
                    assert all(16 <= n <= 20 for n in metrics['checkboxWidths'] + metrics['checkboxHeights']), (width, theme, metrics)
                    assert metrics['labelTargets'], (width, theme, metrics)
                    assert max(metrics['labelLines']) <= (3 if width == 320 else 2), (width, theme, metrics)
                    local = page.locator('#serverList .srv-card[data-local="1"]')
                    assert local.locator('.srv-mappings summary').inner_text() == '24 webhook mappings'
                    assert not local.locator('.srv-maps').is_visible()
                    closed_heights = [c.bounding_box()['height'] for c in page.locator('#serverList .srv-card').all()]
                    # Keyboard opens the list; the list is bounded and scrollable, and other cards retain their height.
                    local.locator('.srv-mappings summary').focus()
                    page.keyboard.press('Enter')
                    assert local.locator('.srv-maps li').count() == 24
                    assert local.locator('.srv-maps').evaluate('(e) => e.clientHeight <= 385 && e.scrollHeight > e.clientHeight')
                    assert local.locator('.srv-maps button').count() == 48
                    assert [c.bounding_box()['height'] for c in page.locator('#serverList .srv-card').all()][1:] == closed_heights[1:]
                    local.locator('.srv-maps').focus()
                    page.keyboard.press('End')
                    page.wait_for_function("document.querySelector('.srv-card[data-local=\"1\"] .srv-maps').scrollTop > 0")
                    local.locator('.srv-mappings summary').focus()
                    page.keyboard.press('Enter')
                if capture and theme == 'jetblack' and width in (390, 1920):
                    page.locator('#serverList').evaluate('(e) => window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 65)')
                    page.screenshot(path=str(capture / f'servers-{width}.png'))
                    page.locator('#fleetAlerts').evaluate('(e) => window.scrollTo(0, e.getBoundingClientRect().top + scrollY - 65)')
                    page.screenshot(path=str(capture / f'alerts-{width}.png'))
        if not baseline:
            checkbox = page.get_by_label('A deployment failed', exact=True)
            before = checkbox.is_checked()
            page.get_by_text('A deployment failed', exact=True).click()
            assert checkbox.is_checked() != before
            page.get_by_label('ntfy', exact=True).check()
            assert page.locator('input[name="ntfy.enabled"]').is_checked()
            report['interactions'] = ['keyboard mapping expand/collapse', 'keyboard mapping scroll', 'mapping buttons retained', 'label toggles', 'named channel checkbox']
        assert not report['errors'], report['errors']
        print(json.dumps(report, indent=2), flush=True)
        browser.close()
    server.shutdown()
finally:
    fixture.doCleanups()

"""Password form and real authentication checks against temporary fixtures.

Run with the same environment as browser_servers.py. No production requests.
"""
import json
import os
from pathlib import Path
import re
import threading
from playwright.sync_api import sync_playwright, expect
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
    errors = []
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
        login = context.request.get(origin + '/login')
        csrf = re.search(r'name="csrf_token" value="([^"]+)"', login.text())[1]
        assert context.request.post(origin + '/login', form={'password': 'password', 'csrf_token': csrf}).ok
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin + '/#settings/account')
        page.wait_for_selector('#activeServer:not([disabled])')
        page.wait_for_function("document.getElementById('activeServerStatus').dataset.state === 'online'")
        page.locator('#st-nav-account').click()
        page.wait_for_selector('#st-account:not([hidden])')
        page.wait_for_function("document.getElementById('stDisplayName').value.length > 0")
        # Set exact values and fire input events; cached headless keyboard injection
        # can silently drop password text in minimal runner environments.
        def enter(selector, value):
            page.locator(selector).evaluate("(e, value) => { e.value = value; e.dispatchEvent(new Event('input', {bubbles:true})); }", value)
            assert page.locator(selector).input_value() == value
        current = 'password'
        for width, new in [(390, 'a'), (1440, 'ninechars'), (390, '🔐'), (1440, ' spaced ')]:
            page.set_viewport_size({'width': width, 'height': 900})
            for selector in ('#stNewPw', '#stNewPw2'):
                assert page.locator(selector).get_attribute('minlength') is None
                assert page.locator(selector).get_attribute('required') is not None
            enter('#stNewPw', new)
            enter('#stNewPw2', new + 'mismatch')
            page.locator('#stPwForm button[type=submit]').click()
            assert not errors, errors
            expect(page.locator('#stMessage')).to_have_text('The two new passwords do not match.')
            assert not page.locator('#stConfirm').is_visible()
            enter('#stNewPw2', new)
            assert page.locator('#stPwForm').evaluate('e => e.checkValidity()')
            assert 'needed' not in page.locator('#stPwHint').inner_text()
            page.locator('#stPwForm button[type=submit]').click()
            expect(page.locator('#stConfirm')).to_be_visible()
            # Wrong current credentials must still fail, even for a short new password.
            enter('#stPassword', 'wrong-current-password')
            page.locator('#stConfirmSubmit').click()
            expect(page.locator('#stConfirmError')).to_contain_text('Password incorrect')
            enter('#stPassword', current)
            page.locator('#stConfirmSubmit').click()
            expect(page.locator('#stConfirm')).not_to_be_visible()
            expect(page.locator('#stMessage')).to_have_text('Changes saved.')
            assert context.request.get(origin + '/api/settings').ok
            assert page.locator('#stNewPw').input_value() == ''
            assert page.locator('#stNewPw2').input_value() == ''
            # A different browser must authenticate using the exact new value.
            other = browser.new_context()
            response = other.request.get(origin + '/login')
            token = re.search(r'name="csrf_token" value="([^"]+)"', response.text())[1]
            result = other.request.post(origin + '/login', form={'password': new, 'csrf_token': token})
            assert result.ok and result.url.rstrip('/') == origin
            assert other.request.get(origin + '/api/settings').ok
            other.close()
            current = new
        page.locator('#stPwForm button[type=submit]').click()
        assert not page.locator('#stNewPw').evaluate('e => e.checkValidity()')
        assert not page.locator('#stConfirm').is_visible()
        assert not errors, errors
        browser.close()
        print(json.dumps({'password_changes': 4, 'widths': [390, 1440], 'empty_and_mismatch_rejected': True,
                          'current_password_required': True, 'fresh_signins': 4, 'page_errors': errors}))
    server.shutdown()
finally:
    fixture.tearDown()
    fixture.doCleanups()

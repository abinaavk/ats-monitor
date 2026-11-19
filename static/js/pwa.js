(() => {
    'use strict';
    if ('serviceWorker' in navigator && window.isSecureContext) {
        navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'}).catch(() => {});
    }
    const box = document.getElementById('pwaInstall');
    const button = document.getElementById('pwaInstallButton');
    const help = document.getElementById('pwaInstallHelp');
    const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    let prompt = null, dismissed = false;
    try { dismissed = sessionStorage.getItem('pwa-dismissed') === 'yes'; } catch (_) {}
    const show = () => { box.hidden = dismissed || standalone(); };
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) {
        button.textContent = 'Add to Home Screen';
        show();
    }
    addEventListener('beforeinstallprompt', event => {
        event.preventDefault();
        prompt = event;
        button.textContent = 'Install app';
        show();
    });
    button.addEventListener('click', async () => {
        if (!prompt) {
            help.textContent = 'Open the browser Share menu, choose Add to Home Screen, then Add. If unavailable, open this site in Safari.';
            help.hidden = false;
            return;
        }
        const pending = prompt;
        prompt = null;
        button.disabled = true;
        try { await pending.prompt(); await pending.userChoice; } catch (_) {}
        box.hidden = true;
        button.disabled = false;
    });
    addEventListener('appinstalled', () => { prompt = null; box.hidden = true; });
    document.getElementById('pwaInstallDismiss').addEventListener('click', () => {
        dismissed = true;
        box.hidden = true;
        try { sessionStorage.setItem('pwa-dismissed', 'yes'); } catch (_) {}
    });
})();

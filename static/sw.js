'use strict';
const CACHE = 'ats-offline-v1';
const OFFLINE = '/static/offline.html';
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.add(OFFLINE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ats-offline-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
    // Only document navigations receive a fallback. API traffic and writes always use the network.
    if (event.request.method !== 'GET' || event.request.mode !== 'navigate' || new URL(event.request.url).origin !== self.location.origin) return;
    event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

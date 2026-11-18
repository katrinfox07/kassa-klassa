// Сервис-воркер: приложение ставится на телефон и открывается даже при плохой связи.
const CACHE = 'kassa-v1';
const STATIC = ['/app.css', '/common.js', '/index.js', '/admin.js', '/account.js', '/icon.svg', '/icon-192.png', '/offline.html'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // данные всегда свежие
  // Сначала сеть, при отсутствии связи — сохранённая копия
  e.respondWith(fetch(req).then(res => {
    if (res.ok && (STATIC.includes(url.pathname) || url.pathname.startsWith('/uploads/') || req.mode === 'navigate')) {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('/offline.html') : Response.error()))));
});

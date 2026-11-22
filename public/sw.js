// Сервис-воркер: приложение ставится на телефон и открывается даже при плохой связи.
const CACHE = 'kassa-v14';
const STATIC = ['/app.css', '/common.js', '/index.js', '/admin.js', '/account.js', '/icon.svg', '/icon-192.png', '/offline.html'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/b/')) return; // данные всегда свежие, страницы учебников кэширует сам браузер
  // Сначала сеть, при отсутствии связи - сохранённая копия
  e.respondWith(fetch(req).then(res => {
    if (res.ok && (STATIC.includes(url.pathname) || url.pathname.startsWith('/uploads/') || req.mode === 'navigate')) {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then(r => r || (req.mode === 'navigate' ? caches.match('/offline.html') : Response.error()))));
});

// Уведомления администратору: «Иванов Петя - 5 000 ₽»
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Касса класса', body: e.data ? e.data.text() : '' }; }
  const time = d.ts ? new Date(d.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '';
  e.waitUntil(self.registration.showNotification(d.title || 'Касса класса', {
    body: (time ? time + ' · ' : '') + (d.body || ''), icon: '/icon-192.png', badge: '/icon-192.png',
    tag: 'pay-' + (d.ts || Date.now()), data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => c.url.includes(url.split('#')[0]));
    if (w) { w.navigate(url).catch(() => {}); return w.focus(); }
    return clients.openWindow(url);
  }));
});

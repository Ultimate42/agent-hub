// Service worker: lets the installed app start offline (app shell only).
// The API and the WebSocket are never cached: messages always come from the hub.
const CACHE = 'hub-app-v2';
const SHELL = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (updates show up at once), cache as fallback when offline.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/app/api/')) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

// Web Push from the hub: { title, body, thread, message_id }. One notification per thread (tag).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* keep defaults */ }
  const thread = Number(data.thread) || null;
  event.waitUntil((async () => {
    // Do not notify over an app that is already on screen (the hub may not know yet)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some(w => w.visibilityState === 'visible' && w.focused)) return;
    await self.registration.showNotification(data.title || 'Agent Hub', {
      body: data.body || 'Nouveau message',
      tag: thread ? `thread-${thread}` : 'hub',
      renotify: true,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { thread }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const thread = event.notification.data?.thread;
  const url = new URL(thread ? `./#t=${thread}` : './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) {
      await win.focus();
      if (thread) win.postMessage({ type: 'open-thread', thread });
      return;
    }
    await self.clients.openWindow(url);
  })());
});

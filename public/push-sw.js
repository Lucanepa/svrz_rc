// Phone notifications (web push, 2026-10-10), pulled into the generated
// service worker by workbox `importScripts` (vite.config.ts). The server sends
// { title, body, url, tag }; a tap opens the app at `url`, reusing a window
// that is already open.
/* eslint-disable no-restricted-globals */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'SR-Coaching';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: data.tag || undefined,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (!('focus' in client)) continue;
      await client.focus();
      if ('navigate' in client) {
        try { await client.navigate(url); } catch (err) { /* another origin: focusing is enough */ }
      }
      return;
    }
    await self.clients.openWindow(url);
  })());
});

// Kill switch for the retired lucanepa.github.io/svrz_rc/ deployment.
//
// This file replaces the Workbox service worker that used to live at this exact
// URL. Without it, every PWA a coach already installed keeps booting the old
// precached app shell from disk — offline-first means it need never ask the
// network whether the app still lives here, so those devices would quietly run
// a dead build against the API forever.
//
// The browser re-fetches a registered worker script on navigation and installs
// it when the bytes differ, which is the only hook we still have on those
// devices. Everything below runs once, then removes itself.

const NEW_APP_ORIGIN = 'https://svrz-rc.openvolley.app';

self.addEventListener('install', () => {
  // Take over from the retired worker immediately rather than waiting for every
  // tab to close — the point is to stop it serving the old build now.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop the old precache first: while it exists, the shell can still be
    // served from disk.
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.clients.claim();

    // Move anything already open, keeping the #hash — survey and signature
    // links carry their token there.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    await Promise.all(windows.map(async (client) => {
      try {
        await client.navigate(NEW_APP_ORIGIN + '/' + new URL(client.url).hash);
      } catch {
        // navigate() to another origin resolves to null in some browsers and
        // rejects in others. The fetch handler below is the fallback that works
        // everywhere, so a failure here is not worth propagating.
      }
    }));

    // Unregister last, so the redirects above still had a live registration.
    await self.registration.unregister();
  })());
});

self.addEventListener('fetch', (event) => {
  // Any navigation still routed through this worker leaves for the new domain.
  // A redirect whose target carries no fragment lets the browser keep the
  // original one, so tokenised links survive.
  if (event.request.mode === 'navigate') {
    event.respondWith(Response.redirect(NEW_APP_ORIGIN + '/', 302));
  }
});

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

// Is there feedback still queued in this origin's offline outbox? It lives in
// IndexedDB (svrz-offline / feedback-outbox) and cannot cross to the new origin,
// so if the coach has unsent observations we must NOT wipe caches, unregister,
// or force-redirect — that would take the outbox's last chance to flush with it.
// The landing page (legacy/index.html) shows the coach a warning in that case.
function pendingOutboxCount() {
  return new Promise((resolve) => {
    if (!self.indexedDB) { resolve(0); return; }
    let settled = false;
    const done = (n) => { if (!settled) { settled = true; resolve(n); } };
    try {
      const open = indexedDB.open('svrz-offline');
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('feedback-outbox')) { db.close(); done(0); return; }
        try {
          const req = db.transaction('feedback-outbox', 'readonly').objectStore('feedback-outbox').count();
          req.onsuccess = () => { done(req.result || 0); db.close(); };
          req.onerror = () => { done(0); db.close(); };
        } catch (e) { done(0); db.close(); }
      };
      open.onerror = () => done(0);
      setTimeout(() => done(0), 1200);
    } catch (e) { done(0); }
  });
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();

    // Hold the teardown while unsent work exists. The old build keeps running
    // for now — the point is not to destroy a coach's queued observation.
    if (await pendingOutboxCount() > 0) return;

    // Drop the old precache first: while it exists, the shell can still be
    // served from disk.
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));

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
  // Any navigation still routed through this worker leaves for the new domain —
  // UNLESS unsent feedback is queued here, in which case it falls through to the
  // network so the retirement page's warning is shown instead of bouncing the
  // coach past it to an origin their outbox can't follow. A redirect whose
  // target carries no fragment lets the browser keep the original one, so
  // tokenised survey/signature links survive.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      pendingOutboxCount().then((n) =>
        n > 0 ? fetch(event.request) : Response.redirect(NEW_APP_ORIGIN + '/', 302),
      ).catch(() => Response.redirect(NEW_APP_ORIGIN + '/', 302)),
    );
  }
});

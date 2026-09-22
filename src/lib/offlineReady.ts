// The Offline-Ready check: does THIS device hold everything an observation
// needs once the gym has no signal?
//
// The app has opened offline from the service worker's precache, and its data
// from the 'svrz-api-get' cache, since the first PWA build — but nothing ever
// verified that on a given phone those caches hold what a given coach is about
// to need. A coach who signed in on a fresh device an hour before the match,
// opened the games list and nothing else, walks into the gym with a shell that
// loads and a form that cannot fetch its coachees, cannot build its PDF (the
// report builder is a lazy chunk) and — on a browser that evicted the origin —
// cannot even keep a draft. Every one of those failures used to surface only
// at the moment it was too late to fix.
//
// So this runs when a form opens: it probes each thing the form depends on,
// warms what is missing while there is still a network, and reports in one
// line whether the observation can be finished and sent without one. It is
// pure and browser-only, and it never throws: an API that is absent or that
// refuses (private mode, an http:// origin, a sandboxed webview) is a failed
// item, never an exception into the form.

import { draftStoreAvailable } from './formDraft';

export type OfflineCheckKey = 'sw' | 'shell' | 'pdf' | 'api' | 'store' | 'persist' | 'quota';

/** One probe's verdict, with `label` and `detail` already in the requested
 *  language. `must` says whether a failure blocks working offline at all, or
 *  is merely worth knowing about. */
export type OfflineCheckItem = {
  key: OfflineCheckKey;
  ok: boolean;
  must: boolean;
  label: string;
  detail?: string;
};

/** `ok` is true when every `must` item passed; the optional ones only colour
 *  the detail panel. */
export type OfflineReport = { ok: boolean; items: OfflineCheckItem[]; missingMust: number };

export type OfflineApiUrl = { url: string; must: boolean; label: string };

export type OfflineCheckOptions = {
  lang: 'DE' | 'EN';
  /** The API reads the form (and the app around it) will ask for offline, as
   *  the app itself requests them — the cache is keyed by the exact URL. */
  apiUrls: OfflineApiUrl[];
  /** Fetch what is missing while online, and ask for persistent storage. Off
   *  for a read-only probe (tests, a status line that must not touch the net). */
  warm: boolean;
  /** The lazy report chunk: resolving it proves it can be loaded, and keeps it
   *  in memory for the life of this page. */
  loadPdf: () => Promise<unknown>;
};

/** The cache the workbox NetworkFirst rule in vite.config.ts writes API GETs to. */
export const API_CACHE_NAME = 'svrz-api-get';
/** Below this much free space a form with two signatures may not commit its
 *  draft, and the outbox may not take the submission. */
export const QUOTA_MIN_FREE_BYTES = 10 * 1024 * 1024;
/** How long a warm-up waits for the worker to store what it fetched: this
 *  many looks at the cache, this far apart. Half a second in all — the write
 *  is deferred by a task and the body's length, not by the network. */
export const WARM_MATCH_ATTEMPTS = 5;
export const WARM_MATCH_DELAY_MS = 100;

const STRINGS = {
  DE: {
    sw: 'Service Worker',
    swUnsupported: 'Dieser Browser kann die App nicht offline halten',
    swNotInstalled: 'Nicht installiert',
    swNoController: 'Seite einmal neu laden',
    shell: 'App-Dateien',
    shellNoCache: 'Noch nicht gespeichert',
    shellEmpty: 'Speicher ist leer',
    shellNoPdf: 'PDF-Modul fehlt — App aktualisieren',
    pdf: 'PDF-Erzeugung',
    pdfFailed: 'Modul konnte nicht geladen werden',
    api: 'Daten',
    apiMissing: 'Fehlt: ',
    apiNoCache: 'Kein Datenspeicher',
    store: 'Entwurfsspeicher',
    storeMissing: 'Nicht verfügbar (privater Modus?)',
    persist: 'Speicher dauerhaft',
    persistNo: 'Der Browser darf den Speicher bei Platzmangel leeren',
    quota: 'Freier Speicher',
    quotaFree: (mb: number) => `${mb} MB frei`,
    quotaUnknown: 'unbekannt',
  },
  EN: {
    sw: 'Service worker',
    swUnsupported: 'This browser cannot keep the app offline',
    swNotInstalled: 'Not installed',
    swNoController: 'Reload the page once',
    shell: 'App files',
    shellNoCache: 'Not stored yet',
    shellEmpty: 'Store is empty',
    shellNoPdf: 'PDF module missing — update the app',
    pdf: 'PDF builder',
    pdfFailed: 'Module could not be loaded',
    api: 'Data',
    apiMissing: 'Missing: ',
    apiNoCache: 'No data cache',
    store: 'Draft store',
    storeMissing: 'Unavailable (private mode?)',
    persist: 'Storage persistent',
    persistNo: 'The browser may clear storage when space runs low',
    quota: 'Free storage',
    quotaFree: (mb: number) => `${mb} MB free`,
    quotaUnknown: 'unknown',
  },
};

type Strings = typeof STRINGS.DE;

/** A probe's promise, with any throw turned into `fallback`. Cache Storage and
 *  navigator.storage throw on the mere access in some private modes, and a
 *  probe that throws would take the whole report — and the form — with it. */
async function guarded<T>(probe: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await probe();
  } catch {
    return fallback;
  }
}

/** How long to wait for a worker that is registered but has not taken the page
 *  yet. `clientsClaim` runs on activation, which is asynchronous and easily
 *  later than this check — a fresh install would otherwise be reported as
 *  "reload the page once" to a coach who just did. */
const SW_CONTROL_WAIT_MS = 2000;

/** Resolves true as soon as a worker controls this page, false on timeout. */
function controlledSoon(ms: number): Promise<boolean> {
  if (navigator.serviceWorker.controller) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onChange);
      resolve(ok);
    };
    const onChange = () => finish(true);
    navigator.serviceWorker.addEventListener('controllerchange', onChange);
    setTimeout(() => finish(!!navigator.serviceWorker.controller), ms);
  });
}

async function checkServiceWorker(s: Strings): Promise<OfflineCheckItem> {
  const item = (ok: boolean, detail?: string): OfflineCheckItem => ({ key: 'sw', ok, must: true, label: s.sw, detail });
  return guarded(async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return item(false, s.swUnsupported);
    // Controlled is what counts, not registered: a worker that installed a
    // moment ago answers nothing until the next load, and a page it does not
    // control fetches straight from the network — which offline is not there.
    if (navigator.serviceWorker.controller) return item(true);
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return item(false, s.swNotInstalled);
    // Registered, so the only question left is whether it has claimed this
    // page yet. Waited for rather than answered at once, because the honest
    // answer two seconds from now is worth more than a wrong one today.
    if (await controlledSoon(SW_CONTROL_WAIT_MS)) return item(true);
    return item(false, s.swNoController);
  }, item(false, s.swUnsupported));
}

async function checkShell(s: Strings): Promise<OfflineCheckItem> {
  const item = (ok: boolean, detail?: string): OfflineCheckItem => ({ key: 'shell', ok, must: true, label: s.shell, detail });
  return guarded(async () => {
    if (typeof caches === 'undefined') return item(false, s.shellNoCache);
    const names = await caches.keys();
    const precache = names.find((n) => n.startsWith('workbox-precache'));
    if (!precache) return item(false, s.shellNoCache);
    const entries = await (await caches.open(precache)).keys();
    if (entries.length === 0) return item(false, s.shellEmpty);
    // The report builder is a lazy chunk, and it is in the precache glob on
    // purpose (vite.config.ts): a form that fills in offline and then cannot
    // render its PDF is the failure this whole check exists to catch.
    if (!entries.some((r) => /feedbackPdf/.test(r.url))) return item(false, s.shellNoPdf);
    return item(true);
  }, item(false, s.shellNoCache));
}

async function checkPdf(s: Strings, loadPdf: () => Promise<unknown>): Promise<OfflineCheckItem> {
  const item = (ok: boolean, detail?: string): OfflineCheckItem => ({ key: 'pdf', ok, must: true, label: s.pdf, detail });
  return guarded(async () => {
    await loadPdf();
    return item(true);
  }, item(false, s.pdfFailed));
}

/** cache.match, asked up to `attempts` times a short pause apart, for an entry
 *  a fetch has just put on its way. The worker hands the response to the page
 *  first and stores it afterwards — workbox's NetworkFirst defers the write by
 *  a task and then reads the whole body before it commits — so a single look
 *  right after the fetch resolved found nothing, and the run reported as
 *  missing the very URL it had just warmed; "Erneut prüfen" then turned green
 *  with nothing on the network changed. */
async function matchSoon(cache: Cache, url: string, attempts: number): Promise<Response | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, WARM_MATCH_DELAY_MS));
    // ignoreVary on both sides: the rule stores with it, and a match without
    // it fails on every response that carries `Vary: Cookie`.
    const hit = await guarded(() => cache.match(url, { ignoreVary: true }), undefined);
    if (hit) return hit;
  }
  return undefined;
}

async function checkApi(s: Strings, apiUrls: OfflineApiUrl[], warm: boolean): Promise<OfflineCheckItem> {
  const missing: OfflineApiUrl[] = [];
  const noCache = await guarded(async () => {
    if (typeof caches === 'undefined') return true;
    const cache = await caches.open(API_CACHE_NAME);
    for (const entry of apiUrls) {
      if (await matchSoon(cache, entry.url, 1)) continue;
      if (warm && typeof navigator !== 'undefined' && navigator.onLine) {
        // Through the page's fetch, which the service worker sees and, on a
        // 200, stores under this same URL. No cache write here: the rule owns
        // the cache, and its expiration plugin would not know about an entry
        // written behind its back.
        const res = await guarded(() => fetch(entry.url, { credentials: 'include' }), undefined);
        // Drained, so the worker's copy of the body is complete before the
        // cache is asked again; the page never reads these bodies otherwise.
        if (res) await guarded(() => res.arrayBuffer(), undefined);
        // Waited for only on a page a worker controls. Without one the fetch
        // went straight to the network and nothing will ever land in the
        // cache — one look is the truth, and half a second per URL of waiting
        // for it would only delay "Seite einmal neu laden".
        const controlled = !!navigator.serviceWorker?.controller;
        if (await matchSoon(cache, entry.url, controlled ? WARM_MATCH_ATTEMPTS : 1)) continue;
      }
      missing.push(entry);
    }
    return false;
  }, true);
  if (noCache) return { key: 'api', ok: false, must: apiUrls.some((u) => u.must), label: s.api, detail: s.apiNoCache };
  if (missing.length === 0) return { key: 'api', ok: true, must: true, label: s.api };
  // One row for all of them, and it only BLOCKS when something the form itself
  // reads is missing — a home dashboard that cannot refresh offline is not a
  // reason to tell a coach the observation cannot be filed.
  return {
    key: 'api',
    ok: false,
    must: missing.some((u) => u.must),
    label: s.api,
    detail: s.apiMissing + missing.map((u) => u.label).join(', '),
  };
}

async function checkStore(s: Strings): Promise<OfflineCheckItem> {
  const ok = await guarded(() => draftStoreAvailable(), false);
  return { key: 'store', ok, must: true, label: s.store, detail: ok ? undefined : s.storeMissing };
}

async function checkPersist(s: Strings, warm: boolean): Promise<OfflineCheckItem> {
  const item = (ok: boolean): OfflineCheckItem => ({ key: 'persist', ok, must: false, label: s.persist, detail: ok ? undefined : s.persistNo });
  return guarded(async () => {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || !storage.persisted) return item(false);
    if (await storage.persisted()) return item(true);
    // Asked again here even though formDraft asks once on boot: that request
    // is fire-and-forget, and a browser that refused it silently for a tab may
    // grant it for an installed app later.
    if (warm && storage.persist && await storage.persist()) return item(true);
    return item(false);
  }, item(false));
}

async function checkQuota(s: Strings): Promise<OfflineCheckItem> {
  const item = (ok: boolean, must: boolean, detail: string): OfflineCheckItem => ({ key: 'quota', ok, must, label: s.quota, detail });
  return guarded(async () => {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!storage || !storage.estimate) return item(true, false, s.quotaUnknown);
    const { quota, usage } = await storage.estimate();
    if (typeof quota !== 'number' || typeof usage !== 'number') return item(true, false, s.quotaUnknown);
    const free = Math.max(0, quota - usage);
    const ok = free >= QUOTA_MIN_FREE_BYTES;
    // must only when it FAILS: a device with room is not an obligation.
    return item(ok, !ok, s.quotaFree(Math.floor(free / (1024 * 1024))));
  }, item(true, false, s.quotaUnknown));
}

/**
 * Run every probe and fold them into one report. Sequential rather than
 * parallel: the API warm-up is the one that costs anything, and it must not
 * race a page that is itself loading the same endpoints.
 */
export async function runOfflineCheck(opts: OfflineCheckOptions): Promise<OfflineReport> {
  const s = STRINGS[opts.lang] || STRINGS.DE;
  const items: OfflineCheckItem[] = [
    await checkServiceWorker(s),
    await checkShell(s),
    await checkPdf(s, opts.loadPdf),
    await checkApi(s, opts.apiUrls, opts.warm),
    await checkStore(s),
    await checkPersist(s, opts.warm),
    await checkQuota(s),
  ];
  const missingMust = items.filter((i) => i.must && !i.ok).length;
  return { ok: missingMust === 0, items, missingMust };
}

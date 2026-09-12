// The document shelf: where a PDF's bytes come from, and where they stay.
//
// A coach opens the rulebook in a gym with one bar of signal, and opens it
// again next week in a different gym. So the first read is a download and
// every read after it is a cache hit — Cache Storage, keyed by the URL, kept
// until the browser evicts it or the coach clears it here.
//
// It is deliberately NOT the service worker's precache: 13 MB of rulebooks in
// the install step would make every deploy a 13 MB download before the app is
// usable, for the many coaches who only ever file observations. What is cheap
// (the SVRZ letters, sheets and regulations, about 3 MB together) is fetched
// once the app is idle; what is not (the two rulebooks, the Swiss Volley
// regulation and the conference slides, 16 MB) waits for someone to ask.

import { apiUrl } from './pocketbase';
import { isDemoMode } from './demo';
import type { UsefulDoc } from './usefulDocs';
import { USEFUL_DOCS } from './usefulDocs';

const CACHE = 'svrz-docs-v1';
/** Anything at or below this joins the idle prefetch; the rulebooks do not. */
const PREFETCH_MAX_BYTES = 600_000;

/**
 * Where the reader reads a document from, or '' when it cannot read it in-app.
 *
 * The demo runs without a backend by design, so a document that would need the
 * API proxy stays a plain link there — our own files under `docs/` are static
 * and read in the demo like anywhere else.
 */
export function docSourceUrl(doc: UsefulDoc): string {
  if (doc.path) return `${import.meta.env.BASE_URL}${doc.path}`;
  if (doc.proxyId && !isDemoMode()) return apiUrl(`/api/docs/${doc.proxyId}`);
  return '';
}

/** The link the reader offers as "open the original", and the card's fallback. */
export function docLinkUrl(doc: UsefulDoc): string {
  return /^(https?|mailto):/i.test(doc.href)
    ? doc.href
    : `${import.meta.env.BASE_URL}${doc.href}`;
}

async function openCache(): Promise<Cache | null> {
  // Private windows, http:// origins and browsers with site data blocked all
  // throw here rather than returning nothing.
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE);
  } catch {
    return null;
  }
}

export async function isDocStored(url: string): Promise<boolean> {
  if (!url) return false;
  const cache = await openCache();
  if (!cache) return false;
  try {
    return Boolean(await cache.match(url));
  } catch {
    return false;
  }
}

/**
 * The document's bytes, from the cache when they are there.
 *
 * `onProgress` is called with 0..1 while downloading, and never for a cache
 * hit — the reader shows a bar only when there is really something to wait for.
 */
export async function fetchDocBytes(
  url: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const cache = await openCache();
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) return await hit.arrayBuffer();
    } catch { /* fall through to the network */ }
  }

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status}`);

  // Read the stream so the download can be shown, but only when the server
  // said how long it is — a progress bar that cannot reach the end is worse
  // than a spinner.
  const total = Number(response.headers.get('content-length') || 0);
  let bytes: ArrayBuffer;
  if (total > 0 && response.body && onProgress) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress(Math.min(1, received / total));
    }
    const joined = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
    bytes = joined.buffer;
  } else {
    bytes = await response.arrayBuffer();
  }

  if (cache) {
    try {
      await cache.put(url, new Response(bytes.slice(0), {
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength) },
      }));
    } catch { /* over quota, or no storage: the read still worked */ }
  }
  return bytes;
}

/** Every document the reader can open, with what it would cost to keep. */
export function storableDocs(): { doc: UsefulDoc; url: string }[] {
  return USEFUL_DOCS
    .map((doc) => ({ doc, url: docSourceUrl(doc) }))
    .filter((entry) => Boolean(entry.url));
}

export async function storedState(): Promise<{ stored: number; total: number; missingBytes: number }> {
  const entries = storableDocs();
  let stored = 0;
  let missingBytes = 0;
  for (const entry of entries) {
    if (await isDocStored(entry.url)) stored += 1;
    else missingBytes += entry.doc.bytes || 0;
  }
  return { stored, total: entries.length, missingBytes };
}

/** Downloads whatever is not stored yet, reporting how many are done. */
export async function storeAllDocs(onProgress?: (done: number, total: number) => void): Promise<void> {
  const entries = storableDocs();
  let done = 0;
  for (const entry of entries) {
    try {
      if (!(await isDocStored(entry.url))) await fetchDocBytes(entry.url);
    } catch { /* one unreachable document must not stop the rest */ }
    done += 1;
    onProgress?.(done, entries.length);
  }
}

export async function clearStoredDocs(): Promise<void> {
  try { await caches.delete(CACHE); } catch { /* nothing to clear */ }
}

/**
 * Once the app has settled, quietly keep the small documents.
 *
 * Skipped on a metered or slow connection, and on a phone that asked for data
 * saving — the whole point is that nobody notices this happening.
 */
let prefetchStarted = false;

export function prefetchSmallDocs(): void {
  // Once per page load: React remounts this in development, and a second pass
  // would race the first over the same files before either has finished.
  if (prefetchStarted) return;
  prefetchStarted = true;
  const conn = (navigator as unknown as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return;
  if (conn?.effectiveType && /(^|-)2g$/.test(conn.effectiveType)) return;

  const run = () => {
    void (async () => {
      for (const { doc, url } of storableDocs()) {
        if ((doc.bytes || 0) > PREFETCH_MAX_BYTES) continue;
        try {
          if (!(await isDocStored(url))) await fetchDocBytes(url);
        } catch { /* offline, or the proxy is down: try again next launch */ }
      }
    })();
  };

  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(run, { timeout: 15_000 });
  else window.setTimeout(run, 8_000);
}

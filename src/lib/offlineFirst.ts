// The stored copy first, once the network is known to be gone.
//
// Every API read is network-first: the service worker (or, in the installed
// app, lib/native.ts) waits up to 6 s for the server and only then answers
// from its cache. That is right while the network might still answer. It is
// six seconds of nothing per tap once it is plain that it will not: on
// 26.10.2026, in a garage with zero bars, every screen of the app waited out
// the timeout again. Once the connection tracker says the network is gone —
// offline, unreachable, or the last answer already came from the cache — a
// read that has a stored copy gets it at once. The real request still goes
// out behind it: it refreshes the copy, and its answer is how the tracker
// learns the network is back.
//
// And the copy has to be there: Home downloads every filed observation in its
// list while it still has a network (warmFiledObservations), so a tap on one
// in the gym opens it from the device.

import { connection, isApiRequest, type ConnectionState } from './connection';
import { IS_NATIVE, isCacheableApiPath, readCachedApi } from './native';
import { API_CACHE_NAME } from './offlineReady';

/** Whether the tracker already knows the server is not answering. */
export function isNetworkDown(state: ConnectionState): boolean {
  return state === 'offline' || state === 'unreachable' || state === 'stale';
}

/** The stored answer to this GET, if the device has one. Never throws. */
export async function readStoredApi(url: string): Promise<Response | undefined> {
  try {
    if (IS_NATIVE) {
      const hit = await readCachedApi(url);
      return hit ? new Response(hit.body.slice(0), {
        status: hit.status,
        headers: { 'Content-Type': hit.contentType, 'X-Svrz-From-Cache': '1' },
      }) : undefined;
    }
    if (typeof caches === 'undefined') return undefined;
    const cache = await caches.open(API_CACHE_NAME);
    // ignoreVary: the API answers with Vary (Origin, the language), and a
    // lookup by bare URL carries neither header.
    return (await cache.match(url, { ignoreVary: true })) ?? undefined;
  } catch {
    return undefined;
  }
}

let installed = false;

/** Wraps fetch outermost — around the logger, so the background refresh is
 *  logged and timed like any other request and still tells the tracker. */
export function installOfflineFirst(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const inner = window.fetch.bind(window);
  window.fetch = async function offlineFirstFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (method !== 'GET' || !isApiRequest(url) || !isNetworkDown(connection.get())) return inner(input, init);
    let pathname = '';
    try { pathname = new URL(url, location.href).pathname; } catch { return inner(input, init); }
    if (!isCacheableApiPath(pathname)) return inner(input, init);
    const stored = await readStoredApi(new URL(url, location.href).href);
    if (!stored) return inner(input, init);
    connection.noteCacheHit(url);
    // Refresh behind the stored answer; nobody waits on it.
    inner(input, init).catch(() => {});
    return stored;
  };
}

/** When each coachee's filed list was last downloaded, and which records it
 *  held — a list is fetched again when a record was added or after a while. */
const warmed = new Map<string, { at: number; ids: string }>();
const WARM_AGAIN_AFTER_MS = 10 * 60 * 1000;

/** Download each listed coachee's filed observations while there is a
 *  network, so the offline cache holds them before the gym. Two at a time,
 *  quietly: a failure only means that one is not on the device yet. */
export async function warmFiledObservations(
  rows: { coacheeId: string; feedbackId?: string }[],
  load: (coacheeId: string) => Promise<unknown>,
): Promise<void> {
  if (isNetworkDown(connection.get())) return;
  const byCoachee = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.coacheeId) continue;
    const ids = byCoachee.get(r.coacheeId) ?? [];
    if (r.feedbackId) ids.push(r.feedbackId);
    byCoachee.set(r.coacheeId, ids);
  }
  const now = Date.now();
  const todo = [...byCoachee].map(([id, ids]) => ({ id, ids: ids.sort().join(',') })).filter(({ id, ids }) => {
    const seen = warmed.get(id);
    return !seen || seen.ids !== ids || now - seen.at > WARM_AGAIN_AFTER_MS;
  });
  const next = async (): Promise<void> => {
    const item = todo.shift();
    if (!item || isNetworkDown(connection.get())) return;
    try {
      await load(item.id);
      warmed.set(item.id, { at: Date.now(), ids: item.ids });
    } catch { /* not on the device yet; the next Home load tries again */ }
    return next();
  };
  await Promise.all([next(), next()]);
}

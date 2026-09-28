// What the network is doing, in words a coach can act on.
//
// On 28.09.2026 a coach's phone took exactly six seconds over every request:
// the network never answered, the service worker gave up at its 6 s timeout
// and handed back yesterday's cached copy, and the login probe — also on a 6 s
// timer — flashed the login screen first. Nothing on screen said "your
// network"; from the outside it looked like the app was broken. This module
// watches the API requests the app makes and says which of these it is:
//
//   offline      the device itself says it has no network
//   slow         an API read has been waiting longer than SLOW_AFTER_MS
//   stale        the last answer came from the offline cache, not the server
//   unreachable  a request got no response at all while the device is online
//
// A server that answers — any status, 500 included — is a reachable server:
// its errors are the app's to explain, not the network's.
//
// Fed from the one fetch wrapper (logger.ts) and from the service worker's
// "served from cache" broadcast (vite.config.ts); read by ConnectionBanner.

export type ConnectionState = 'ok' | 'slow' | 'stale' | 'unreachable' | 'offline';

/** How long an API read may wait before the banner says the network is slow.
 *  Half the service worker's 6 s cache timeout, so the coach is told while it
 *  is happening, not after. */
export const SLOW_AFTER_MS = 3000;

/** The service worker's NetworkFirst timeout (vite.config.ts,
 *  networkTimeoutSeconds). A 200 that took this long was the cache's answer
 *  even when the broadcast below did not arrive (no BroadcastChannel). */
export const SW_CACHE_TIMEOUT_MS = 6000;

/** The channel the service worker names every URL it answered from cache on. */
export const SW_CACHE_CHANNEL = 'svrz-sw-cache';

/** Reads that are slow because of the work behind them, not the network: the
 *  console, the filed-forms database and its ZIPs, the 7 MB rule PDFs. Timing
 *  those would call the network slow for building a ZIP. */
const NOT_TIMED = /\/api\/(admin(\/|$)|forms(\/|$)|feedback-archive|docs\/)|\/(file|export)(\?|$)|\.(zip|pdf)(\?|$)/;

type Outcome = 'ok' | 'stale' | 'unreachable';

/** The request's URL as the service worker sees it, so the two can be matched. */
export function normalizeUrl(url: string, base = typeof location !== 'undefined' ? location.href : 'http://localhost/'): string {
  try { return new URL(url, base).href; } catch { return url; }
}

/** Whether a request is one of the app's own API calls, and so tells us about
 *  the path between this device and our server. */
export function isApiRequest(url: string): boolean {
  return /\/api\//.test(url) && !/\/api\/(client-logs|events)(\?|$)/.test(url);
}

/** Whether a pending request of this kind should start the "slow" clock. */
export function isTimedRead(method: string, url: string): boolean {
  return method === 'GET' && isApiRequest(url) && !NOT_TIMED.test(url);
}

/** Priority, most urgent first. A read pending right now is fresher news than
 *  how the last one ended, so "slow" outranks "unreachable" while a retry is
 *  in flight. */
export function deriveState(online: boolean, slowPending: number, last: Outcome): ConnectionState {
  if (!online) return 'offline';
  if (slowPending > 0) return 'slow';
  if (last === 'unreachable') return 'unreachable';
  if (last === 'stale') return 'stale';
  return 'ok';
}

/** The browser's own text for a fetch that got no response — what a caught
 *  error's message says when the network, not the server, failed. */
export function isNoResponseMessage(message: string): boolean {
  return /^(TypeError:\s*)?(failed to fetch|load failed|networkerror when attempting to fetch resource\.?|network request failed|the network connection was lost\.?|the internet connection appears to be offline\.?)$/i.test(message.trim());
}

type Timer = ReturnType<typeof setTimeout>;

export class ConnectionTracker {
  private online: boolean;
  private slowPending = 0;
  private last: Outcome = 'ok';
  /** URL → when the service worker last said it answered it from cache. */
  private cacheHits = new Map<string, number>();
  private listeners = new Set<() => void>();
  private state: ConnectionState;

  constructor(online = true, private now: () => number = () => Date.now()) {
    this.online = online;
    this.state = deriveState(this.online, 0, this.last);
  }

  get(): ConnectionState { return this.state; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  setOnline(online: boolean): void {
    this.online = online;
    // Back on a network: whatever the last request said is about the old one.
    if (online) this.last = 'ok';
    this.emit();
  }

  /** The service worker answered this URL from its cache. */
  noteCacheHit(url: string): void {
    this.cacheHits.set(normalizeUrl(url), this.now());
    this.last = 'stale';
    this.emit();
  }

  /** Call when a request starts; the returned functions settle it. */
  start(method: string, url: string): { answered: (ms: number) => void; failed: () => void; dropped: () => void } {
    const api = isApiRequest(url);
    const key = normalizeUrl(url);
    const startedAt = this.now();
    let slowTimer: Timer | null = null;
    let slow = false;
    if (api && isTimedRead(method, url)) {
      slowTimer = setTimeout(() => { slow = true; this.slowPending++; this.emit(); }, SLOW_AFTER_MS);
    }
    const end = () => {
      if (slowTimer) clearTimeout(slowTimer);
      if (slow) { this.slowPending--; slow = false; }
    };
    return {
      answered: (ms: number) => {
        end();
        if (!api) { this.emit(); return; }
        // The broadcast and the response race each other into the page, so
        // look again a moment later before calling this a live answer.
        setTimeout(() => {
          const hit = this.cacheHits.get(key);
          const fromCache = (hit !== undefined && hit >= startedAt)
            || (method === 'GET' && ms >= SW_CACHE_TIMEOUT_MS - 100 && ms < SW_CACHE_TIMEOUT_MS + 1500);
          this.last = fromCache ? 'stale' : 'ok';
          this.emit();
        }, 150);
      },
      failed: () => {
        end();
        if (api) this.last = 'unreachable';
        this.emit();
      },
      // Cancelled by the app, or by the page going away: says nothing about
      // the network, so it only stops the clock.
      dropped: () => { end(); this.emit(); },
    };
  }

  private emit(): void {
    const next = deriveState(this.online, this.slowPending, this.last);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

export const connection = new ConnectionTracker(typeof navigator === 'undefined' ? true : navigator.onLine !== false);

let installed = false;
/** Online/offline events and the service worker's cache broadcast. */
export function installConnectionWatch(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('online', () => connection.setOnline(true));
  window.addEventListener('offline', () => connection.setOnline(false));
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const channel = new BroadcastChannel(SW_CACHE_CHANNEL);
      channel.onmessage = (e: MessageEvent) => {
        const url = (e.data as { url?: unknown } | null)?.url;
        if (typeof url === 'string') connection.noteCacheHit(url);
      };
    } catch { /* the timing fallback in answered() still catches it */ }
  }
}

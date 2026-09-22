// The installed app (Tauri) — everything that differs from the PWA lives here.
//
// A native build runs from `tauri://localhost` (macOS, iOS, Linux) or
// `http://tauri.localhost` (Windows, Android). Two things the PWA leans on do
// not survive that move:
//
// 1. The session cookie. Every native origin is a different site from the API,
//    so the cookie is third-party — Safari's engine drops it outright, and with
//    SameSite=Lax nobody sends it at all. The native app keeps the session
//    tokens itself (the "jar") and sends them in a header; the API reads that
//    header as if it were the Cookie line and answers new tokens in
//    `X-Svrz-Set-Session` instead of Set-Cookie (see the native middleware in
//    server/index.ts). The jar lives in the webview's localStorage, which in an
//    installed app is a file in the app's own data folder: no browser clean-up
//    reaches it, which is what ends the phone that signed its coach out every
//    few days.
//
// 2. The service worker. It does not run on those origins, and with it went the
//    `svrz-api-get` NetworkFirst cache that let the app read its data offline.
//    The app files are bundled into the binary, so the precache is not needed;
//    the API reads are cached here instead, in IndexedDB, with the same rule:
//    network first with a 6 s timeout, the last good copy when there is none.
//
// Everything is installed as one wrapper around window.fetch, before the logger
// patches fetch itself — so the 90-odd call sites in pocketbase.ts, the log
// shipper, the document shelf and the offline check all go through it unchanged.

// Spelled out in full so Vite substitutes it at build time (`import.meta.env?.`
// is not matched and was silently false in the installed app); the typeof
// guard is for the rule specs, which import this module under Node, where
// import.meta.env does not exist.
export const IS_NATIVE = typeof import.meta.env !== 'undefined' && import.meta.env.VITE_NATIVE === '1';
/** The installed app's version (package.json at build time), '' on the web. */
export const NATIVE_VERSION = IS_NATIVE ? __APP_VERSION__ : '';

/** The session cookies the API lets a native client carry itself. Nothing else
 *  is kept or sent, whatever the API answers. */
const JAR_NAMES = new Set(['svrz_rc_session', 'svrz_admin_session']);
const JAR_KEY = 'svrz-native-jar';

type JarEntry = { value: string; expiresAt: number };
type Jar = Record<string, JarEntry>;

function readJar(): Jar {
  try {
    const parsed = JSON.parse(localStorage.getItem(JAR_KEY) || '{}') as Jar;
    const now = Date.now();
    const live: Jar = {};
    for (const [name, entry] of Object.entries(parsed)) {
      if (JAR_NAMES.has(name) && entry?.value && entry.expiresAt > now) live[name] = entry;
    }
    return live;
  } catch {
    return {};
  }
}

function writeJar(jar: Jar): void {
  try { localStorage.setItem(JAR_KEY, JSON.stringify(jar)); } catch { /* storage refused: the session lasts this run */ }
}

/** The jar as a Cookie line, the shape the API already parses. */
export function jarHeader(): string {
  return Object.entries(readJar()).map(([name, e]) => `${name}=${encodeURIComponent(e.value)}`).join('; ');
}

/** Apply one `X-Svrz-Set-Session` answer: a JSON array of the cookies the API
 *  set on this response. An empty value or a zero max-age is a sign-out. */
export function applySetSession(header: string | null): void {
  if (!header) return;
  let updates: { name?: unknown; value?: unknown; maxAge?: unknown }[];
  try { updates = JSON.parse(header); } catch { return; }
  if (!Array.isArray(updates)) return;
  const jar = readJar();
  for (const u of updates) {
    const name = typeof u.name === 'string' ? u.name : '';
    if (!JAR_NAMES.has(name)) continue;
    const value = typeof u.value === 'string' ? u.value : '';
    const maxAge = Number(u.maxAge);
    if (!value || (Number.isFinite(maxAge) && maxAge <= 0)) {
      delete jar[name];
    } else {
      // No max-age means a session cookie: kept for a day, the server's own
      // expiry inside the token still decides.
      jar[name] = { value, expiresAt: Date.now() + (Number.isFinite(maxAge) ? maxAge : 86_400_000) };
    }
  }
  writeJar(jar);
}

// ── Offline read cache ────────────────────────────────────────────────

const DB_NAME = 'svrz-native';
const STORE = 'api-get';
/** Same bounds as the Workbox rule this replaces (vite.config.ts). */
const MAX_ENTRIES = 300;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const NETWORK_TIMEOUT_MS = 6_000;

type CachedResponse = {
  url: string;
  status: number;
  contentType: string;
  body: ArrayBuffer;
  storedAt: number;
};

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'url' }).createIndex('storedAt', 'storedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then((db) => new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/** Whether a GET of this API path is kept for offline. Mirrors the Workbox
 *  rule: never the live stream, never the document proxy (the shelf keeps
 *  those), never the notebook (served from its own store), never the logs. */
export function isCacheableApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/')
    && pathname !== '/api/events'
    && !pathname.startsWith('/api/docs/')
    && !pathname.startsWith('/api/notebook')
    && !pathname.startsWith('/api/client-logs')
    && !pathname.startsWith('/api/admin/logs')
    && !pathname.startsWith('/api/admin/error-logs');
}

export async function readCachedApi(url: string): Promise<CachedResponse | undefined> {
  try {
    const hit = await idb<CachedResponse>('readonly', (s) => s.get(url));
    if (!hit || Date.now() - hit.storedAt > MAX_AGE_MS) return undefined;
    return hit;
  } catch {
    return undefined;
  }
}

async function storeApi(url: string, res: Response): Promise<void> {
  try {
    const body = await res.arrayBuffer();
    await idb('readwrite', (s) => s.put({
      url, status: res.status, contentType: res.headers.get('content-type') || '', body, storedAt: Date.now(),
    } satisfies CachedResponse));
    await pruneApiCache();
  } catch { /* a full or refused store costs the offline copy, never the answer */ }
}

async function pruneApiCache(): Promise<void> {
  const keys = await idb<IDBValidKey[]>('readonly', (s) => s.index('storedAt').getAllKeys());
  if (!keys || keys.length <= MAX_ENTRIES) return;
  const drop = keys.slice(0, keys.length - MAX_ENTRIES); // oldest first
  await idb('readwrite', (s) => { for (const k of drop) s.delete(k); });
}

export async function clearNativeApiCache(): Promise<void> {
  try { await idb('readwrite', (s) => s.clear()); } catch { /* nothing to clear */ }
}

function fromCache(hit: CachedResponse): Response {
  return new Response(hit.body.slice(0), {
    status: hit.status,
    headers: { 'Content-Type': hit.contentType, 'X-Svrz-From-Cache': '1' },
  });
}

// ── The fetch wrapper ─────────────────────────────────────────────────

/** Raised on the window when the API refuses this app version (426). */
export const UPDATE_REQUIRED_EVENT = 'svrz:update-required';

let installed = false;

export function installNativeFetch(apiBase: string): void {
  if (!IS_NATIVE || installed || typeof window === 'undefined') return;
  installed = true;
  window.fetch = createNativeFetch(window.fetch.bind(window), apiBase, NATIVE_VERSION);
}

/** The wrapper itself, apart from installing it — so a spec can drive it in a
 *  plain browser page against mocked routes (e2e/native-client.spec.ts). */
export function createNativeFetch(raw: typeof fetch, apiBase: string, version: string): typeof fetch {
  const base = apiBase.replace(/\/+$/, '');

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!base || !url.startsWith(`${base}/api/`)) return raw(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('X-Svrz-Client', `native/${version}`);
    const jar = jarHeader();
    if (jar) headers.set('X-Svrz-Jar', jar);
    // No cookie of ours exists for this origin; 'omit' also keeps a stray one
    // from another app in the same webview out of the request.
    const nextInit: RequestInit = { ...init, headers, credentials: 'omit' };
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const pathname = new URL(url).pathname;
    const cacheable = method === 'GET' && isCacheableApiPath(pathname);

    const network = raw(input instanceof Request ? new Request(input, nextInit) : input, nextInit).then((res) => {
      applySetSession(res.headers.get('X-Svrz-Set-Session'));
      if (res.status === 426) window.dispatchEvent(new CustomEvent(UPDATE_REQUIRED_EVENT));
      // Stored whenever it arrives — also after the timeout already answered
      // from the cache — so the next offline read is this one.
      if (cacheable && res.status === 200) void storeApi(url, res.clone());
      return res;
    });
    if (!cacheable) return network;
    // Answered from the cache after the timeout, a network that fails later
    // has nobody left to tell.
    network.catch(() => {});

    // Network first, the stored copy when the network is gone or too slow.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), NETWORK_TIMEOUT_MS); });
    try {
      const first = await Promise.race([network, timeout]);
      if (first !== 'timeout') return first;
      const hit = await readCachedApi(url);
      return hit ? fromCache(hit) : await network;
    } catch (error) {
      const hit = await readCachedApi(url);
      if (hit) return fromCache(hit);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return wrapped as typeof fetch;
}

// ── Live events without EventSource ───────────────────────────────────

/**
 * The slice of EventSource that liveEvents.ts uses, over fetch — EventSource
 * cannot send the session header. Reconnects on its own after a drop, like the
 * browser's does, until close().
 */
export class FetchEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private controller: AbortController | null = null;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.controller = new AbortController();
    try {
      const res = await fetch(this.url, { headers: { Accept: 'text/event-stream' }, signal: this.controller.signal });
      if (!res.ok || !res.body || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
        throw new Error(`event stream refused (${res.status})`);
      }
      this.onopen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, '');
          const data = frame.split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) this.onmessage?.({ data });
        }
      }
      throw new Error('event stream ended');
    } catch {
      if (this.closed) return;
      this.onerror?.();
      if (!this.closed) this.retry = setTimeout(() => { this.retry = null; void this.connect(); }, 3_000);
    }
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.controller?.abort();
  }
}

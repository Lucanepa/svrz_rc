// Browser-side activity log: every click, every request, every error.
//
// Why it exists: the app runs on other people's phones. When a coach says "it
// said Verbindungsfehler", nothing on the server explains it — the interesting
// part (which button, which request, which status) happened in a browser we
// can't reach. This records that locally and ships it to /api/client-logs, so
// the admin console can replay a session after the fact.
//
// Rules it follows:
//  • never throws into the app — a broken logger must not break a page;
//  • never records the contents of a password/PIN/code field;
//  • bounded: ring buffer in memory, batched network, drops rather than grows.

export type ClientLevel = 'debug' | 'info' | 'warn' | 'error';

export type ClientLogEntry = {
  t: string;
  lvl: ClientLevel;
  evt: string;
  msg?: string;
  data?: Record<string, unknown>;
};

const RING_MAX = 500;
const BATCH_MAX = 60;
const FLUSH_INTERVAL_MS = 5_000;
const SID_KEY = 'svrz_log_sid';
const DID_KEY = 'svrz_log_did';

const ring: ClientLogEntry[] = [];
let pending: ClientLogEntry[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let user: string | undefined;
let apiBase = '';
let shipping = true;

function randomId(): string {
  try {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return Math.random().toString(16).slice(2, 18);
  }
}

function readStored(store: 'session' | 'local', key: string): string {
  try { return (store === 'session' ? sessionStorage : localStorage).getItem(key) || ''; } catch { return ''; }
}
function writeStored(store: 'session' | 'local', key: string, value: string): void {
  try { (store === 'session' ? sessionStorage : localStorage).setItem(key, value); } catch { /* private mode */ }
}

// sid = this tab/visit (sessionStorage survives reloads, not new tabs).
// did = this browser, forever — lets us follow one person across visits.
const sid = readStored('session', SID_KEY) || (() => { const v = randomId(); writeStored('session', SID_KEY, v); return v; })();
const did = readStored('local', DID_KEY) || (() => { const v = randomId(); writeStored('local', DID_KEY, v); return v; })();

export function logSessionId(): string { return sid; }
export function logDeviceId(): string { return did; }

/** Names the logged-in RC on every subsequent batch, so logs are attributable. */
export function setLogUser(name: string | null | undefined): void {
  user = name || undefined;
}

// ── Redaction ─────────────────────────────────────────────────────────
const SECRET_KEY = /(pass(word)?|pwd|pin|otp|code|secret|token|auth|cookie|session|bearer)/i;
const MAX_STRING = 600;

function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: (value.stack || '').slice(0, 1_500) };
  if (depth >= 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      // Booleans can't leak a secret and are usually the point (hasPassword…).
      out[k] = SECRET_KEY.test(k) && typeof v !== 'boolean' ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

// ── Core ──────────────────────────────────────────────────────────────
export function logEvent(lvl: ClientLevel, evt: string, msg?: string, data?: Record<string, unknown>): void {
  try {
    const entry: ClientLogEntry = {
      t: new Date().toISOString(),
      lvl,
      evt,
      msg,
      data: data ? (redact(data) as Record<string, unknown>) : undefined,
    };
    ring.push(entry);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    if (shipping) {
      pending.push(entry);
      // Errors are the reason anyone reads this — get them off the device now,
      // before a navigation or a crash takes the buffer with it.
      if (lvl === 'error' || pending.length >= BATCH_MAX) void flush();
      else scheduleFlush();
    }
  } catch { /* logging must never throw */ }
}

export const clientLog = {
  debug: (evt: string, msg?: string, data?: Record<string, unknown>) => logEvent('debug', evt, msg, data),
  info: (evt: string, msg?: string, data?: Record<string, unknown>) => logEvent('info', evt, msg, data),
  warn: (evt: string, msg?: string, data?: Record<string, unknown>) => logEvent('warn', evt, msg, data),
  error: (evt: string, msg?: string, data?: Record<string, unknown>) => logEvent('error', evt, msg, data),
};

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_INTERVAL_MS);
}

// `beacon` is used on pagehide, where a normal fetch would be cancelled.
export async function flush(beacon = false): Promise<void> {
  if (!pending.length || !shipping) return;
  const batch = pending.slice(0, BATCH_MAX);
  pending = pending.slice(batch.length);
  const payload = JSON.stringify({ sid, did, user, entries: batch });
  const url = `${apiBase}/api/client-logs`;
  try {
    if (beacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
      // text/plain keeps this a CORS-simple request. A beacon fired on pagehide
      // has no chance to complete a preflight, and this is the flush that
      // captures the moment someone gave up and closed the app.
      navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain;charset=UTF-8' }));
      return;
    }
    // Raw fetch, NOT the instrumented one: shipping logs must not generate logs.
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: batch.length < 30,
    });
  } catch {
    // Offline or the API is down. Put the batch back (bounded) so it ships on
    // the next successful flush instead of vanishing.
    pending = [...batch, ...pending].slice(-RING_MAX);
  }
}

/** The in-memory tail, for `window.svrzLogs()` and the offline "copy" button. */
export function getClientLogs(): ClientLogEntry[] { return [...ring]; }

// ── Instrumentation ───────────────────────────────────────────────────
const originalFetch: typeof fetch = typeof window !== 'undefined' ? window.fetch.bind(window) : (undefined as never);

/** Short, human-recognisable description of what was clicked. */
function describeElement(el: Element | null): Record<string, unknown> | undefined {
  if (!el) return undefined;
  const target = (el.closest('button,a,[role="button"],input,select,textarea,label,summary') || el) as HTMLElement;
  const tag = target.tagName.toLowerCase();
  const input = target as HTMLInputElement;
  const isSecret = tag === 'input' && /password|pin|code|otp/i.test(`${input.type} ${input.name} ${input.id} ${input.autocomplete}`);
  return {
    tag,
    type: tag === 'input' ? input.type : undefined,
    id: target.id || undefined,
    name: input.name || undefined,
    // Values are never logged; a password field isn't even described by text.
    text: isSecret ? '[password field]' : (target.innerText || target.getAttribute('aria-label') || target.getAttribute('title') || '').trim().slice(0, 80) || undefined,
    disabled: 'disabled' in target ? Boolean((target as HTMLButtonElement).disabled) : undefined,
    href: tag === 'a' ? (target as HTMLAnchorElement).getAttribute('href') || undefined : undefined,
  };
}

function installClickLogging(): void {
  // Capture phase: recorded even if a handler stops propagation.
  window.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const d = describeElement(el);
    clientLog.info('ui.click', d?.text ? `click: ${d.text}` : 'click', { ...d, hash: location.hash || undefined });
  }, { capture: true, passive: true });

  window.addEventListener('submit', (e) => {
    const form = e.target as HTMLFormElement | null;
    clientLog.info('ui.submit', 'form submit', { id: form?.id || undefined, fields: form ? [...form.elements].map((el) => (el as HTMLInputElement).name || (el as HTMLInputElement).id).filter(Boolean).slice(0, 20) : undefined });
  }, { capture: true, passive: true });

  // Focus tells us where someone got stuck when nothing else was clicked.
  window.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement | null;
    if (!el || !el.tagName) return;
    const d = describeElement(el);
    clientLog.debug('ui.change', 'field changed', { ...d, filled: Boolean(el.value) });
  }, { capture: true, passive: true });
}

// Stamps our session/device ids on API calls so a server-side request log line
// can be joined to the browser session that made it. Only for plain
// (string/URL) API requests — a caller-built Request object is passed through
// untouched rather than risking a rebuild. The extra headers make these
// requests preflighted; the API sets a long Access-Control-Max-Age so the
// browser caches that OPTIONS instead of repeating it.
function withTraceHeaders(url: string, init?: RequestInit): RequestInit | undefined {
  if (!url.includes('/api/')) return init;
  try {
    const headers = new Headers(init?.headers || {});
    headers.set('X-Svrz-Session', sid);
    headers.set('X-Svrz-Device', did);
    return { ...init, headers };
  } catch {
    return init;
  }
}

function installFetchLogging(): void {
  window.fetch = async function loggedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The log-shipping endpoint would recurse.
    if (url.includes('/api/client-logs')) return originalFetch(input as RequestInfo, init);
    const traced = input instanceof Request ? init : withTraceHeaders(url, init);
    const started = performance.now();
    try {
      const res = await originalFetch(input as RequestInfo, traced);
      const ms = Math.round(performance.now() - started);
      const lvl: ClientLevel = res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'debug';
      logEvent(lvl, 'net.fetch', `${method} ${url} → ${res.status} (${ms}ms)`, {
        method, url, status: res.status, ms, ok: res.ok,
        // The one header that explains a 429 to whoever reads the log later.
        retryAfter: res.headers.get('retry-after') || undefined,
      });
      return res;
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      // A rejected fetch means the request never got a status: offline, DNS,
      // TLS, or CORS. This is the *only* thing that should ever be reported to
      // the user as "Verbindungsfehler".
      clientLog.error('net.fail', `${method} ${url} failed after ${ms}ms (no response)`, {
        method, url, ms, error, online: navigator.onLine,
      });
      throw error;
    }
  };
}

function installErrorLogging(): void {
  window.addEventListener('error', (e) => {
    // Resource load failures (img/script/css) surface here with no `error`.
    if (e.error || e.message) {
      clientLog.error('js.error', e.message || 'window error', { error: e.error, file: e.filename, line: e.lineno, col: e.colno });
    } else {
      const el = e.target as HTMLElement | null;
      clientLog.warn('res.error', 'resource failed to load', { tag: el?.tagName?.toLowerCase(), src: (el as HTMLImageElement)?.src });
    }
  }, { capture: true });

  window.addEventListener('unhandledrejection', (e) => {
    clientLog.error('js.unhandledrejection', 'unhandled promise rejection', { error: e.reason });
  });

  // console.error/warn from anywhere (React included) land in the log too.
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logEvent(level === 'error' ? 'error' : 'warn', `console.${level}`, args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : '')).join(' ').slice(0, 500) || undefined, { args });
      original(...args);
    };
  }
}

function installLifecycleLogging(): void {
  window.addEventListener('online', () => clientLog.info('net.online', 'back online'));
  window.addEventListener('offline', () => clientLog.warn('net.offline', 'went offline'));
  window.addEventListener('hashchange', () => clientLog.info('nav.hashchange', location.hash || '#'));
  document.addEventListener('visibilitychange', () => clientLog.debug('app.visibility', document.visibilityState));
  window.addEventListener('pagehide', () => { void flush(true); });
  // Flushing on hide (not unload) is what actually works on iOS Safari.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(true); });
}

/**
 * Installs every hook. Call once, as early as possible — anything that happens
 * before this is invisible.
 */
export function installLogging(options: { apiBase?: string; ship?: boolean } = {}): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  apiBase = options.apiBase || '';
  shipping = options.ship !== false;
  try {
    installErrorLogging();
    installFetchLogging();
    installClickLogging();
    installLifecycleLogging();
    clientLog.info('app.start', 'app loaded', {
      url: location.href,
      ua: navigator.userAgent,
      lang: navigator.language,
      online: navigator.onLine,
      screen: `${window.screen?.width}x${window.screen?.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches,
      referrer: document.referrer || undefined,
      sid,
      did,
    });
    // Escape hatch for support over the phone: "type svrzLogs() in the console".
    (window as unknown as Record<string, unknown>).svrzLogs = () => getClientLogs();
    (window as unknown as Record<string, unknown>).svrzLogsText = () => getClientLogs().map((e) => `${e.t} ${e.lvl} ${e.evt} ${e.msg || ''} ${e.data ? JSON.stringify(e.data) : ''}`).join('\n');
  } catch (error) {
    console.warn('[logger] install failed', error);
  }
}

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
      // Offline the beacon goes nowhere and reports nothing, and this flush also
      // runs on every switch to another app — so the offline failure window the
      // log exists to explain was exactly what got dropped. Keep the batch.
      if (typeof navigator.onLine === 'boolean' && !navigator.onLine) {
        pending = [...batch, ...pending].slice(-RING_MAX);
        return;
      }
      // text/plain keeps this a CORS-simple request. A beacon fired on pagehide
      // has no chance to complete a preflight, and this is the flush that
      // captures the moment someone gave up and closed the app.
      // A false return means the payload was refused (over the beacon quota).
      if (!navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain;charset=UTF-8' }))) {
        pending = [...batch, ...pending].slice(-RING_MAX);
      }
      return;
    }
    // Raw fetch, NOT the instrumented one: shipping logs must not generate logs.
    await originalFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      // The API is a different origin, where fetch sends no cookie unless asked.
      // Without this the endpoint sees no session behind the name in the batch
      // and files every line as `unverified:<name>` — while the beacon path
      // above, which does carry credentials, filed the same coach's lines under
      // their real name. That split made the marker read as an auth problem
      // instead of what it was: half the batches simply arrived cookie-less.
      credentials: 'include',
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
// Capability tokens ride in URLs: #/survey/<token>, #/sign/<slug>, and the
// /api/survey|signature|ical/<token> calls the page makes. Whoever holds one can
// answer a survey AS the referee (once), or read a handwritten signature — so a
// token copied into the activity log hands that capability to every admin who
// reads it, and re-links a survey answer to the person even when they chose
// "Anonym" and the stored record dropped their name. Mask them everywhere a URL
// is logged, rather than trusting each call site to remember.
function scrubTokens(value: string): string {
  return value
    .replace(/(#\/(?:survey|sign)\/)[^/?#\s]+/gi, '$1<token>')
    .replace(/(\/api\/(?:survey|signature|ical)\/)[^/?#\s]+/gi, '$1<token>');
}

function describeElement(el: Element | null): Record<string, unknown> | undefined {
  if (!el) return undefined;
  const target = (el.closest('button,a,[role="button"],input,select,textarea,label,summary') || el) as HTMLElement;
  const tag = target.tagName.toLowerCase();
  const input = target as HTMLInputElement;
  const isSecret = tag === 'input' && /password|pin|code|otp/i.test(`${input.type} ${input.name} ${input.id} ${input.autocomplete}`);
  // The activity log is read by every admin, so anything marked confidential
  // must not have its rendered text copied into it. Clicking (or text-selecting)
  // a freshly generated PIN, a president's private note, or a coachee's survey
  // answer used to put the first 80 characters straight into the Protokoll —
  // and into the 30-day log files, and into the log tab's Copy export.
  const confidential = !!target.closest('[data-log-redact]');
  const description = (target.innerText || target.getAttribute('aria-label') || target.getAttribute('title') || '').trim().slice(0, 80) || undefined;
  return {
    tag,
    type: tag === 'input' ? input.type : undefined,
    id: target.id || undefined,
    name: input.name || undefined,
    // Values are never logged; a password field isn't even described by text.
    text: isSecret ? '[password field]' : confidential ? '[redacted]' : description,
    disabled: 'disabled' in target ? Boolean((target as HTMLButtonElement).disabled) : undefined,
    href: tag === 'a' ? (target as HTMLAnchorElement).getAttribute('href') || undefined : undefined,
  };
}

function installClickLogging(): void {
  // Capture phase: recorded even if a handler stops propagation.
  window.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const d = describeElement(el);
    clientLog.info('ui.click', d?.text ? `click: ${d.text}` : 'click', { ...d, hash: location.hash ? scrubTokens(location.hash) : undefined });
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

/** A fetch the browser gave up on before it could have reached the network.
 *
 *  Six requests on one phone all "failed" in 6–9 ms at the same instant on
 *  10.09.2026 — every call the app makes at boot — and never again. DNS, TLS
 *  and a timeout each take longer than that; a rejection that fast is the
 *  browser's own network stack refusing locally: the handset switching
 *  networks as the app opens (Chrome's ERR_NETWORK_CHANGED), or the page
 *  being torn down and reloaded mid-boot. Nothing on the server side happened,
 *  so nothing on the server side should be woken up for it.
 *
 *  Same `net.fail` prefix, so a mute rule and the log search still catch it;
 *  a warning rather than an error, so the alert mail does not go out. An
 *  AbortError is the app's own cancellation and is not what this is about. */
export const INSTANT_FAIL_MS = 50;

/** True once this page has started to go away: the app called
 *  location.reload() itself, or the browser said `pagehide`. Every request in
 *  flight at that moment is cancelled — Chrome reports each one as
 *  "Failed to fetch" — and none of them is news. */
let leaving = false;
/** Say so before calling location.reload(). Both places the app reloads
 *  itself (a new service worker taking over, and crossing between the admin
 *  console and the app) do; on 10.09.2026 a Home request cancelled by one of
 *  them was logged as an API failure. */
export function noteLeavingPage(): void { leaving = true; }
/** …and back. Nothing used to clear this, so the first `pagehide` of a visit
 *  latched it for good: a page restored from the back/forward cache, or an app
 *  simply brought back to the front, went on filing every later failure as
 *  somebody leaving. The API could then have been down for the rest of that
 *  session with nothing louder than a warning to say so. */
export function noteBackOnPage(): void { leaving = false; }

export function classifyFetchFailure(ms: number, error: unknown, isLeaving = leaving): { evt: string; lvl: ClientLevel } {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError') return { evt: 'net.fail', lvl: 'error' };
  if (isLeaving) return { evt: 'net.fail.unload', lvl: 'warn' };
  if (ms < INSTANT_FAIL_MS) return { evt: 'net.fail.instant', lvl: 'warn' };
  return { evt: 'net.fail', lvl: 'error' };
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
      logEvent(lvl, 'net.fetch', `${method} ${scrubTokens(url)} → ${res.status} (${ms}ms)`, {
        method, url: scrubTokens(url), status: res.status, ms, ok: res.ok,
        // The one header that explains a 429 to whoever reads the log later.
        retryAfter: res.headers.get('retry-after') || undefined,
      });
      return res;
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      // A rejected fetch means the request never got a status: offline, DNS,
      // TLS, or CORS. This is the *only* thing that should ever be reported to
      // the user as "Verbindungsfehler".
      const { evt, lvl } = classifyFetchFailure(ms, error);
      // Scrubbed like every other line that carries a URL. This one was raw, so
      // a survey that failed to load filed its capability token — which answers
      // the questionnaire AS the referee, and re-links an anonymous answer to
      // the person who gave it — into a Protokoll every admin reads.
      clientLog[lvl](evt, `${method} ${scrubTokens(url)} failed after ${ms}ms (no response)`, {
        method, url: scrubTokens(url), ms, error, online: navigator.onLine,
      });
      throw error;
    }
  };
}

/**
 * The browser hands us "Script error." with an empty filename and no error
 * object when the throw came from a script on another origin without CORS —
 * in practice a browser extension or an injected third-party script, never
 * our own bundle. There is nothing in it to act on and nothing we can do
 * about it, so it stays in the log as a warning instead of waking the
 * operator by mail. Same `js.error` prefix, so a mute rule still catches it.
 */
function isOpaqueCrossOriginError(e: ErrorEvent): boolean {
  return !e.error && !e.filename && !e.lineno && /^script error\.?$/i.test((e.message || '').trim());
}

/**
 * "ResizeObserver loop completed with undelivered notifications." is the
 * browser noting that an observer callback changed layout within the frame it
 * was measuring, so it skipped one round of notifications and delivered them
 * on the next. Nothing fails and nothing is lost; the browser itself never
 * throws it, it only announces it on the window. It arrived as a js.error
 * from #/admin/emails on 10.09.2026 and paged the operator for a layout tick.
 * Exported so the rule can be tested without a browser.
 */
export function isResizeObserverLoopNotice(message: string | undefined): boolean {
  return /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)\.?$/i.test((message || '').trim());
}

function installErrorLogging(): void {
  window.addEventListener('error', (e) => {
    // Resource load failures (img/script/css) surface here with no `error`.
    if (e.error || e.message) {
      const level = isOpaqueCrossOriginError(e) || isResizeObserverLoopNotice(e.message) ? 'warn' : 'error';
      const evt = level === 'warn' ? 'js.error.opaque' : 'js.error';
      clientLog[level](evt, e.message || 'window error', { error: e.error, file: e.filename, line: e.lineno, col: e.colno });
    } else {
      const el = e.target as HTMLElement | null;
      clientLog.warn('res.error', 'resource failed to load', { tag: el?.tagName?.toLowerCase(), src: (el as HTMLImageElement)?.src });
    }
  }, { capture: true });

  window.addEventListener('unhandledrejection', (e) => {
    clientLog.error('js.unhandledrejection', 'unhandled promise rejection', { error: e.reason });
  });

  // Every console call from anywhere (React, a library, a leftover debug line)
  // lands in the log too. error/warn keep their level; the chatty three come in
  // as debug, so they are there when you replay a session and out of the way
  // when you are only looking for what broke.
  const CONSOLE_LEVEL: Record<string, ClientLevel> = { error: 'error', warn: 'warn', log: 'debug', info: 'debug', debug: 'debug' };
  for (const level of ['error', 'warn', 'log', 'info', 'debug'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logEvent(CONSOLE_LEVEL[level], `console.${level}`, args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : '')).join(' ').slice(0, 500) || undefined, { args });
      original(...args);
    };
  }
}

function installLifecycleLogging(): void {
  window.addEventListener('online', () => clientLog.info('net.online', 'back online'));
  window.addEventListener('offline', () => clientLog.warn('net.offline', 'went offline'));
  window.addEventListener('hashchange', () => clientLog.info('nav.hashchange', scrubTokens(location.hash || '#')));
  document.addEventListener('visibilitychange', () => clientLog.debug('app.visibility', document.visibilityState));
  window.addEventListener('pagehide', () => { noteLeavingPage(); void flush(true); });
  window.addEventListener('pageshow', () => { noteBackOnPage(); });
  // Flushing on hide (not unload) is what actually works on iOS Safari.
  //
  // Switching to another app counts as going away too: the request dies with
  // the tab's network, and nobody can act on it. That is what cut off a coach's
  // Home overview at 13:47 on 10.09.2026 — 141 ms in, too slow for the instant
  // rule to catch and mailed as an API failure. Coming back to the front is the
  // other half of it, and the half that keeps a real outage loud.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { noteLeavingPage(); void flush(true); }
    else noteBackOnPage();
  });
}

/**
 * Installs every hook. Call once, as early as possible — anything that happens
 * before this is invisible.
 */
/** A page served from localhost has no business filing entries in the live
 *  Protokoll — under a real coach's name, in the 30-day files, and (since the
 *  alerts) in somebody's inbox. Dev and e2e runs point at the remote API
 *  through VITE_API_BASE_URL; the app still talks to it, the LOG does not. */
function shipsToAnotherOrigin(base: string): boolean {
  if (!base) return false;
  try {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
    return local && new URL(base, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}

export function installLogging(options: { apiBase?: string; ship?: boolean } = {}): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  apiBase = options.apiBase || '';
  shipping = options.ship !== false && !shipsToAnotherOrigin(apiBase);
  try {
    installErrorLogging();
    installFetchLogging();
    installClickLogging();
    installLifecycleLogging();
    clientLog.info('app.start', 'app loaded', {
      url: scrubTokens(location.href),
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

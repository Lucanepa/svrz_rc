import { IS_NATIVE } from './native';

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

import { connection } from './connection';

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

/** Readers, renderers and crawlers that run the app's JavaScript: Google's
 *  Read Aloud (10 of the 11 "service worker registration failed: Rejected"
 *  lines up to 21.10.2026), Googlebot and its tools, and the odd crawler
 *  that names itself. Whatever breaks for them, no coach can act on. */
const AUTOMATED_AGENT = /Google-Read-Aloud|Googlebot|Google-InspectionTool|GoogleOther|Google-PageRenderer|AdsBot-Google|Mediapartners-Google|FeedFetcher-Google|bingbot|HeadlessChrome|\b(crawler|spider)\b|bot\/\d/i;
const MOBILE_UA = /\b(Mobile|Android|iPhone|iPad|iPod)\b/;
const IOS_UA = /\b(iPhone|iPad|iPod)\b/;

/** What the page knows about the window it runs in, beside the user agent. */
export type VisitEnv = {
  /** navigator.webdriver: the browser says it is driven by automation. */
  webdriver?: boolean;
  screenW?: number;
  screenH?: number;
  innerW?: number;
  /** Opened from the home screen (navigator.standalone, or display-mode). */
  standalone?: boolean;
  /** The installed app (lib/native.ts): its webview is not a browser tab. */
  native?: boolean;
};

/** This window, read when a line is written. Undefined outside a browser. */
export function currentVisitEnv(): VisitEnv | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return undefined;
  try {
    return {
      webdriver: navigator.webdriver === true,
      screenW: window.screen?.width,
      screenH: window.screen?.height,
      innerW: window.innerWidth,
      standalone: (navigator as { standalone?: boolean }).standalone === true
        || !!window.matchMedia?.('(display-mode: standalone)').matches,
      native: IS_NATIVE,
    };
  } catch {
    return undefined;
  }
}

/** True for a visit that is not a person. Google's Web Rendering Service
 *  sometimes presents a plain Android user agent, but it replaces
 *  serviceWorker.register with a stub of its own, and the stub's frame names
 *  `wrsParams` in every stack it throws. Exported for the test.
 *
 *  The window gives the rest away (`env`, left out by the rule specs that
 *  only pass a user agent):
 *  • navigator.webdriver, or a HeadlessChrome user agent: a script drives it.
 *    The test suite is driven too, and expects its errors to stay errors —
 *    playwright.config.ts launches Chromium with AutomationControlled off,
 *    so navigator.webdriver is false there, and the spec that tests this
 *    rule sets it back to true itself. No hook in the app for the suite.
 *  • An 800x600 screen with a wider window: the VirusTotal-style scanner of
 *    12.10.2026 (screen 800x600, viewport 1024x768) — no monitor does that.
 *  • A phone user agent whose window is wider than the screen's long side:
 *    the hidden WKWebView an iPhone renders a link preview in (1920x1080 on
 *    a 402x874 screen, 02.10, 19.10 and 21.10.2026, zero API calls). The
 *    long side, not screen.width: iOS keeps reporting the portrait width in
 *    landscape, where a real window is wider than that.
 *  • An iPhone/iPad user agent with no "Safari/" token outside a home-screen
 *    app: that preview's user agent. The installed home-screen PWA has no
 *    Safari token either, and says so with navigator.standalone.
 *  The installed app (Tauri) is exempt from the window rules: its webview is
 *  no Safari, and is a person every time. */
export function isAutomatedVisit(ua: string, error?: unknown, env?: VisitEnv): boolean {
  if (AUTOMATED_AGENT.test(ua || '')) return true;
  const stack = error instanceof Error ? error.stack
    : error && typeof error === 'object' ? (error as { stack?: unknown }).stack : '';
  if (typeof stack === 'string' && stack.includes('wrsParams')) return true;
  if (!env) return false;
  if (env.webdriver === true) return true;
  if (env.native) return false;
  const { screenW: sw, screenH: sh, innerW: iw } = env;
  if (sw && sh && iw) {
    if (sw === 800 && sh === 600 && iw > sw) return true;
    if (MOBILE_UA.test(ua || '') && iw > Math.max(sw, sh)) return true;
  }
  return IOS_UA.test(ua || '') && !/Safari\//.test(ua || '') && env.standalone !== true;
}

// ── Core ──────────────────────────────────────────────────────────────
export function logEvent(lvl: ClientLevel, evt: string, msg?: string, data?: Record<string, unknown>): void {
  try {
    // Still written, under the same event name so a search finds it, but as
    // a warning: the alert mail is for failures somebody can do something about.
    if (lvl === 'error' && isAutomatedVisit(typeof navigator === 'undefined' ? '' : navigator.userAgent, data?.error, currentVisitEnv())) lvl = 'warn';
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
    // Not in the installed app: a beacon cannot carry the session header, and
    // its lines would all land as `unverified`. keepalive fetch does the job there.
    if (beacon && !IS_NATIVE && typeof navigator !== 'undefined' && navigator.sendBeacon) {
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
// Taken again when the patch goes in (installFetchLogging), not only here at
// module load: the installed app wraps fetch first (lib/native.ts) to carry its
// session, and a copy taken before that — imports run before main.tsx does —
// would route every request, the log shipping included, around it.
let originalFetch: typeof fetch = typeof window !== 'undefined' ? window.fetch.bind(window) : (undefined as never);

/** Short, human-recognisable description of what was clicked. */
// Capability tokens ride in URLs: #/survey/<token>, #/sign/<slug>, and the
// /api/survey|signature|ical/<token> calls the page makes. Whoever holds one can
// answer a survey AS the referee (once), or read a handwritten signature — so a
// token copied into the activity log hands that capability to every admin who
// reads it, and re-links a survey answer to the person even when they chose
// "Anonym" and the stored record dropped their name. Mask them everywhere a URL
// is logged, rather than trusting each call site to remember.
//
// The coachee routes carry a person identifier too, since a linked coachee's
// list is addressed by their SV number (`/games/<sv>`, `/feedbacks/<sv>/…`,
// see routes.ts). It is no capability — the licence number is printed on
// every score sheet — but it is a person, and the Protokoll is read by every
// admin, so an all-digit segment under those two nouns is masked as well. A
// record id there is left alone (it names nobody to a reader) unless it
// happens to be all digits, which costs nothing. Pages request logs and the
// Referer of the asset fetches carry the path regardless; this covers what
// the app itself writes down.
//
// Exported for the one URL line written outside this module (main.tsx's
// `app.route`, which logs the path and the hash it is about to mount).
export function scrubTokens(value: string): string {
  return value
    .replace(/(#\/(?:survey|sign)\/)[^/?#\s]+/gi, '$1<token>')
    .replace(/(\/api\/(?:survey|signature|ical)\/)[^/?#\s]+/gi, '$1<token>')
    .replace(/(\/(?:games|feedbacks)\/)\d+(?=[/?#\s]|$)/gi, '$1<sv>');
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
    // Scrubbed like every other URL this logger writes: the calendar dialog's
    // anchors carry the iCal feed token (webcal://…/api/ical/<token>.ics), and
    // a click on one filed it raw into a Protokoll every admin reads.
    href: tag === 'a' ? scrubTokens((target as HTMLAnchorElement).getAttribute('href') || '') || undefined : undefined,
  };
}

function installClickLogging(): void {
  // Capture phase: recorded even if a handler stops propagation.
  window.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target : null;
    const d = describeElement(el);
    clientLog.info('ui.click', d?.text ? `click: ${d.text}` : 'click', { ...d, path: scrubTokens(location.pathname + location.search + location.hash) });
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
/** How long a failure that looks like an outage is held before it is written,
 *  in case the page turns out to be leaving. A navigation the browser starts
 *  — pull-to-refresh on Android Chrome, the address bar, a bookmark — aborts
 *  every request in flight ("Failed to fetch") BEFORE it fires `pagehide`, so
 *  at the moment they fail nothing says the page is going anywhere. On
 *  13.09.2026 three console requests died that way 700 ms before the new
 *  document loaded, and were mailed out as an API outage the server had
 *  already answered. The next document commits well inside this window; a
 *  page that is really gone by then writes nothing, which is right. */
export const LEAVE_GRACE_MS = 1500;

/** True once this page has started to go away: the app called
 *  location.reload() itself, or the browser said `pagehide`. Every request in
 *  flight at that moment is cancelled — Chrome reports each one as
 *  "Failed to fetch" — and none of them is news. */
let leaving = false;
/** The stronger form: this page is going away because the APP said so, and
 *  the reload is already running. Nothing clears it — there is nothing left
 *  to come back to. */
let reloading = false;
/** When the page was last taken away (performance.now()). `leaving` says
 *  where the page is NOW; a request needs to know where it has BEEN. A phone
 *  locked mid-request freezes the tab with the request in it, and when the
 *  coach comes back the browser rejects it — after `noteBackOnPage` has
 *  already cleared the flag. At 18:46 on 06.10.2026 the auth check and the
 *  notebook, both 692 s old, went out by mail as an API outage that way;
 *  nothing behind Cloudflare even lives that long (it answers 524 at 100 s). */
let lastLeftAt = -Infinity;
/** The browser took the page away (`pagehide`, or backgrounding the app). */
export function noteLeavingPage(): void { leaving = true; lastLeftAt = performance.now(); }
/** Say so before calling location.reload(). Both places the app reloads
 *  itself (a new service worker taking over, and crossing between the admin
 *  console and the app) do; on 10.09.2026 a Home request cancelled by one of
 *  them was logged as an API failure. */
export function noteReloadingPage(): void { reloading = true; leaving = true; }
/** …and back. Nothing used to clear this, so the first `pagehide` of a visit
 *  latched it for good: a page restored from the back/forward cache, or an app
 *  simply brought back to the front, went on filing every later failure as
 *  somebody leaving. The API could then have been down for the rest of that
 *  session with nothing louder than a warning to say so.
 *
 *  It does not, however, undo a reload the app itself started. Coming back to
 *  a phone whose service worker updated while it was away runs both in the
 *  same instant: the update reloads the page, the tab turns visible, and at
 *  18:33 on 10.09.2026 that order cleared the flag just in time for the three
 *  Home requests dying in the reload to be mailed out as an API outage. */
export function noteBackOnPage(): void { if (!reloading) leaving = false; }
/** Whether the page is going away right now (pagehide, backgrounded, or a
 *  reload the app started). For main.tsx's service-worker failure line. */
export function isPageLeaving(): boolean { return leaving; }
/** Both flags outlive the module, and the test suite shares one process with
 *  it — a spec that simulates a reload would otherwise downgrade every failure
 *  the next spec measures. Nothing in the app calls this: a page that really
 *  reloaded is gone. */
export function resetPageLifecycle(): void { leaving = false; reloading = false; lastOfflineAt = -Infinity; lastLeftAt = -Infinity; edgeProbe = null; }

/** When the browser last said `offline` (performance.now()). A phone that
 *  loses the network drops every request in flight, and the log already
 *  says so one line up. At 16:05 on 30.09.2026 a coach's handset went
 *  offline twice in four seconds; the notebook sync that was running died
 *  20 ms after it came back and went out by mail as an API outage the server
 *  never saw. */
let lastOfflineAt = -Infinity;
export function noteWentOffline(): void { lastOfflineAt = performance.now(); }
/** True when the browser was, or went, offline at any point in a request's
 *  life — at the start, during it, or at the moment it failed. */
function sawOfflineSince(started: number, onlineAtStart: boolean): boolean {
  return !onlineAtStart || !navigator.onLine || lastOfflineAt >= started;
}
/** True when the page is leaving now, was taken away at any point since the
 *  request started — even if it has come back since — or was not on screen
 *  when the request began. That last one has no event to note it: at 19:40 on
 *  21.10.2026 a coach's deferred update reloaded the app while she was in
 *  Maps, so the page was BORN hidden and never fired `visibilitychange`. Its
 *  boot requests froze with the tab and failed 310 s later as she came back,
 *  mailed as an outage the server never saw. */
function leftSince(started: number, hiddenAtStart = false): boolean {
  return leaving || hiddenAtStart || lastLeftAt >= started;
}

/** The live stream. On the web it is an EventSource, which fetch never sees;
 *  the installed app reads it through fetch (native.ts, FetchEventSource), so
 *  every dropped stream there used to reach this wrapper as a failed request
 *  — 14.10.2026, mailed as an outage. The stream reports its own trouble at
 *  warn (liveEvents.ts), and connection.ts leaves it out of the banner too. */
const LIVE_STREAM = /\/api\/events(\?|#|$)/;

export function classifyFetchFailure(ms: number, error: unknown, isLeaving = leaving, wentOffline = false, url = ''): { evt: string; lvl: ClientLevel } {
  const name = error instanceof Error ? error.name : '';
  // The app cancelled it itself: the PDF reader closed while a document was
  // loading, the installed app's live stream closed (native.ts). Nothing
  // failed. A warning rather than info, so an abort that some day stands in
  // for a timeout still shows up; a real timeout (TimeoutError) falls
  // through to the rules below.
  if (name === 'AbortError') return { evt: 'net.fail.aborted', lvl: 'warn' };
  if (isLeaving) return { evt: 'net.fail.unload', lvl: 'warn' };
  if (wentOffline) return { evt: 'net.fail.offline', lvl: 'warn' };
  if (LIVE_STREAM.test(url)) return { evt: 'net.fail.live', lvl: 'warn' };
  if (ms < INSTANT_FAIL_MS) return { evt: 'net.fail.instant', lvl: 'warn' };
  return { evt: 'net.fail', lvl: 'error' };
}

/** Sent on the window when an RC app route answers 401: the app session is
 *  gone. On 09.10.2026 a cached "signed in" kept a coach working against 18
 *  refusals for seven minutes; AuthGate now asks /api/auth/me again on this
 *  and, if the session really is gone, goes to the login screen. */
export const UNAUTHORIZED_EVENT = 'svrz:unauthorized';

/** A 401 from these answers to another credential than the RC's app session:
 *  the login itself, the console cookie (admin, chair), a referee's PIN, or a
 *  link token (signature, survey, calendar feed). Exported for the test. */
export function isRcSessionRefusal(status: number, url: string): boolean {
  return status === 401 && /\/api\//.test(url)
    && !/\/api\/((auth|admin|coachee-file|president-notes|forms|feedback-archive|finance|referee-coaches|vm|survey-responses)(\/|\?|$)|survey\/|signature\/(?!start(\?|$))|ical\/(?!me(\?|$)))/.test(url);
}

// ── Is it us, or the device's network? ────────────────────────────────
/** A static file on Cloudflare's edge, asked for when a request from a
 *  visible, online page has failed and the grace for a navigation has run
 *  out — the one case no rule above excuses. Up to 17.10.2026 nine such
 *  failures were mailed as an API outage, every one of them retried fine:
 *  a tethered laptop, a phone between networks, a laptop that reached
 *  nothing at all for ten minutes while every other client reached the API.
 *  If the edge does not answer either, the path between this device and the
 *  internet is what failed (net.fail.network, a warning). If it answers, the
 *  device is online and our API or tunnel is not: a real outage, mailed.
 *
 *  Absolute, never location.origin: the installed app runs on
 *  tauri.localhost, which always answers. no-store in public/_headers and a
 *  fresh query each time, so no cache can answer for the network; not in the
 *  service-worker precache (vite.config.ts globPatterns has no .txt).
 *  The e2e config points it at a closed local port, and the support stubs
 *  answer it, so the suite never reaches the live edge. */
export const EDGE_PROBE_URL: string = (typeof import.meta.env !== 'undefined'
  && (import.meta.env.VITE_EDGE_PROBE_URL as string | undefined)?.trim())
  || 'https://svrz-rc.openvolley.app/edge-probe.txt';
export const EDGE_PROBE_TIMEOUT_MS = 4000;
/** One probe answers for a whole burst: a dead network fails every request
 *  in flight at once, and one question is enough for all of them. */
export const EDGE_PROBE_SHARE_MS = 10_000;

export type EdgeState = 'up' | 'down';
let edgeProbe: { at: number; result: Promise<EdgeState> } | null = null;

function probeEdge(): Promise<EdgeState> {
  const now = performance.now();
  if (edgeProbe && now - edgeProbe.at < EDGE_PROBE_SHARE_MS) return edgeProbe.result;
  const result = new Promise<EdgeState>((resolve) => {
    // Raced as well as aborted: an engine without AbortSignal.timeout still
    // gets its answer in time.
    const timer = setTimeout(() => resolve('down'), EDGE_PROBE_TIMEOUT_MS);
    let signal: AbortSignal | undefined;
    try { signal = typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(EDGE_PROBE_TIMEOUT_MS) : undefined; } catch { /* old engine */ }
    // no-cors: any answer at all, even an opaque one, means the edge was reached.
    originalFetch(`${EDGE_PROBE_URL}?e=${Date.now()}`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal })
      .then(() => resolve('up'), () => resolve('down'))
      .finally(() => clearTimeout(timer));
  });
  edgeProbe = { at: now, result };
  return result;
}

/** How loud an answered request is: 5xx error, 4xx warn, the rest debug.
 *  One exception. Since b8603cd the document proxy answers 503 with
 *  Retry-After when svrz.ch cannot be reached and it holds no copy of the
 *  file — svrz.ch's outage, already recorded once by the API as
 *  docs.unavailable. The one on 21.10.2026 reached the log 29 times (then as
 *  Cloudflare 502s); the next would arrive as these 503s, each mailed. Only that
 *  route and only 503: a 500 from the proxy is our bug and still mails, and
 *  a 503 anywhere else is still an outage. Exported for the test. */
export function responseLevel(status: number, url: string): ClientLevel {
  if (status === 503 && /\/api\/docs\//.test(url.split(/[?#]/)[0])) return 'warn';
  return status >= 500 ? 'error' : status >= 400 ? 'warn' : 'debug';
}

function installFetchLogging(): void {
  originalFetch = window.fetch.bind(window);
  window.fetch = async function loggedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // The log-shipping endpoint would recurse.
    if (url.includes('/api/client-logs')) return originalFetch(input as RequestInfo, init);
    const traced = input instanceof Request ? init : withTraceHeaders(url, init);
    const started = performance.now();
    const onlineAtStart = navigator.onLine;
    const hiddenAtStart = document.visibilityState === 'hidden';
    const conn = connection.start(method, url);
    try {
      const res = await originalFetch(input as RequestInfo, traced);
      const ms = Math.round(performance.now() - started);
      conn.answered(ms);
      const lvl = responseLevel(res.status, url);
      logEvent(lvl, 'net.fetch', `${method} ${scrubTokens(url)} → ${res.status} (${ms}ms)`, {
        method, url: scrubTokens(url), status: res.status, ms, ok: res.ok,
        // The one header that explains a 429 to whoever reads the log later.
        retryAfter: res.headers.get('retry-after') || undefined,
      });
      if (isRcSessionRefusal(res.status, url)) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      return res;
    } catch (error) {
      const ms = Math.round(performance.now() - started);
      // Asked again when the line is written: the browser can fire `offline`
      // a beat AFTER the requests it cut off have already rejected, and a
      // would-be error waits LEAVE_GRACE_MS anyway.
      const offline = () => sawOfflineSince(started, onlineAtStart);
      // A rejected fetch means the request never got a status: offline, DNS,
      // TLS, or CORS. This is the *only* thing that should ever be reported to
      // the user as "Verbindungsfehler".
      // Scrubbed like every other line that carries a URL. This one was raw, so
      // a survey that failed to load filed its capability token — which answers
      // the questionnaire AS the referee, and re-links an anonymous answer to
      // the person who gave it — into a Protokoll every admin reads.
      const verdict = () => classifyFetchFailure(ms, error, leftSince(started, hiddenAtStart), offline(), url);
      const write = (edge?: EdgeState) => {
        let { evt, lvl } = verdict();
        // The edge did not answer either: this device's network, not our API.
        if (evt === 'net.fail' && edge === 'down') { evt = 'net.fail.network'; lvl = 'warn'; }
        clientLog[lvl](evt, `${method} ${scrubTokens(url)} failed after ${ms}ms (no response)`, {
          method, url: scrubTokens(url), ms, error, online: navigator.onLine, edge,
        });
      };
      // Anything already excused is written now. A failure that would go out
      // as an outage waits LEAVE_GRACE_MS, so a navigation that has not fired
      // pagehide yet gets the chance to claim it (see the constant), and then
      // asks the edge whether the device can reach the internet at all. The
      // verdict is taken again after the probe: the page may have left, or
      // the browser said `offline`, while it was out.
      // The banner follows the verdict at the end of the grace — a request
      // that got no answer is one the coach should hear about, whoever's
      // network it was — so a page that is only reloading never tells the
      // coach their network is down.
      const settle = () => { if (verdict().evt === 'net.fail') conn.failed(); else conn.dropped(); };
      if (verdict().lvl === 'error') {
        setTimeout(() => {
          settle();
          if (verdict().lvl !== 'error') { write(); return; }
          void probeEdge().then(write, () => write());
        }, LEAVE_GRACE_MS);
      } else { write(); settle(); }
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

/**
 * A throw from code the browser put into the page, not code we shipped. Our
 * index.html has no inline script, so an error whose file is the HTML page
 * itself ("…/infos", line 1) can only come from something injected — Firefox
 * for iOS's reader helper (`window.__firefox__`), an in-app browser probing
 * for a crypto wallet (`window.ethereum`) — and an extension's own URL says so
 * outright. Three of them arrived from one visit to the public /infos page on
 * 02.10.2026 and read as app failures. Our code always names a script file:
 * /assets/*.js in a build, /src/*.tsx under Vite. Exported for the test.
 */
export function isInjectedScriptError(file: string | undefined): boolean {
  const f = (file || '').trim();
  if (!f) return false;
  if (/^(chrome|moz|safari(-web)?|webkit-masked-url)-?extension:|^webkit-masked-url:/i.test(f)) return true;
  let path = f;
  try { path = new URL(f, 'https://x.invalid').pathname; } catch { /* keep the raw string */ }
  return !/\.(m?js|[jt]sx?)$/i.test(path);
}

function installErrorLogging(): void {
  window.addEventListener('error', (e) => {
    // Resource load failures (img/script/css) surface here with no `error`.
    if (e.error || e.message) {
      const level = isOpaqueCrossOriginError(e) || isResizeObserverLoopNotice(e.message) || isInjectedScriptError(e.filename) ? 'warn' : 'error';
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
  window.addEventListener('offline', () => { noteWentOffline(); clientLog.warn('net.offline', 'went offline'); });
  // Routes live in the path, and the app moves between them with pushState —
  // which fires no event at all. Back/Forward does (popstate), and the two
  // fragment roots still fire hashchange; both are logged as one kind.
  const logNav = () => clientLog.info('nav.change', scrubTokens(location.pathname + location.search + (location.hash || '')));
  window.addEventListener('popstate', logNav);
  window.addEventListener('hashchange', logNav);
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
      // Which build this browser is actually running. A service worker can
      // pin a tab to a build for a long time, and without this line a
      // "Script error." that the current rules demote to a warning is
      // indistinguishable from one an older bundle still reports as an error
      // — happened 13.09.2026 on an iPad, and could not be settled either way.
      build: __BUILD_SHA__,
      ua: navigator.userAgent,
      lang: navigator.language,
      online: navigator.onLine,
      screen: `${window.screen?.width}x${window.screen?.height}`,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches,
      // Whether anybody could have been looking (a link preview, a page
      // reloaded in the background), and whether a script was driving it.
      visibility: document.visibilityState,
      webdriver: navigator.webdriver === true,
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

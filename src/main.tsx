import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import AdminConsole from './components/AdminConsole.tsx';
import SignaturePage from './components/SignaturePage.tsx';
import SurveyPage from './components/SurveyPage.tsx';
import GuidePage from './components/GuidePage.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import { UiHost } from './components/ui';
import { enableDemo, isDemoMode } from './lib/demo';
import { installLogging, clientLog, noteReloadingPage } from './lib/logger';
import {
  decideSwReload, recentSwReloads, noteSwReload, retryDelayMs, SW_RELOAD_STATE_KEY,
} from './lib/swReload';
import './index.css';

// Hidden demo entry: #/demo turns on throwaway client-side demo mode, then drops
// the hash (via replaceState, which doesn't fire hashchange) so the normal app
// renders as the demo coach — and a reload stays in the demo (flag in sessionStorage).
//
// This has to happen BEFORE logging is installed. The flag lives in
// sessionStorage, so on the first navigation to #/demo in a fresh tab it is not
// set yet — installing first latched shipping to "on" and the whole demo
// session posted clicks and device ids to the production API.
if (/^#\/?demo\/?$/i.test(window.location.hash)) {
  enableDemo();
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// FIRST thing that runs after the demo latch: patches fetch and the error
// handlers, so nothing that happens afterwards — including a failing boot —
// goes unrecorded.
installLogging({
  apiBase: (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '',
  // The demo is a promise of zero backend calls; shipping logs would break it.
  ship: !isDemoMode(),
});

// Whether a service worker was already in charge when the page loaded. Without
// this, the first-ever install reloads the page under a user who is mid-login.
const hadControllerAtStartup = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

// How often to ask whether a new build exists. This was every 15 seconds, which
// is not "check for updates" — it is a hammer. Paired with the reload below it
// only has to mis-fire once to become a page that reloads every few seconds,
// which is exactly what it did on iOS: the app was unusable, from start, with
// no way to work a list of games. Hourly, plus whenever the app comes back to
// the foreground, catches a deploy well within the time it matters.
const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const SW_UPDATE_MIN_GAP_MS = 5 * 60 * 1000;

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    clientLog.info('sw.registered', 'service worker registered');
    if (!registration) return;
    let lastCheck = Date.now();
    const check = () => {
      lastCheck = Date.now();
      Promise.resolve(registration.update()).catch(() => { /* ignore network/sandbox errors */ });
    };
    setInterval(check, SW_UPDATE_INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - lastCheck > SW_UPDATE_MIN_GAP_MS) check();
    });
  },
  onRegisterError(error) { clientLog.error('sw.error', 'service worker registration failed', { error }); },
});

// Auto-reload once a freshly deployed service worker takes control (no more
// stale builds) — but never out from under someone mid-observation. The form is
// 30+ fields plus two captured signatures held only in React state, so a deploy
// during a match used to wipe twenty minutes of work within fifteen seconds.
// The app raises this flag while a dirty feedback form is open; the reload then
// waits for the next navigation.
//
// It also refuses to do it in a loop. A worker that re-activates by itself —
// a failed install retried, a browser that evicted the old one, a build served
// inconsistently — turns "reload once to pick up the new build" into a page
// that reloads forever and cannot be used at all. Two things bound it: a
// reload never happens in the first minute of a page's life (a page that just
// started has nothing stale to escape), and no more than two happen in quick
// succession. What separates a loop from normal life is the spacing — a deploy
// is days apart, a loop is seconds — so the counter forgets itself after ten
// quiet minutes and a real update still lands. Past the bound the app stays on
// the build it has and says so in the log, which beats a screen nobody can read.
// The rule itself lives in lib/swReload.ts, where it can be tested without a
// browser; this is the wiring around it.
function swReloadsSoFar(): number {
  try { return recentSwReloads(sessionStorage.getItem(SW_RELOAD_STATE_KEY), Date.now()); }
  catch { return 0; }
}
function rememberSwReload(): void {
  try { sessionStorage.setItem(SW_RELOAD_STATE_KEY, noteSwReload(sessionStorage.getItem(SW_RELOAD_STATE_KEY), Date.now())); }
  catch { /* private mode */ }
}

if ('serviceWorker' in navigator) {
  let refreshing = false;
  let pendingReload = false;
  let lastSuppressLog = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const reloadIfSafe = async () => {
    if (refreshing) return;
    const uptimeMs = performance.now();
    const reloads = swReloadsSoFar();
    const decision = decideSwReload({ uptimeMs, reloadsSoFar: reloads });
    if (decision === 'too-soon') {
      // Deferred, not dropped. The old code returned here and nothing brought
      // the event back: the worker had already taken control, so the page ran
      // on against a precache that no longer holds its chunks — and the first
      // lazy import (the PDF builder) would fetch a URL the new build does not
      // have. Ask again as soon as the page is old enough.
      if (!retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; void reloadIfSafe(); }, retryDelayMs(uptimeMs));
      }
      return;
    }
    if (decision === 'looping') {
      // Keep the build we have; a page that reloads forever is worse than a
      // page one deploy behind. Only the log is rationed, because a worker in
      // a loop fires this every few seconds.
      if (Date.now() - lastSuppressLog > 60_000) {
        lastSuppressLog = Date.now();
        clientLog.warn('sw.reload.suppressed', 'service worker changed again — not reloading', {
          uptimeMs: Math.round(uptimeMs), reloads,
        });
      }
      return;
    }
    try {
      const flush = window.__svrzFlushDraft;
      // Raced, not awaited outright: a wedged IndexedDB must not be able to pin
      // the PWA to a dead build.
      if (flush) await Promise.race([flush(), new Promise((r) => setTimeout(r, 1500))]);
    } catch { /* fall through to the flag */ }
    // Still true only when the work genuinely exists nowhere else — private
    // browsing, blocked storage, demo, or a write that is failing. There the old
    // parking behaviour is exactly right and is kept unchanged.
    if (window.__svrzFormDirty) { pendingReload = true; return; }
    refreshing = true;
    rememberSwReload();
    clientLog.info('sw.controllerchange', 'new service worker took control — reloading');
    noteReloadingPage();
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The very first install also fires this, with no previous controller and
    // therefore no stale build to escape — reloading there just interrupts the
    // user's first visit for nothing.
    if (!hadControllerAtStartup) return;
    void reloadIfSafe();
  });
  // Retried whenever the form stops being dirty (sent, reset, or left).
  window.addEventListener('svrz:form-clean', () => { if (pendingReload) void reloadIfSafe(); });
}

// Hash routes: #/admin[/tab] -> admin console; #/sign/<slug> -> public
// signature page; #/survey/<token> -> public post-visit survey; #/guide[/de|en]
// -> the public video guide; anything else -> the app, which routes its own tabs.
const routeKind = (): 'admin' | 'sign' | 'survey' | 'guide' | 'app' => {
  const h = window.location.hash;
  if (/^#\/?admin(\/|$)/i.test(h)) return 'admin';
  if (/^#\/sign\//i.test(h)) return 'sign';
  if (/^#\/survey\//i.test(h)) return 'survey';
  if (/^#\/?guide(\/|$)/i.test(h)) return 'guide';
  return 'app';
};
let _route = routeKind();
window.addEventListener('hashchange', () => { const k = routeKind(); if (k !== _route) { _route = k; noteReloadingPage(); window.location.reload(); } });

const kind = routeKind();
clientLog.info('app.route', `mounting "${kind}"`, { hash: window.location.hash || undefined, demo: isDemoMode() });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
    <>
    {kind === 'admin' ? (
      // Deliberately NOT behind AuthGate. The admin page used to sit behind the
      // app's own login, which worked while a personal e-mail login existed to
      // establish who you were. It doesn't any more: the team credential is one
      // password everybody has, so putting it in front of the console would
      // mean the console's own password was the second of two prompts rather
      // than the only one that matters. The console asks for its own.
      <AdminConsole />
    ) : kind === 'sign' ? (
      <SignaturePage />
    ) : kind === 'guide' ? (
      // Public: this URL is what gets pasted into the coaches' group chat, and
      // asking someone to sign in before an explainer about signing in is a
      // circle. It reads and writes nothing.
      <GuidePage />
    ) : kind === 'survey' ? (
      // Public and unauthenticated: the coachee who receives the feedback mail
      // is a referee, not an app user — the token in the link is the whole key.
      <SurveyPage />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
    {/* Sibling of the routed page, not a wrapper: confirm dialogs and toasts
        are driven imperatively from module scope, so every route — app, admin,
        signature and survey alike — needs the host on screen, and none of them
        should have to render it itself. */}
    <UiHost />
    </>
    </ErrorBoundary>
  </StrictMode>,
);

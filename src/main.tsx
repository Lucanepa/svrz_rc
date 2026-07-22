import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import AdminConsole from './components/AdminConsole.tsx';
import SignaturePage from './components/SignaturePage.tsx';
import SurveyPage from './components/SurveyPage.tsx';
import ErrorBoundary from './components/ErrorBoundary.tsx';
import { enableDemo, isDemoMode } from './lib/demo';
import { installLogging, clientLog } from './lib/logger';
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

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    clientLog.info('sw.registered', 'service worker registered');
    if (registration) {
      setInterval(() => { Promise.resolve(registration.update()).catch(() => { /* ignore network/sandbox errors */ }); }, 15 * 1000);
    }
  },
  onRegisterError(error) { clientLog.error('sw.error', 'service worker registration failed', { error }); },
});

// Auto-reload once a freshly deployed service worker takes control (no more
// stale builds) — but never out from under someone mid-observation. The form is
// 30+ fields plus two captured signatures held only in React state, so a deploy
// during a match used to wipe twenty minutes of work within fifteen seconds.
// The app raises this flag while a dirty feedback form is open; the reload then
// waits for the next navigation.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  let pendingReload = false;
  const reloadIfSafe = () => {
    if (refreshing) return;
    if (window.__svrzFormDirty) { pendingReload = true; return; }
    refreshing = true;
    clientLog.info('sw.controllerchange', 'new service worker took control — reloading');
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The very first install also fires this, with no previous controller and
    // therefore no stale build to escape — reloading there just interrupts the
    // user's first visit for nothing.
    if (!hadControllerAtStartup) return;
    reloadIfSafe();
  });
  // Retried whenever the form stops being dirty (sent, reset, or left).
  window.addEventListener('svrz:form-clean', () => { if (pendingReload) reloadIfSafe(); });
}

// Hash routes: #/admin[/tab] -> admin console; #/sign/<slug> -> public
// signature page; #/survey/<token> -> public post-visit survey; anything else
// -> the app, which routes its own tabs.
const routeKind = (): 'admin' | 'sign' | 'survey' | 'app' => {
  const h = window.location.hash;
  if (/^#\/?admin(\/|$)/i.test(h)) return 'admin';
  if (/^#\/sign\//i.test(h)) return 'sign';
  if (/^#\/survey\//i.test(h)) return 'survey';
  return 'app';
};
let _route = routeKind();
window.addEventListener('hashchange', () => { const k = routeKind(); if (k !== _route) { _route = k; window.location.reload(); } });

const kind = routeKind();
clientLog.info('app.route', `mounting "${kind}"`, { hash: window.location.hash || undefined, demo: isDemoMode() });
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
    {kind === 'admin' ? (
      // Admin sits behind the SAME login as the app: hitting #/admin while
      // logged out shows the normal e-mail/password screen and lands on the
      // console afterwards (an is_admin PIN session already counts as admin,
      // so no second password prompt appears).
      <AuthGate>
        <AdminConsole />
      </AuthGate>
    ) : kind === 'sign' ? (
      <SignaturePage />
    ) : kind === 'survey' ? (
      // Public and unauthenticated: the coachee who receives the feedback mail
      // is a referee, not an app user — the token in the link is the whole key.
      <SurveyPage />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
    </ErrorBoundary>
  </StrictMode>,
);

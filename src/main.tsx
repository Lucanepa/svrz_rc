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
import { hasUnsavedWork, onUnsavedWorkChange } from './lib/unsavedWork';
import './index.css';

// FIRST thing that runs: patches fetch and the error handlers, so nothing that
// happens afterwards — including a failing boot — goes unrecorded.
installLogging({
  apiBase: (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim() || '',
  // The demo is a promise of zero backend calls; shipping logs would break it.
  ship: !isDemoMode(),
});

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
// stale builds) — but never on top of a half-filled observation. The form is
// in-memory only and a deploy lands near-daily, so an unconditional reload
// would silently wipe a form a coach spent a match filling. The reload is held
// until the work is submitted or cleared; until then the running build stays.
if ('serviceWorker' in navigator) {
  let refreshing = false;
  const reloadNow = () => {
    if (refreshing) return;
    refreshing = true;
    clientLog.info('sw.controllerchange', 'new service worker took control — reloading');
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (!hasUnsavedWork()) { reloadNow(); return; }
    clientLog.info('sw.reload-deferred', 'new build ready — reload deferred, form in progress');
    const stop = onUnsavedWorkChange(() => {
      if (hasUnsavedWork()) return;
      stop();
      reloadNow();
    });
  });
}

// The same in-memory form deserves the browser's own "leave site?" prompt:
// closing the tab or hitting back mid-observation is just as lossy as a deploy.
window.addEventListener('beforeunload', (e) => {
  if (!hasUnsavedWork()) return;
  e.preventDefault();
  e.returnValue = '';
});

// Hidden demo entry: #/demo turns on throwaway client-side demo mode, then drops
// the hash (via replaceState, which doesn't fire hashchange) so the normal app
// renders as the demo coach — and a reload stays in the demo (flag in sessionStorage).
if (/^#\/?demo\/?$/i.test(window.location.hash)) {
  enableDemo();
  history.replaceState(null, '', window.location.pathname + window.location.search);
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

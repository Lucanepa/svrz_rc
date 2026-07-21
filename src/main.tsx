import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import AdminConsole from './components/AdminConsole.tsx';
import SignaturePage from './components/SignaturePage.tsx';
import { enableDemo } from './lib/demo';
import './index.css';

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (registration) {
      setInterval(() => { Promise.resolve(registration.update()).catch(() => { /* ignore network/sandbox errors */ }); }, 15 * 1000);
    }
  },
});

// Auto-reload once a freshly deployed service worker takes control (no more stale builds).
if ('serviceWorker' in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// Hidden demo entry: #/demo turns on throwaway client-side demo mode, then drops
// the hash (via replaceState, which doesn't fire hashchange) so the normal app
// renders as the demo coach — and a reload stays in the demo (flag in sessionStorage).
if (/^#\/?demo\/?$/i.test(window.location.hash)) {
  enableDemo();
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

// Hash routes: #/admin -> admin console; #/sign/<slug> -> public signature page
const routeKind = (): 'admin' | 'sign' | 'app' => {
  const h = window.location.hash;
  if (/^#\/?admin$/i.test(h)) return 'admin';
  if (/^#\/sign\//i.test(h)) return 'sign';
  return 'app';
};
let _route = routeKind();
window.addEventListener('hashchange', () => { const k = routeKind(); if (k !== _route) { _route = k; window.location.reload(); } });

const kind = routeKind();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {kind === 'admin' ? (
      <AdminConsole />
    ) : kind === 'sign' ? (
      <SignaturePage />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);

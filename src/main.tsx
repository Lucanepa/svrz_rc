import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import AdminConsole from './components/AdminConsole.tsx';
import SignaturePage from './components/SignaturePage.tsx';
import './index.css';

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (registration) {
      setInterval(() => { try { registration.update(); } catch { /* ignore (e.g. sandboxed preview/iframe) */ } }, 15 * 1000);
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

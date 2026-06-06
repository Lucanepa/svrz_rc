import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {registerSW} from 'virtual:pwa-register';
import App from './App.tsx';
import AuthGate from './components/AuthGate.tsx';
import AdminConsole from './components/AdminConsole.tsx';
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

// Simple hash route: #/admin -> admin console (own password gate)
const isAdminRoute = () => window.location.hash.replace(/^#\/?/, '').toLowerCase() === 'admin';
let _wasAdmin = isAdminRoute();
window.addEventListener('hashchange', () => { if (isAdminRoute() !== _wasAdmin) { _wasAdmin = isAdminRoute(); window.location.reload(); } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isAdminRoute() ? (
      <AdminConsole />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </StrictMode>,
);

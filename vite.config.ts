import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import path from 'path';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const buildSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();

export default defineConfig(({mode}) => {
  return {
    base: mode === 'production' ? '/svrz_rc/' : '/',
    plugins: [
      react(), 
      tailwindcss(),
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          clientsClaim: true,
          skipWaiting: true,
          // SPA shell precache already handles offline app loading. These runtime
          // rules make the DATA work offline too:
          runtimeCaching: [
            {
              // All API GETs (coachees, games, observations, rc-overview, auth/me,
              // settings…) — NetworkFirst: fresh when online, last-synced when not.
              urlPattern: /\/api\/.*/i,
              method: 'GET',
              handler: 'NetworkFirst',
              options: {
                cacheName: 'svrz-api-get',
                networkTimeoutSeconds: 6,
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 },
                matchOptions: { ignoreVary: true },
              },
            },
            // NOTE: feedback POSTs are deliberately NOT handled here. Workbox
            // Background Sync drops a queued request whenever its replay returns
            // any non-2xx (expired session, closed role, validation), silently
            // losing feedback. Offline submissions are instead held in an
            // app-owned IndexedDB outbox (src/lib/offlineQueue.ts) that reports
            // real per-item status and never drops on failure.
          ],
        },
        includeAssets: ['favicon.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'SR-Coaching Feedback',
          short_name: 'SR-Coaching',
          description: 'Swiss Volley Region Zürich – Schiedsrichter-Coaching',
          lang: 'de',
          theme_color: '#dc2626',
          background_color: '#ffffff',
          display: 'standalone',
          orientation: 'portrait',
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
            { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
            { src: 'pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        }
      })
    ],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(''),
      __BUILD_SHA__: JSON.stringify(buildSha),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      proxy: {
        '/api': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
  };
});

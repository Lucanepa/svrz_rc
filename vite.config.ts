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
            {
              // Feedback submissions made offline are queued and replayed by the
              // browser when connectivity returns (survives app close on browsers
              // with Background Sync; otherwise replays on next app open online).
              urlPattern: /\/api\/feedback\/submit$/i,
              method: 'POST',
              handler: 'NetworkOnly',
              options: {
                backgroundSync: {
                  name: 'svrz-feedback-queue',
                  options: { maxRetentionTime: 60 * 24 * 7 }, // minutes → 7 days
                },
              },
            },
          ],
        },
        manifest: {
          name: 'SR-Coaching Feedback',
          short_name: 'SR-Coaching',
          theme_color: '#ffffff'
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

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import path from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { createRequire } from 'node:module';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const buildSha = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return 'dev'; }
})();

// The released version, from package.json — bumped with `npm version patch|minor|major`.
// The SHA answers "exactly which build is this?" for a bug report; the version
// answers "which release am I looking at?", which is the question a referee
// holding a printed form can actually ask.
const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

/**
 * pdf.js's replacements for the fonts a PDF names but does not embed.
 *
 * Without them the reader draws a document that uses plain Helvetica or Arial —
 * which is most of what SVRZ publishes — with the wrong glyph for every
 * character: the text is extractable and searchable, and unreadable on screen.
 * They are 16 files of about 50 KB, fetched only by a document that needs one,
 * so they are copied beside the build rather than bundled into it.
 */
function pdfjsStandardFonts() {
  const dir = path.join(path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts');
  const prefix = '/pdfjs/standard_fonts/';
  return {
    name: 'pdfjs-standard-fonts',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (body: Buffer) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        // basename, so the URL cannot walk out of the font directory.
        const file = path.join(dir, path.basename(req.url.split('?')[0]));
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: Buffer }) => void }) {
      for (const name of readdirSync(dir)) {
        this.emitFile({ type: 'asset', fileName: `pdfjs/standard_fonts/${name}`, source: readFileSync(path.join(dir, name)) });
      }
    },
  };
}

export default defineConfig(() => {
  return {
    // Root, in every mode. The old `/svrz_rc/` subpath existed only because
    // GitHub Pages served this as a project page; on its own domain the app
    // owns the root, and dev/prod no longer disagree about where assets live.
    base: '/',
    plugins: [
      pdfjsStandardFonts(),
      react(), 
      tailwindcss(),
      VitePWA({
        // 'prompt', not 'autoUpdate' — and nothing here prompts anybody. In
        // autoUpdate the plugin installs its OWN reload on controllerchange,
        // next to the guarded one in main.tsx: it does not wait for a dirty
        // observation to be flushed, and it has no idea whether it has already
        // reloaded this page ten times. workbox still skipWaiting/clientsClaim
        // below, so a new build takes control exactly as promptly as before —
        // the difference is that main.tsx decides when the page reloads for it.
        registerType: 'prompt',
        workbox: {
          clientsClaim: true,
          skipWaiting: true,
          // The default only precaches js/css/html, which left everything else
          // Vite emits into assets/ out of the shell: the header logo and the
          // Inter woff2 files. That is invisible online — but once the service
          // worker controls the page it answers those requests with a fetch()
          // that fails offline and never falls back to the HTTP cache, so an
          // offline reload showed broken-image alt text where the SVRZ logo is
          // and dropped the app to a system font. PDFs stay out on purpose:
          // docs/ is over a megabyte of guides nobody needs cached to file an
          // observation — the reader keeps the ones a coach actually opens, in
          // its own Cache Storage bucket (src/lib/docCache.ts).
          //
          // `mjs` is here for one file: pdf.js ships its worker as an ES module,
          // and a reader whose worker 404s offline is a reader that only works
          // in the one place nobody needs it.
          globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff,woff2}'],
          // …but not the PDF reader. pdf.js and its worker are 1.7 MB, and
          // precaching them would put that on every install and every update,
          // for everyone — including the coaches who only ever file
          // observations. They are cached the first time somebody opens a
          // document instead (the CacheFirst rule below), and "Alle offline
          // speichern" pulls them in with the documents.
          globIgnores: ['**/pdf.worker*.mjs', '**/PdfReader-*.js'],
          // Anything under docs/ is a real file, not an app route. Without the
          // denylist the navigation fallback answered a click on the SR-Technik
          // guide with the app shell — an HTML page where a PDF was expected.
          navigateFallbackDenylist: [/^\/?docs\//, /\/docs\//, /\.pdf$/i],
          // SPA shell precache already handles offline app loading. These runtime
          // rules make the DATA work offline too:
          runtimeCaching: [
            {
              // The reader's own code: fingerprinted by the build, so once a
              // browser has a copy of this exact file it never needs another.
              urlPattern: ({ url, sameOrigin }: { url: URL; sameOrigin: boolean }) =>
                sameOrigin && (/\/(pdf\.worker[^/]*\.mjs|PdfReader-[^/]*\.js)$/.test(url.pathname)
                  || url.pathname.startsWith('/pdfjs/standard_fonts/')),
              handler: 'CacheFirst',
              options: {
                cacheName: 'svrz-pdf-reader',
                cacheableResponse: { statuses: [200] },
                expiration: { maxEntries: 24, maxAgeSeconds: 60 * 60 * 24 * 180 },
              },
            },
            {
              // All API GETs (coachees, games, observations, rc-overview, auth/me,
              // settings…) — NetworkFirst: fresh when online, last-synced when not.
              // A callback, not a RegExp: Workbox only applies a RegExp route to a
              // cross-origin request when the match starts at index 0, and in
              // production the API is a different origin (rc-api.lucanepa.com) —
              // so the pattern matched nothing and offline data never worked.
              // /api/events is a live stream, not a document: caching it would
              // store a response that never ends, and replaying it offline would
              // hand the app an hour-old frame as if it had just arrived.
              // /api/docs/* is a 7 MB PDF that the reader already keeps in its
              // own cache; storing a second copy here would double the space
              // for nothing and push real API responses out of a 300-entry
              // cache.
              urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/')
                && url.pathname !== '/api/events'
                && !url.pathname.startsWith('/api/docs/'),
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
      __BUILD_SHA__: JSON.stringify(buildSha),
      __APP_VERSION__: JSON.stringify(appVersion),
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
          // On a developer laptop :8787 is the local API. On lenovoserver it is
          // the PRODUCTION container — so an unstubbed call from a dev or e2e
          // page lands in the live database and the live log. The e2e config
          // points this at a closed port for exactly that reason; override it
          // the same way when running `npm run dev` on the server.
          target: process.env.DEV_API_TARGET || 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },
  };
});

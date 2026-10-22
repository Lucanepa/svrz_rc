import { defineConfig, devices } from '@playwright/test';

// Not Vite's default 4173. `reuseExistingServer` adopts whatever is already on
// the port, so on a machine running several projects the default is exactly the
// port something else has taken — and the suite then tests that app instead,
// failing everywhere for reasons that look like a regression in this one.
// globalSetup checks the served page really is ours before any test runs.
const PORT = Number(process.env.E2E_PORT || 4374);
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

// The logger files every error from a browser that says it is driven by a
// script (navigator.webdriver) as a warning — and Playwright's browser says
// exactly that, so every spec that expects an error line would see a warning.
// Chromium is started with the automation marker off instead: the page then
// looks like a person's browser, the app needs no hook for the suite, and the
// one spec that tests the rule (e2e/automated-visit.spec.ts) sets
// navigator.webdriver back to true itself.
const AS_A_PERSON = { args: ['--disable-blink-features=AutomationControlled'] };

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/support/assert-right-app.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Three of the runner's four cores. It was ONE, the template's default, and
  // the suite took 12–17 minutes per push — every test is stubbed at the
  // network boundary and runs fully parallel here at home, so nothing about
  // it needs a single lane. The fourth core is left for the Vite server.
  workers: process.env.CI ? 3 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions: AS_A_PERSON },
    },
    {
      name: 'mobile-chrome',
      // Chromium on a phone viewport. This is also the closest thing the suite
      // has to Samsung Internet, Edge and Opera — all Chromium underneath.
      use: { ...devices['Pixel 5'], launchOptions: AS_A_PERSON },
    },
    // WebKit — Safari's engine — behind a flag, because it needs system
    // libraries this box does not have (`sudo npx playwright install-deps
    // webkit`, then `E2E_WEBKIT=1 npm test`). Worth running before a release:
    // it catches WebKit-only layout and JS differences that Chromium hides.
    //
    // It is NOT iOS Safari. The Linux build has its own service-worker and
    // storage behaviour, and nothing here reproduces an iPhone's PWA lifecycle
    // — the reload storm of 09.09.2026 would not have shown up in it. For that
    // the honest instruments are a real device and the activity log, which
    // records sw.registered / sw.controllerchange / sw.reload.suppressed per
    // session.
    ...(process.env.E2E_WEBKIT ? [{
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    }] : []),
  ],
  webServer: {
    command: `npx vite --port=${PORT} --strictPort`,
    // An e2e run must not be able to reach production, and on lenovoserver it
    // could: the dev proxy forwards /api to :8787, which there is the LIVE API
    // container. Every run filed its clicks in the real activity log (as
    // `cors.blocked`, since the origin is localhost) and asked the live backend
    // who was signed in. The suite stubs what it needs, so the proxy points at a
    // closed port: anything unstubbed now fails loudly instead of quietly
    // talking to production.
    // The logger's edge probe goes to the live Cloudflare edge by default
    // (src/lib/logger.ts, EDGE_PROBE_URL). Same rule: a closed local port, so
    // an unstubbed probe reads "edge down" instead of reaching production.
    // e2e/support/app.ts answers it for every spec that signs in.
    env: { VITE_API_BASE_URL: '', DEV_API_TARGET: 'http://127.0.0.1:9', VITE_EDGE_PROBE_URL: 'http://127.0.0.1:9/edge-probe.txt' },
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});

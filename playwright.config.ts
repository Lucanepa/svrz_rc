import { defineConfig, devices } from '@playwright/test';

// Not Vite's default 4173. `reuseExistingServer` adopts whatever is already on
// the port, so on a machine running several projects the default is exactly the
// port something else has taken — and the suite then tests that app instead,
// failing everywhere for reasons that look like a regression in this one.
// globalSetup checks the served page really is ours before any test runs.
const PORT = Number(process.env.E2E_PORT || 4374);
const BASE_URL = process.env.E2E_BASE_URL || `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/support/assert-right-app.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: `npx vite --port=${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    stdout: 'ignore',
    stderr: 'ignore',
  },
});

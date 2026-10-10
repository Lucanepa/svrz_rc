import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * The start-failure net in index.html (2026-10-10).
 *
 * A browser that could not run the bundle used to show a blank white page and
 * report nothing — Manuel's laptop never reached the API once in 30 days. Now
 * the page says what is wrong, and one `boot.fail` line reaches the Protokoll.
 * The entry module is swapped for one that cannot run, which is what an old
 * browser makes of the real one.
 */

const ENTRY = '**/src/main.tsx*';

function bootFailReports(page: Page): Request[] {
  const seen: Request[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/client-logs') && (r.postData() || '').includes('boot.fail')) seen.push(r);
  });
  return seen;
}

test('a browser that cannot run the app is told so, and the log hears of it', async ({ page }) => {
  const reports = bootFailReports(page);
  await page.route('**/api/client-logs', (r) => r.fulfill({ status: 202, json: { ok: true } }));
  // A syntax error, as an engine too old for the bundle's syntax sees it.
  await page.route(ENTRY, (r) => r.fulfill({ contentType: 'application/javascript', body: 'const = ;' }));
  await page.goto('/');

  const alert = page.locator('[data-boot-fail]');
  await expect(alert).toHaveAttribute('data-boot-fail', 'browser', { timeout: 10_000 });
  await expect(alert).toContainText('Die App kann in diesem Browser nicht starten.');
  await expect(alert).toContainText('The app cannot start in this browser.');
  // What a coach screenshots and sends is what names the browser.
  await expect(alert).toContainText(/Browser: Mozilla/);

  await expect.poll(() => reports.length).toBe(1);
  const body = JSON.parse(reports[0].postData() || '{}');
  expect(reports[0].headers()['content-type']).toContain('text/plain');
  expect(body.did).toBeTruthy();
  expect(body.entries[0]).toMatchObject({ lvl: 'error', evt: 'boot.fail' });
  expect(body.entries[0].data).toMatchObject({ reason: 'not supported', path: '/', modules: true });
  expect(body.entries[0].data.errors.join(' ')).toMatch(/SyntaxError|Unexpected|unexpected/);
});

test('a bundle that never arrived asks for the connection, not a new browser', async ({ page }) => {
  const reports = bootFailReports(page);
  await page.route('**/api/client-logs', (r) => r.fulfill({ status: 202, json: { ok: true } }));
  await page.route(ENTRY, (r) => r.abort('failed'));
  await page.goto('/games');

  const alert = page.locator('[data-boot-fail]');
  await expect(alert).toHaveAttribute('data-boot-fail', 'network', { timeout: 10_000 });
  await expect(alert).toContainText('Die App konnte nicht geladen werden.');
  await expect.poll(() => reports.length).toBe(1);
  const entry = JSON.parse(reports[0].postData() || '{}').entries[0];
  expect(entry.data).toMatchObject({ reason: 'not loaded', path: '/games' });
});

test('an app that started shows nothing and files nothing', async ({ page }) => {
  const reports = bootFailReports(page);
  await stubSignedInApp(page);
  await page.goto('/');
  await expect(page.getByRole('navigation').first()).toBeVisible();
  // Past the net's grace period (load + 3 s).
  await page.waitForTimeout(4_500);
  await expect(page.locator('[data-boot-fail]')).toHaveCount(0);
  expect(reports).toHaveLength(0);
});

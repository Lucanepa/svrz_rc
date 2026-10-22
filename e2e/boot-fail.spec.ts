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

// 16.10.2026, a crawler on OVH (142.44.187.197): the user agent said Edge 122,
// the error said "Unexpected token ?" — which no Edge since 80 says. An old
// engine behind a borrowed user agent, mailed as a coach who cannot start the
// app. The net now asks the engine itself whether it reads `?.` and `??`.
const EDGE_122 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';

/** The one line the net sends, once it has sent it. */
async function bootFailEntry(reports: Request[]): Promise<{ lvl: string; evt: string; data: Record<string, unknown> }> {
  await expect.poll(() => reports.length, { timeout: 10_000 }).toBe(1);
  return JSON.parse(reports[0].postData() || '{}').entries[0];
}

test.describe('a user agent that claims more than its engine can do', () => {
  test.use({ userAgent: EDGE_122 });

  test('is filed as a warning', async ({ page }) => {
    const reports = bootFailReports(page);
    // What an old engine makes of the probe: the optional chain does not parse.
    await page.addInitScript(() => {
      const Real = Function;
      (window as unknown as { Function: unknown }).Function = new Proxy(Real, {
        construct(target, args) {
          if (String(args[args.length - 1]).includes('?.')) throw new SyntaxError("Unexpected token '?'");
          return Reflect.construct(target, args);
        },
      });
    });
    await page.route('**/api/client-logs', (r) => r.fulfill({ status: 202, json: { ok: true } }));
    await page.route(ENTRY, (r) => r.fulfill({ contentType: 'application/javascript', body: 'const = ;' }));
    await page.goto('/');
    await expect(page.locator('[data-boot-fail]')).toHaveAttribute('data-boot-fail', 'browser', { timeout: 10_000 });
    const entry = await bootFailEntry(reports);
    expect(entry).toMatchObject({ lvl: 'warn', evt: 'boot.fail' });
    expect(entry.data).toMatchObject({ parses: false, reason: 'not supported' });
  });

  test('but a current engine that fails on our syntax is still an error', async ({ page }) => {
    // Never "modern user agent + SyntaxError = warning": that would hide our
    // own syntax shipping past what a real browser supports.
    const reports = bootFailReports(page);
    await page.route('**/api/client-logs', (r) => r.fulfill({ status: 202, json: { ok: true } }));
    await page.route(ENTRY, (r) => r.fulfill({ contentType: 'application/javascript', body: 'const = ;' }));
    await page.goto('/');
    const entry = await bootFailEntry(reports);
    expect(entry).toMatchObject({ lvl: 'error', evt: 'boot.fail' });
    expect(entry.data).toMatchObject({ parses: true, webdriver: false });
  });
});

test('a browser driven by a script files its boot failure as a warning', async ({ page }) => {
  const reports = bootFailReports(page);
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => true, configurable: true });
  });
  await page.route('**/api/client-logs', (r) => r.fulfill({ status: 202, json: { ok: true } }));
  await page.route(ENTRY, (r) => r.fulfill({ contentType: 'application/javascript', body: 'const = ;' }));
  await page.goto('/');
  const entry = await bootFailEntry(reports);
  expect(entry).toMatchObject({ lvl: 'warn', evt: 'boot.fail' });
  expect(entry.data).toMatchObject({ webdriver: true });
});

test('a rejection whose reason cannot be added to a string is still noted', async ({ page }) => {
  // Adding a Symbol to a string throws. The listener used to throw with it,
  // and the reason never reached the line.
  const reports = bootFailReports(page);
  await page.route('**/api/client-logs', (r) => r.fulfill({ status: 202, json: { ok: true } }));
  await page.route(ENTRY, (r) => r.fulfill({ contentType: 'application/javascript', body: 'Promise.reject(Symbol("odd"));' }));
  await page.goto('/');
  const entry = await bootFailEntry(reports);
  expect(entry.data.errors).toContain('unhandled rejection: Symbol(odd)');
});

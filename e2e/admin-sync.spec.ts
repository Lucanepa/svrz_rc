import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The games import and the activity log, from the admin console.
//
// The import button had gone missing: it lived on AdminPanel, a screen the app
// stopped routing to, so the only way to run an import was to wait for the
// nightly cron. The log, meanwhile, rendered every entry as one unbreakable
// row of shrink-0 metadata, which on a phone left the message itself a column
// two characters wide.

const SYNC_STATUS = {
  status: { at: new Date().toISOString(), ok: true, imported: 4, totalFetched: 120 },
  newestGame: new Date().toISOString(),
  cron: '0 5 * * *',
};

/** The console's own endpoints on top of the app-wide stubs. */
async function stubAdminConsole(page: import('@playwright/test').Page) {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/games/sync-status', (r) => r.fulfill({ json: SYNC_STATUS }));
  await page.route('**/api/admin/logs?*', (r) => r.fulfill({
    json: {
      entries: [{
        seq: 1,
        t: new Date().toISOString(),
        lvl: 'debug',
        src: 'client',
        evt: 'net.fetch',
        msg: 'GET https://svrz-rc-api.openvolley.app/api/admin/coachees/sync-contacts 500',
        user: 'Luca Canepa',
      }],
      total: 1,
      lastSeq: 1,
      stats: { size: 1, max: 20000, fileSink: true, dir: '/logs' },
    },
  }));
  await page.route('**/api/admin/logs/sessions', (r) => r.fulfill({ json: { sessions: [] } }));
}

test.describe('Game import', () => {
  test('the settings tab can run the import and reports what it did', async ({ page }) => {
    await stubAdminConsole(page);
    let posted = 0;
    await page.route('**/api/games/sync', (r) => {
      posted += 1;
      return r.fulfill({ json: { imported: 7, totalFetched: 231, from: '', to: '' } });
    });

    await page.goto('/#/admin');
    await page.getByRole('button', { name: /Einstellungen|Settings/ }).click();
    await page.getByRole('button', { name: /Jetzt importieren|Import now/ }).click();

    await expect(page.getByText(/7 (Spiele importiert|games imported)/)).toBeVisible();
    expect(posted).toBe(1);
  });

  test('a failed import shows the reason the API gave, not "Internal server error"', async ({ page }) => {
    await stubAdminConsole(page);
    await page.route('**/api/games/sync', (r) => r.fulfill({
      status: 500,
      json: { error: 'Could not open the VolleyManager game list (role: club).' },
    }));

    await page.goto('/#/admin');
    await page.getByRole('button', { name: /Einstellungen|Settings/ }).click();
    await page.getByRole('button', { name: /Jetzt importieren|Import now/ }).click();

    await expect(page.getByText(/Could not open the VolleyManager game list/)).toBeVisible();
    // The body is JSON; putting it on screen raw is the bug this replaced.
    await expect(page.getByText(/^\{/)).toHaveCount(0);
  });
});

test.describe('Activity log', () => {
  test('a log message keeps a readable width on a phone', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await stubAdminConsole(page);
    await page.goto('/#/admin');
    await page.getByRole('button', { name: /Protokoll|Activity log/ }).click();

    const msg = page.getByText(/api\/admin\/coachees\/sync-contacts 500/);
    await expect(msg).toBeVisible();
    // It gets its own full-width line under the metadata. Before, it was the
    // only element allowed to shrink and ended up a few dozen pixels wide.
    const box = (await msg.boundingBox())!;
    const viewport = page.viewportSize()!.width;
    expect(box.width).toBeGreaterThan(viewport * 0.6);
  });

  test('the log does not push the page sideways on a phone', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'Mobile viewport only');
    await stubAdminConsole(page);
    await page.goto('/#/admin');
    await page.getByRole('button', { name: /Protokoll|Activity log/ }).click();
    await expect(page.getByText(/api\/admin\/coachees\/sync-contacts 500/)).toBeVisible();

    const overflow = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport + 1);
  });
});

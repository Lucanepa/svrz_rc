import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// What the console says before it knows anything.
//
// Every card here starts with an empty state that looks exactly like an answer:
// no sync status reads as "the nightly import is broken" (in red), an unread
// test_mode reads as "e-mails are going out", an empty coachee list reads as
// "nobody is being coached this season". All three were on screen for as long
// as their request took, on every single load.

/** A route that answers only when the test says so.
 *
 *  Awaited before the page is opened, not merely started: `page.route` installs
 *  over CDP, and on a loaded machine that can land after the app has already
 *  asked. The request then fell through to the catch-all in stubSignedInApp,
 *  which answers `[]` — settings with no season in them — and the test failed
 *  one assertion later, looking like a bug in the code under test. */
async function gated(page: Page, url: string, json: unknown) {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => { open = resolve; });
  await page.route(url, async (route) => { await held; await route.fulfill({ json }); });
  return { open: () => open() };
}

const SETTINGS = {
  default_season: 2026, test_mode: true, groups: ['Beförderung'],
  coachee_targets: {}, rc_mandates: {}, default_goal: 10,
};
const SYNC = { status: { at: new Date().toISOString(), ok: true, imported: 4, totalFetched: 120 }, newestGame: new Date().toISOString(), cron: '0 5 * * *' };

test('the console holds its answers until it has them', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const settings = await gated(page, '**/api/settings', SETTINGS);
  const sync = await gated(page, '**/api/admin/games/sync-status', SYNC);
  const manual = await gated(page, '**/api/admin/games/manual*', []);

  await page.goto('/#/admin');
  await page.getByRole('button', { name: /Einstellungen|Settings/ }).click();

  // Nothing is known yet, so nothing may be claimed.
  await expect(page.getByText(/Status nicht abrufbar|Status unavailable/)).toHaveCount(0);
  // The card's own hint says "wenn aktiv, werden keine E-Mails versendet" at
  // all times; what must not appear is the STATE line under it, either way.
  await expect(page.getByText(/AUS — E-Mails werden versendet|OFF — emails are sent/)).toHaveCount(0);
  await expect(page.getByText(/AN — es werden keine E-Mails versendet|ON — no emails are sent/)).toHaveCount(0);
  await expect(page.getByText(/Keine Testspiele vorhanden|No test games/)).toHaveCount(0);
  // ...and the alarm colour is not worn while waiting for the thing it alarms about.
  await expect(page.locator('.bg-red-50', { hasText: /Spiel-Import|Game import/ })).toHaveCount(0);

  settings.open();
  sync.open();
  manual.open();

  // Now they may.
  await expect(page.getByText(/4 importiert|4 imported/)).toBeVisible();
  await expect(page.getByText(/Keine Testspiele vorhanden|No test games/)).toBeVisible();
  // test_mode is ON in this fixture, which is the case the old code got backwards.
  await expect(page.getByText(/AN — es werden keine E-Mails versendet|ON — no emails are sent/)).toBeVisible();
});

test('the coachee list waits for the season it is filtered by', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({
    json: [
      { id: 'c1', full_name: 'This Season', email: 'a@example.ch', season: 2026 },
      { id: 'c2', full_name: 'Last Season', email: 'b@example.ch', season: 2025 },
    ],
  }));
  const settings = await gated(page, '**/api/settings', SETTINGS);

  await page.goto('/#/admin');
  // Anchored on a control that does not depend on any fetch, so the absence
  // checks below cannot pass merely because nothing has rendered yet.
  await expect(page.getByLabel(/xlsx importieren|Import xlsx/)).toBeAttached();

  // The local guess for "current season" is August's, not the stored answer, so
  // showing rows now means showing last season's people under this season's
  // heading — which is what happened.
  await expect(page.getByText('Season, Last')).toHaveCount(0);
  await expect(page.getByText('Season, This')).toHaveCount(0);

  settings.open();
  await expect(page.getByText('Season, This')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Season, Last')).toHaveCount(0);
});

test('the console asks once, not on every render', async ({ page }) => {
  // The guard that drops stale answers is handed to `useCallback` as a
  // dependency, so it has to keep its identity across renders. A fresh object
  // per render re-creates the loader, which re-runs the effect that calls it,
  // which sets state, which renders again — a list that reloads itself forever,
  // and every answer stale by the time it lands.
  await stubSignedInApp(page, { admin: true });
  let coacheeCalls = 0;
  await page.route('**/api/coachees*', (r) => { coacheeCalls += 1; return r.fulfill({ json: [] }); });
  let logCalls = 0;
  await page.route('**/api/admin/logs?*', (r) => { logCalls += 1; return r.fulfill({ json: { entries: [], total: 0, lastSeq: 0, stats: {} } }); });

  await page.goto('/#/admin');
  await expect(page.getByLabel(/xlsx importieren|Import xlsx/)).toBeAttached();
  await page.waitForTimeout(800);
  const settled = coacheeCalls;
  await page.waitForTimeout(1500);

  // Counted twice rather than compared to a number: StrictMode mounts every
  // effect twice in dev, so "how many" is not the property — "does it stop" is.
  expect(coacheeCalls).toBe(settled);
  expect(coacheeCalls).toBeLessThan(4);
  // The log tail polls every three seconds — and only while its own tab is open.
  expect(logCalls).toBe(0);
});

import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// What the console says before it knows anything.
//
// Every card here starts with an empty state that looks exactly like an answer:
// no sync status reads as "the nightly import is broken" (in red), an unread
// test_mode reads as "e-mails are going out", an empty coachee list reads as
// "nobody is being coached this season". All three were on screen for as long
// as their request took, on every single load.

/** A route that answers only when the test says so. */
function gated(page: Page, url: string, json: unknown) {
  let open: () => void = () => {};
  const held = new Promise<void>((resolve) => { open = resolve; });
  const routed = page.route(url, async (route) => { await held; await route.fulfill({ json }); });
  return { open: async () => { await routed; open(); } };
}

const SETTINGS = {
  default_season: 2026, test_mode: true, groups: ['Beförderung'],
  coachee_targets: {}, rc_mandates: {}, default_goal: 10,
};
const SYNC = { status: { at: new Date().toISOString(), ok: true, imported: 4, totalFetched: 120 }, newestGame: new Date().toISOString(), cron: '0 5 * * *' };

test('the console holds its answers until it has them', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const settings = gated(page, '**/api/settings', SETTINGS);
  const sync = gated(page, '**/api/admin/games/sync-status', SYNC);
  const manual = gated(page, '**/api/admin/games/manual*', []);

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

  await settings.open();
  await sync.open();
  await manual.open();

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
  const settings = gated(page, '**/api/settings', SETTINGS);

  await page.goto('/#/admin');
  // The local guess for "current season" is August's, not the stored answer, so
  // showing rows now means showing last season's people under this season's
  // heading — which is what happened.
  // Both mounted tabs say it; the coachee one is the subject here.
  await expect(page.getByText(/Lädt…|Loading…/).first()).toBeVisible();
  await expect(page.getByText('Last Season')).toHaveCount(0);

  await settings.open();
  await expect(page.getByText('This Season')).toBeVisible();
  await expect(page.getByText('Last Season')).toHaveCount(0);
});

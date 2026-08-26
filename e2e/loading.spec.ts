import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC, COACHEE } from './support/app';

/**
 * What the app asks for on a cold start.
 *
 * The season-scoped endpoints take the season as a query parameter, and the
 * season is not known until /api/settings answers — the client's own guess is
 * routinely wrong, because the stored preference is deleted after the first
 * successful load and what is left is a calculation the admin default disagrees
 * with. Firing those requests before the answer arrives meant loading a season
 * nobody asked for and then loading the right one, with the dashboard showing
 * the wrong numbers in between.
 *
 * These assert on WHICH season was requested rather than on how many requests
 * were made: React's StrictMode double-invokes effects in a dev build, so a raw
 * count would be testing the harness, not the app.
 */

/** Deliberately not the year the client would compute for itself. */
const SERVER_SEASON = 2031;

/** Records the season query parameter of every season-scoped request. */
async function trackSeasons(page: import('@playwright/test').Page) {
  const seasons: { path: string; season: string | null }[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (!/\/api\/rc-overview/.test(url.pathname)) return;
    seasons.push({
      path: url.pathname.includes('/coachees') ? 'summary' : 'overview',
      season: url.searchParams.get('season'),
    });
  });
  return seasons;
}

test('every season-scoped request is for the season the server named', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/settings', (r) => r.fulfill({
    json: {
      default_season: SERVER_SEASON, test_mode: false, groups: [],
      coachee_targets: { [COACHEE.id]: { mode: 'all' } }, rc_mandates: {}, default_goal: 10,
    },
  }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 0 }],
  }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));

  const seen = await trackSeasons(page);
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('Coaching Feedback');
  // Give any late/duplicate load the chance to fire and be caught.
  await page.waitForTimeout(2500);

  expect(seen.length, 'the dashboard should have loaded at all').toBeGreaterThan(0);
  const wrong = seen.filter((s) => s.season !== String(SERVER_SEASON));
  expect(wrong, `requested a season the server never named: ${JSON.stringify(wrong)}`).toEqual([]);
  // Both halves of the dashboard, so a pass cannot come from one never firing.
  expect(seen.some((s) => s.path === 'overview')).toBe(true);
  expect(seen.some((s) => s.path === 'summary')).toBe(true);
});


test.describe('what a wait looks like', () => {
  const SLOW = 20_000;

  /** Signed in as an admin, so a colleague's RC detail can be opened. */
  async function stubOverview(page: import('@playwright/test').Page, slowSummaryAfter: number) {
    let n = 0;
    await stubSignedInApp(page, { admin: true });
    await page.route('**/api/settings', (r) => r.fulfill({
      json: {
        default_season: SERVER_SEASON, test_mode: false, groups: [],
        coachee_targets: {}, rc_mandates: {}, default_goal: 10,
      },
    }));
    await page.route('**/api/rc-overview*', (r) => r.fulfill({
      json: [
        { id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 0 },
        { id: 'rc2', fullName: 'Beat Beispiel', done: 2, outstanding: 1, planned: 3 },
      ],
    }));
    await page.route('**/api/rc-overview/*/coachees*', async (r) => {
      // StrictMode fires the bootstrap's own call twice in a dev build, so the
      // threshold counts requests rather than "the first one".
      if (++n > slowSummaryAfter) await new Promise((res) => setTimeout(res, SLOW));
      await r.fulfill({ json: [] });
    });
    // The on-demand load the second test leans on.
    await page.route('**/api/coachees/*/feedbacks*', async (r) => {
      if (slowSummaryAfter > 0) await new Promise((res) => setTimeout(res, SLOW));
      await r.fulfill({ json: [] });
    });
  }

  test('the first load of a session gets the branded spinner', async ({ page }) => {
    // Nothing answers the dashboard, so the app never leaves its bootstrap.
    await stubOverview(page, 0);
    await page.goto('/');
    await expect(page.locator('h1')).toContainText('Coaching Feedback');
    await page.waitForTimeout(1500);

    expect(await page.locator('.svrz-orbit').count()).toBeGreaterThan(0);
    expect(await page.locator('.animate-pulse').count()).toBe(0);
  });

  // GAP, deliberately left visible: there used to be a test here proving that a
  // load AFTER the bootstrap draws skeleton rows rather than the branded orbit
  // spinner. Its only trigger was the admin-only RC detail screen, which moved
  // to the console — and neither the coachee feedback list nor anything else
  // reachable from the coach app reproduced the same late load. The behaviour
  // is still implemented (SkeletonRows in App.tsx); it is the trigger that is
  // missing. Re-pin it against the next on-demand fetch added to this app.
});

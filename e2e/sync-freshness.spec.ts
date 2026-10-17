import { test, expect } from '@playwright/test';
import { stubSignedInApp, suiteNow } from './support/app';

// The footer's "Games … ago · Börse … ago" counts from times /api/settings
// hands over, and that call used to run only at start-up. An installed app left
// open for two days said "Games 2 d ago" in amber over a sync that had run that
// afternoon (2026-10-17): the age kept growing from a time nobody re-read.

test('the sync ages are read again, not only counted up from start-up', async ({ page }) => {
  const hoursAgo = (h: number) => new Date(suiteNow() - h * 60 * 60 * 1000).toISOString();
  let freshness = { games: hoursAgo(48), boerse: hoursAgo(48) };
  await stubSignedInApp(page);
  await page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10, freshness },
  }));

  await page.goto('/');
  await expect(page.getByText(/^(Games 2 d ago|Spiele vor 2 Tagen)$/)).toBeVisible();

  // The server synced since; the window is looked at again.
  freshness = { games: hoursAgo(4), boerse: hoursAgo(0.25) };
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  await expect(page.getByText(/^(Games 4 h ago|Spiele vor 4 h)$/)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/^(Börse 1[45] min ago|Börse vor 1[45] Min\.)$/)).toBeVisible();
});

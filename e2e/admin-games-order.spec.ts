import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// Admin → Spiele opened on March 2027. The endpoint serves newest-first, the
// tab drew that order as it came and cut it at 300 rows — so with 637 games
// in the season, September was not at the bottom, it was not there at all.
// The list is chronological now, starts at the next game, and pages by a
// button instead of a "narrow the search".

const NOON = new Date('2026-09-14T10:00:00Z'); // 12:00 Zürich, Monday 14.09.

const at = (id: string, matchNo: string, date: string) => ({ ...GAME, id, matchNo, date, assignedRc: '' });
const EARLIER_TODAY = at('g0', '4000', '2026-09-14T06:00:00Z'); // 08:00 Zürich — over, but today
const PAST = at('g1', '4001', '2026-09-05T18:00:00Z');
const SOON = at('g2', '4002', '2026-09-19T15:30:00Z');
const NOVEMBER = at('g3', '4003', '2026-11-15T19:30:00Z');
const MARCH = at('g4', '4004', '2027-03-13T18:30:00Z');
// As the API returns them: newest first.
const SERVED = [MARCH, NOVEMBER, SOON, EARLIER_TODAY, PAST];

const rows = (page: import('@playwright/test').Page) => page.getByText(/^#\d+$/);

test('the list runs from the next game forward, and a played game is behind a toggle', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: SERVED }));
  await page.clock.setFixedTime(NOON);

  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();

  // Chronological, from today: a game earlier today is still on the list (the
  // Zürich day, not the minute), the one from last week is not.
  await expect(rows(page)).toHaveText(['#4000', '#4002', '#4003', '#4004']);
  await expect(page.getByText(/^4 (Spiele|games)/)).toBeVisible();

  await page.getByRole('button', { name: /Auch vergangene|Include past/ }).click();
  await expect(rows(page)).toHaveText(['#4001', '#4000', '#4002', '#4003', '#4004']);
  await page.getByRole('button', { name: /Auch vergangene|Include past/ }).click();
  await expect(rows(page)).toHaveText(['#4000', '#4002', '#4003', '#4004']);

  // A search is a question about a game wherever it is — the played one is
  // found without the toggle.
  await page.getByPlaceholder(/Liga oder Halle|league or venue/).fill('4001');
  await expect(rows(page)).toHaveText(['#4001']);

  // Any other search keeps to the toggle: typing a name used to show the
  // played games too, and the button then changed nothing.
  await page.getByPlaceholder(/Liga oder Halle|league or venue/).fill('400');
  await expect(rows(page)).toHaveText(['#4000', '#4002', '#4003', '#4004']);
  await page.getByRole('button', { name: /Auch vergangene|Include past/ }).click();
  await expect(rows(page)).toHaveText(['#4001', '#4000', '#4002', '#4003', '#4004']);
});

test('the rest of the season is a click away, not a search away', async ({ page }) => {
  // One an hour from tomorrow evening on — served newest first, like the API.
  const many = Array.from({ length: 250 }, (_, i) =>
    at(`m${i}`, String(5000 + i), new Date(Date.UTC(2026, 8, 15, 18 + i)).toISOString())).reverse();
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: many }));
  await page.clock.setFixedTime(NOON);

  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();

  await expect(rows(page)).toHaveCount(200);
  await expect(rows(page).first()).toHaveText('#5000');
  // The count line counts the whole list; the button says what is behind it.
  await expect(page.getByText(/^250 (Spiele|games)/)).toBeVisible();
  const more = page.getByRole('button', { name: /Weitere 50 Spiele|Show 50 more/ });
  await expect(more).toBeVisible();
  await more.click();
  await expect(rows(page)).toHaveCount(250);
  await expect(rows(page).last()).toHaveText('#5249');
  await expect(page.getByRole('button', { name: /Weitere .* Spiele|Show .* more/ })).toHaveCount(0);

  // A narrowed list starts at its first page again.
  await page.getByPlaceholder(/Liga oder Halle|league or venue/).fill('524');
  await expect(rows(page)).toHaveCount(10);
});

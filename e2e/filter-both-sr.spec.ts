import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC, GAME } from './support/app';

// "Both referees are coachees" is the game a coach looks for first — one trip,
// two observations — and the Function filter could only ever express 1SR OR 2SR.

const status = { needsObservation: true, count: 0 };
const coachee = (id: string, full_name: string) =>
  ({ id, full_name, referee_level: 'N3', stage: '2', observation_status: status });

const COACHEES = [coachee('c1', 'Ref One'), coachee('c2', 'Ref Two')];

const game = (id: string, homeTeam: string, first: string, second: string) => ({
  ...GAME, id, matchNo: id, homeTeam, firstReferee: first, secondReferee: second, assignedRc: '',
});

const GAMES = [
  game('g-both', 'Both Are Coachees', 'Ref One', 'Ref Two'),
  game('g-first', 'Only 1SR', 'Ref One', 'Someone Else'),
  game('g-second', 'Only 2SR', 'Someone Else', 'Ref Two'),
  game('g-solo', 'Single Referee', 'Ref One', ''),
];

/** Tick one option inside an open dropdown. Scoped to the option row, because
 *  "1SR" also appears as a role label on the game rows behind the panel. */
const pickOption = (page: import('@playwright/test').Page, label: string) =>
  page.locator('label').filter({ has: page.getByText(label, { exact: true }) })
    .getByRole('checkbox').check();

async function openFilters(page: import('@playwright/test').Page) {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: GAMES }));
  await page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10 },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
}

test('the Function filter can ask for games where BOTH referees are coachees', async ({ page }) => {
  await openFilters(page);
  await expect(page.getByText('Only 1SR')).toBeVisible();

  await page.getByRole('button', { name: /^(All|Alle)$/ }).click();
  await pickOption(page, '1SR + 2SR');

  await expect(page.getByText('Both Are Coachees')).toBeVisible();
  await expect(page.getByText('Only 1SR')).toHaveCount(0);
  await expect(page.getByText('Only 2SR')).toHaveCount(0);
  // No second referee at all, so it cannot be a two-observation game.
  await expect(page.getByText('Single Referee')).toHaveCount(0);
});

test('ticking it alongside 1SR widens rather than cancels', async ({ page }) => {
  await openFilters(page);
  await page.getByRole('button', { name: /^(All|Alle)$/ }).click();
  await pickOption(page, '1SR + 2SR');
  await pickOption(page, '1SR');

  await expect(page.getByText('Both Are Coachees')).toBeVisible();
  await expect(page.getByText('Only 1SR')).toBeVisible();
  await expect(page.getByText('Single Referee')).toBeVisible();
  await expect(page.getByText('Only 2SR')).toHaveCount(0);
});

// The coachee filter reads a name one way and matches it another: the option
// shows "One, Ref" the way both coachee lists do, while the value it filters on
// is still "Ref One", the name the game itself carries. Nothing else asserted
// that the split label actually filters, so a decorative label would have gone
// out unnoticed.
test('picking a coachee by their listed name still filters the games', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: GAMES }));
  await page.goto('/');
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /All coachees|Alle Coachees/ }).click();

  await pickOption(page, 'One, Ref');

  // Every game Ref One is on, and none of the ones he is not.
  await expect(page.getByText('Both Are Coachees')).toBeVisible();
  await expect(page.getByText('Only 1SR')).toBeVisible();
  await expect(page.getByText('Single Referee')).toBeVisible();
  await expect(page.getByText('Only 2SR')).toHaveCount(0);
});

test('a long coachee name is not cut off in the dropdown', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [coachee('c9', 'Dario Stefano Quattrini')] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [game('g9', 'Some Game', 'Dario Stefano Quattrini', '')],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /All coachees|Alle Coachees/ }).click();

  // The option renders its whole name — no ellipsis, nothing clipped away —
  // and reads surname-first, the way both coachee lists do.
  const opt = page.getByText('Quattrini, Dario Stefano', { exact: true }).last();
  await expect(opt).toBeVisible();
  const clipped = await opt.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(clipped).toBe(false);
});

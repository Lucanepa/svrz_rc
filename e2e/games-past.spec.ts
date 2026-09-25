import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// The Games list is for planning: what is still to be refereed. Played games
// stay in the season behind one button at the top — by mid-season the first
// screen was September, and the next fixture two pages down.
//
// "Played" is a Zürich DAY, not an instant: a game earlier tonight is still
// tonight's game, and the coach filing after the whistle should find it
// without unhiding the season. A date filter is an explicit ask for those
// days, so it lifts the rule on its own.

const FREE = { ...GAME, assignedRc: '' };
const YESTERDAY = { ...FREE, id: 'g-yday', matchNo: '2400100', homeTeam: 'VBC Gestern', awayTeam: 'Gast Gestern', date: '2026-11-14T19:30:00Z' };
/** 20:30 in the gym, already over at the fixed clock below. */
const TONIGHT = { ...FREE, id: 'g-today', matchNo: '2400101', homeTeam: 'VBC Heute', awayTeam: 'Gast Heute', date: '2026-11-15T19:30:00Z' };
const LATER = { ...FREE, id: 'g-later', matchNo: '2400102', homeTeam: 'VBC Später', awayTeam: 'Gast Später', date: '2026-11-22T19:30:00Z' };

const pastButton = (page: Page) => page.getByRole('button', { name: /Show past games|Vergangene Spiele anzeigen/ });
const hideButton = (page: Page) => page.getByRole('button', { name: /Hide past games|Vergangene Spiele ausblenden/ });

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  // 23:00 on Sunday 15.11 in Zürich.
  await page.clock.setFixedTime(new Date('2026-11-15T22:00:00Z'));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [YESTERDAY, TONIGHT, LATER] }));
});

test('played games sit behind a button at the top, and tonight is not played', async ({ page }) => {
  await page.goto('/games');
  await expect(page.getByText(TONIGHT.homeTeam)).toBeVisible();
  await expect(page.getByText(LATER.homeTeam)).toBeVisible();
  await expect(page.getByText(YESTERDAY.homeTeam)).toHaveCount(0);

  await expect(pastButton(page)).toHaveText(/\(1\)/);
  await pastButton(page).click();
  await expect(page.getByText(YESTERDAY.homeTeam)).toBeVisible();
  await expect(page.getByText(TONIGHT.homeTeam)).toBeVisible();

  await hideButton(page).click();
  await expect(page.getByText(YESTERDAY.homeTeam)).toHaveCount(0);
});

test('picking yesterday lifts the rule on its own', async ({ page }) => {
  await page.goto('/games');
  // No "Gestern" chip any more: the ‹ button steps back from today.
  await page.getByRole('button', { name: /^(Vorheriger Tag|Previous day)$/ }).click();
  await expect(page.getByText(YESTERDAY.homeTeam)).toBeVisible();
  await expect(page.getByText(TONIGHT.homeTeam)).toHaveCount(0);
  await expect(pastButton(page)).toHaveCount(0);
});

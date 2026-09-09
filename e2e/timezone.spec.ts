import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC, GAME } from './support/app';

/**
 * A fixture starts when it starts in the gym in Zürich. The reader's device has
 * no say in it.
 *
 * Found in production on 09.09.2026: a coach opened the app from Greece and
 * every kick-off was an hour late — 20:45 became 21:45 — because the list built
 * its clock from `getHours()`. The same wrong time was copied into the form's
 * date field, and from there into the filed PDF and the mail to the referee.
 *
 * Athens is UTC+2 in November (Zürich is UTC+1), so the stub game at 19:30Z is
 * 20:30 in the gym and 21:30 on the reader's own clock. Only one of those may
 * ever appear on screen.
 */
test.use({ timezoneId: 'Europe/Athens' });

// 22:30Z on the 15th: 23:30 in the gym in Zürich, 00:30 on the 16th in Athens.
// One fixture, and the row must read the Swiss evening in both places.
const PLANNED_DATE = '2026-11-15T22:30:00Z';

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  // Home builds its "next observations" from the RC overview, not from the
  // games list, so the same fixture has to be planted there too.
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 1 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Coachee Eins',
      doneFeedbacks: [], outstandingGames: [],
      plannedGames: [{
        gameId: GAME.id, gameDate: PLANNED_DATE, league: '3L', teams: `${GAME.homeTeam} vs ${GAME.awayTeam}`,
        refereeName: 'Coachee Eins', result: '',
      }],
    }],
  }));
});

test('the dashboard shows a fixture at its Zürich kick-off, on the Swiss day', async ({ page }) => {
  // The Home dashboard is the view the report came from ("Next observations"),
  // and this is the hard case: the reader's device is already on the 16th.
  await page.goto('/#/home');
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
  await expect(page.getByText('23:30', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('15.11.').first()).toBeVisible();
  await expect(page.getByText('00:30', { exact: true })).toHaveCount(0);
  await expect(page.getByText('16.11.')).toHaveCount(0);
});

test('the games list shows the same Zürich kick-off', async ({ page }) => {
  await page.goto('/#/games');
  // The coach's own assigned game is hidden behind this filter by default.
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: /RC assigned/i }).first().click();
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
  await expect(page.getByText('20:30', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('21:30', { exact: true })).toHaveCount(0);
});

test('the calendar files it under the Swiss day too', async ({ page }) => {
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, date: PLANNED_DATE }] }));
  await page.goto('/#/games');
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: /RC assigned/i }).first().click();
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
  await expect(page.getByText('15.11.').first()).toBeVisible();
  await expect(page.getByText('16.11.')).toHaveCount(0);
});

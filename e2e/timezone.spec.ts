import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC, GAME } from './support/app';
import { dayTimeLabel, shiftDayKey, instantOf, timeLabel, dayKey } from '../src/lib/appTime';

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

test('"Heute" means the Swiss day, even when the reader is already on the next one', async ({ page }) => {
  // 23:35 on Sunday 15.11 in the gym; 00:35 on Monday 16.11 on the device.
  // The chip used to read the DEVICE's calendar day, so "Heute" jumped to
  // Monday and the fixture being played right then could not be found under
  // any chip — the range filter's two ends were anchored in different zones,
  // so it fell out of "Gestern" too.
  await page.clock.setFixedTime(new Date('2026-11-15T22:35:00Z'));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, date: PLANNED_DATE }] }));
  await page.goto('/#/games');
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: /RC assigned/i }).first().click();
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();

  await page.getByRole('button', { name: /^(Heute|Today)$/ }).click();
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
  await expect(page.getByText('15.11.').first()).toBeVisible();
});

/**
 * The helper every clock in the app now goes through. These assertions are
 * fixed strings on purpose: they hold whatever zone the process runs in, which
 * is precisely the property that was missing.
 */
test.describe('appTime speaks Zürich', () => {
  test('reads all three stored shapes', () => {
    expect(dayTimeLabel('2026-09-21 18:45:00.000Z')).toBe('21.09.2026 20:45');   // CEST, +2
    expect(dayTimeLabel('2026-11-15T19:30:00Z')).toBe('15.11.2026 20:30');       // CET, +1
    expect(dayTimeLabel('2026-09-21T20:45')).toBe('21.09.2026 20:45');           // zone-less = Zürich
    expect(dayTimeLabel('2026-11-09')).toBe('09.11.2026');                       // a date, no clock
    expect(timeLabel('2026-11-09')).toBe('');                                    // ...and no invented 01:00
    expect(dayTimeLabel(Date.UTC(2026, 10, 15, 19, 30))).toBe('15.11.2026 20:30'); // epoch ms
    expect(dayTimeLabel('not a date')).toBe('');
  });

  test('a late kick-off keeps the Swiss day', () => {
    expect(dayKey('2026-11-15T22:30:00Z')).toBe('2026-11-15');   // 23:30 in the gym
    expect(dayKey('2026-11-15T23:30:00Z')).toBe('2026-11-16');   // 00:30, genuinely the next day
  });

  test('day arithmetic survives both clock changes', () => {
    // ±24h would land on 25.10 again (a 25-hour day) and skip 29.03 (a 23-hour one).
    expect(shiftDayKey('2026-10-25', -1)).toBe('2026-10-24');
    expect(shiftDayKey('2026-10-25', 1)).toBe('2026-10-26');
    expect(shiftDayKey('2026-03-29', -1)).toBe('2026-03-28');
    expect(shiftDayKey('2026-03-29', 1)).toBe('2026-03-30');
    expect(shiftDayKey('2026-12-31', 1)).toBe('2027-01-01');
  });

  test('a zone-less wall clock names the Swiss instant, not the reader\'s', () => {
    expect(new Date(instantOf('2026-09-21T20:45')!).toISOString()).toBe('2026-09-21T18:45:00.000Z');
    expect(new Date(instantOf('2026-11-15T20:30')!).toISOString()).toBe('2026-11-15T19:30:00.000Z');
  });
});

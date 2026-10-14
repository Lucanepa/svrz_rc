import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME, MY_RC_GAME } from './support/app';

// Taking a game on a day the coach is already busy (asked 2026-10-14): the
// take asks first, naming what else is on that day — an observation they hold,
// or a game they whistle themselves. Amber for the same day; red when a
// kick-off is within two hours of this one.

/** Free to take, no coachee booked, 15.11. — GAME's day. */
const FREE = { ...GAME, id: 'g-free', matchNo: '2400888', homeTeam: 'VBC Frei', assignedRc: '', assignedRcId: '', firstCoacheeId: '', firstRefereeId: '', firstReferee: 'Nobody, Some' };

async function openAndTake(page: Page, games: unknown[], rcGames: unknown[]): Promise<string[]> {
  const assigned: string[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: games }));
  await page.route('**/api/rc-games*', (r) => r.fulfill({ json: rcGames }));
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push(r.request().url());
    await r.fulfill({ json: { ok: true } });
  });
  await page.clock.setFixedTime(new Date('2026-11-10T10:00:00Z'));
  await page.goto('/games');
  await page.getByRole('button', { name: new RegExp(FREE.matchNo) }).first().click();
  await page.getByRole('button', { name: /^(Take game|Spiel übernehmen)$/ }).click();
  return assigned;
}

test('an observation the same day, hours apart, is an amber notice', async ({ page }) => {
  const MORNING = { ...FREE, date: '2026-11-15T09:00:00Z' };
  const assigned = await openAndTake(page, [GAME, MORNING], []);
  const clash = page.getByTestId('take-notice-clash');
  await expect(clash).toHaveAttribute('data-level', 'amber');
  await expect(clash).toContainText(/Observation|Beobachtung/);
  await expect(clash).toContainText(GAME.homeTeam);
  expect(assigned).toHaveLength(0);
  await page.getByRole('button', { name: /^(Take anyway|Trotzdem übernehmen)$/ }).click();
  await expect.poll(() => assigned.length).toBe(1);
});

test('a game the coach whistles within two hours is a red notice', async ({ page }) => {
  const EVENING = { ...FREE, date: '2026-11-15T18:00:00Z' };
  const WHISTLE = { ...MY_RC_GAME, gameDate: '2026-11-15T16:30:00Z', result: '' };
  await openAndTake(page, [EVENING], [WHISTLE]);
  const clash = page.getByTestId('take-notice-clash');
  await expect(clash).toHaveAttribute('data-level', 'red');
  await expect(clash).toContainText(/own game as referee|Eigenes Spiel als SR/);
  await expect(clash).toContainText(MY_RC_GAME.teams);
});

test('nothing else that day: the take goes straight through', async ({ page }) => {
  const OTHER_DAY = { ...FREE, date: '2026-11-18T18:00:00Z' };
  const assigned = await openAndTake(page, [GAME, OTHER_DAY], [MY_RC_GAME]);
  await expect.poll(() => assigned.length).toBe(1);
  await expect(page.getByTestId('take-notice')).toHaveCount(0);
});

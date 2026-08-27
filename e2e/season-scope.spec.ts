import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// Coachees are per-season rows. A referee coached in 25/26 who was never
// imported for 26/27 is not a coachee now — but the games list matched referees
// against every name ever imported, so she kept turning up on this season's
// fixtures wearing last season's Niveau and a group ("Referee Coaching") that
// 26/27 does not even have. Server side: getCoacheeNameIndex keys the names by
// season and matches a game against the season its own date falls in. Client
// side: isInSeason() scopes the badge, the filters and the name lookup.
//
// The stubs pin default_season to 2026, and GAME.date is in the 26/27 window.

const LAST_SEASON_ROW = {
  id: 'c-25',
  full_name: 'Letizia Altsaison',
  email: 'letizia@example.ch',
  referee_level: 'N3',
  stage: '1',
  season: 2025,
  groups: 'Beförderung?/Referee Coaching',
  observation_status: { needsObservation: true, count: 0 },
};

const THIS_SEASON_ROW = { ...LAST_SEASON_ROW, id: 'c-26', season: 2026, referee_level: 'N2', stage: '2', groups: 'Befördert' };

const HER_GAME = {
  ...GAME,
  id: 'g-25',
  matchNo: '9990001',
  homeTeam: 'VBC Limmattal H1',
  awayTeam: 'Audax SSC 1',
  firstReferee: LAST_SEASON_ROW.full_name,
  secondReferee: '',
  // Unheld, so it sits on the open list rather than behind the "RC assigned" filter.
  assignedRc: '',
};

/** The amber pill next to a referee's name: "Coachee · N3-1 · Beförderung?". */
const coacheeBadge = (page: import('@playwright/test').Page) => page.getByText(/^Coachee ·/);

async function openGames(page: import('@playwright/test').Page, coachees: unknown[]) {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: coachees }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [HER_GAME] }));
  await page.goto('/');
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await expect(page.getByText(HER_GAME.homeTeam).first()).toBeVisible();
}

test('a referee who is only last season\'s coachee gets no badge on this season\'s game', async ({ page }) => {
  await openGames(page, [LAST_SEASON_ROW]);

  // She is still named on the game — the fixture is real, she is refereeing it.
  await expect(page.getByText(LAST_SEASON_ROW.full_name).first()).toBeVisible();
  // But not as a coachee, and so not at last season's Niveau or in its group.
  await expect(coacheeBadge(page)).toHaveCount(0);
});

test('her row for THIS season badges her again, with this season\'s Niveau and group', async ({ page }) => {
  await openGames(page, [THIS_SEASON_ROW]);

  // The group is stored in German and translated for display, so accept either.
  await expect(coacheeBadge(page)).toHaveText(/Coachee · N2-2 · (Befördert|Promoted)/);
});

test('both rows exist: the badge reads the current season, never the older row', async ({ page }) => {
  // The order the API happens to answer in must not decide it — last season's
  // row is listed first, which is what `find`/`Map.set` used to pick up.
  await openGames(page, [LAST_SEASON_ROW, THIS_SEASON_ROW]);

  // The group is stored in German and translated for display, so accept either.
  await expect(coacheeBadge(page)).toHaveText(/Coachee · N2-2 · (Befördert|Promoted)/);
  await expect(coacheeBadge(page)).not.toHaveText(/Referee Coaching/);
});

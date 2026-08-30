import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC, COACHEE, COACHEE_LISTED, GAME } from './support/app';

/**
 * The score, wherever a game is listed.
 *
 * The games list grew this display first — set count next to each team, set
 * scores under them — and the other lists showed nothing at all. They render it
 * through one shared component now, so what these tests are really pinning is
 * that the component is actually wired into each list: the parsing itself is
 * exercised by every case below through the VolleyManager shape, which is what
 * all 925 scored games in production use.
 */

/** "3:0" and the three sets, as the compact lists write them.
 *
 *  The digit guards are not decoration. Without them this also matches the
 *  clock inside the build stamp in the footer — "Build <sha> · 26.08.2026,
 *  13:09" contains "3:0" — so the "no score renders nothing" case below failed
 *  in CI for any build made between 13:00 and 13:09 (and 03:0x, and 23:0x) and
 *  passed every other minute of the day. */
const OVERALL = /(?<!\d)3\s*:\s*0(?!\d)/;
const SETS = '25:15 | 25:21 | 25:14';

// The games list splits each set across the two team rows instead, so a row
// reads as one team's whole match. Same three sets as SETS above.
const HOME_POINTS = '25 | 25 | 25';
const AWAY_POINTS = '15 | 21 | 14';

// The shape the VolleyManager sync writes — all 925 scored games in production
// use it. Kept local to this file rather than on the shared fixture, because a
// game carrying a result locks the form's score box (see support/app.ts).
const SCORED = { ...GAME, game_result: '3:0 (25:15 / 25:21 / 25:14)' };

/** Coachees tab -> a coachee -> their own games list. */
async function openCoacheeGames(page: Page): Promise<void> {
  await page.getByText(COACHEE_LISTED).first().click();
  // The row opens a detail panel; its primary button is what loads the games.
  await page.getByRole('button', { name: /Games \/ Feedback|Spiele \/ Feedbacks/ }).click();
}

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [SCORED] }));
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [{ ...SCORED, assignedRoles: ['2SR'] }],
  }));
});

test('the games list puts each team\'s set points on that team\'s row', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();

  await expect(page.getByText(HOME_POINTS)).toBeVisible();
  await expect(page.getByText(AWAY_POINTS)).toBeVisible();
  // The combined "25:15 | ..." line the two replaced is gone, not merely moved.
  await expect(page.getByText(SETS)).toHaveCount(0);
});

test('a coachee\'s own games list shows them too', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openCoacheeGames(page);

  // The heading confirms we are on the per-coachee list and not still on the
  // games list, which would make the assertion below pass for the wrong reason.
  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  // Split across the two team rows, exactly as the games list does it — this
  // list draws the same row now.
  await expect(page.getByText(HOME_POINTS)).toBeVisible();
  await expect(page.getByText(AWAY_POINTS)).toBeVisible();
  // Each team's set count sits on that team's own row, so there is no combined
  // "3:0" to look for here either — same as the games list above.
  await expect(page.getByText(SETS)).toHaveCount(0);
});

test('the Home dashboard shows them on an outstanding observation', async ({ page }) => {
  await page.route('**/api/rc-overview*', (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 1, planned: 0 }],
  }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({
    json: [{
      coacheeName: COACHEE.full_name,
      coacheeId: COACHEE.id,
      doneFeedbacks: [],
      plannedGames: [],
      outstandingGames: [{
        gameId: GAME.id,
        // Dated in the past, which is what makes it outstanding rather than planned.
        gameDate: '2026-03-29T18:00:00Z',
        league: GAME.league,
        teams: `${GAME.homeTeam} vs ${GAME.awayTeam}`,
        refereeName: COACHEE.full_name,
        result: SCORED.game_result,
      }],
    }],
  }));
  await page.goto('/');

  await expect(page.getByText(SETS)).toBeVisible();
});

test('a game with no score yet adds no empty row', async ({ page }) => {
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [{ ...SCORED, game_result: '', assignedRoles: ['2SR'] }],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openCoacheeGames(page);

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  // Not "renders 0:0" and not "renders a blank line" — renders nothing.
  await expect(page.getByText(SETS)).toHaveCount(0);
  await expect(page.getByText(OVERALL)).toHaveCount(0);
});

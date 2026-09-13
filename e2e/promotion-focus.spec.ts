import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, COACHEE } from './support/app';

// A coachee up for a promotion (4.4.4 "Beförderung?", 4.4.5 "Beförderung") is
// visited for ONE kind of game: the one the SR-Niveau table names for their
// level. So their focus is strict — a game the table cannot place (a cup round)
// is out of it, where for everyone else the rule fails open and leaves it in.
// Asked for by the coaches on 2026-09-12: at the start of a season the cup is
// most of the list, and a "Beförderung" list full of cup games is not a list
// of games to judge a promotion on.
//
// Dates are read against the real clock, like the rest of the suite: these
// are the 2026/27 season the stub opens on.

/** N4-1: 4. Liga men as 1. SR is in focus; a cup round says nothing. */
const CANDIDATE = {
  id: 'c-b', full_name: 'Bea Promo', email: 'bea@example.ch',
  referee_level: 'N4', stage: '1', groups: 'Beförderung?',
  observation_status: { needsObservation: true, count: 0 },
};
/** Same level, but a Varia visit: any evening will do, the cup included. */
const VARIA = {
  id: 'c-v', full_name: 'Vic Varia', email: 'vic@example.ch',
  referee_level: 'N4', stage: '1', groups: 'Varia',
  observation_status: { needsObservation: true, count: 0 },
};

const base = {
  date: '2026-10-10T18:00:00Z', location: 'Sporthalle Utogrund',
  secondReferee: '', assignedRc: '', starred: false,
  feedbackClosedRoles: [] as string[], game_result: '',
};
const CUP_B = { ...base, id: 'g-cup-b', matchNo: '2500001', league: 'Züri Cup', homeTeam: 'VBC Cupheim', awayTeam: 'TV Gast', firstReferee: CANDIDATE.full_name };
const LIGA_B = { ...base, id: 'g-liga-b', matchNo: '2500002', league: '4L ♂', homeTeam: 'VBC Ligaheim', awayTeam: 'TV Gast', firstReferee: CANDIDATE.full_name };
const CUP_V = { ...base, id: 'g-cup-v', matchNo: '2500003', league: 'Züri Cup', homeTeam: 'VBC Variaheim', awayTeam: 'TV Gast', firstReferee: VARIA.full_name };
/** The candidate beside a colleague the cup IS fine for: kept for the colleague. */
const CUP_BOTH = { ...base, id: 'g-cup-both', matchNo: '2500004', league: 'Züri Cup', homeTeam: 'VBC Beideheim', awayTeam: 'TV Gast', firstReferee: CANDIDATE.full_name, secondReferee: VARIA.full_name };

const focusPill = (page: Page) => page.getByRole('button', { name: /In focus only|Nur im Fokus|All games|Alle Spiele/ });

async function openGames(page: Page) {
  await stubSignedInApp(page);
  // No per-coachee override: the level decides, as it does for every real row.
  await page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10 },
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, CANDIDATE, VARIA] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [CUP_B, LIGA_B, CUP_V, CUP_BOTH] }));
  await page.goto('/games');
  await expect(page.getByText(LIGA_B.homeTeam)).toBeVisible();
}

test('a promotion candidate\'s cup game is out of focus; a Varia coachee\'s is not', async ({ page }) => {
  await openGames(page);
  await expect(page.getByText(CUP_B.homeTeam)).toHaveCount(0);
  await expect(page.getByText(CUP_V.homeTeam)).toBeVisible();
  // Whistled beside somebody the game is in focus for, it stays on the list.
  await expect(page.getByText(CUP_BOTH.homeTeam)).toBeVisible();
});

test('the focus only hides: "All games" brings the cup round back', async ({ page }) => {
  await openGames(page);
  await expect(focusPill(page)).toBeVisible();
  await focusPill(page).click();
  await expect(page.getByText(CUP_B.homeTeam)).toBeVisible();
});

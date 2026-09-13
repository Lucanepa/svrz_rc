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
// The case they actually pointed at (2026-09-13) was a different leak: the
// Games tab keeps a game that is in focus for EITHER coachee on the whistle,
// so an N2-2 candidate leading a 3. Liga game beside a junior 2. SR came back
// as one of his games, chip and all. Now the coachee filter asks the focus of
// the picked coachees only, and the chip says when a listed game is outside
// that coachee's own focus.
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

/** N2-2 up for promotion — the case a coach raised on 2026-09-13: 2. Liga men
 *  as 1. SR and 1. Liga as 2. SR are theirs; a 3. Liga evening is not, whoever
 *  they whistle it with. */
const CANDIDATE_N2 = {
  id: 'c-r', full_name: 'Alex Kandidat', email: 'alex@example.ch',
  referee_level: 'N2', stage: '2', groups: 'Beförderung?',
  observation_status: { needsObservation: true, count: 0 },
};
/** N3-3: 3. Liga men as 2. SR is squarely in focus. */
const JUNIOR = {
  id: 'c-j', full_name: 'Jon Junior', email: 'jon@example.ch',
  referee_level: 'N3', stage: '3', groups: 'Varia',
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

/** The candidate leading a 3. Liga game with the junior beside him: on the
 *  list for the junior, not for him. */
const THIRD = { ...base, id: 'g-3l', matchNo: '2500005', league: '3L ♂', homeTeam: 'VBC Drittheim', awayTeam: 'TV Gast', firstReferee: CANDIDATE_N2.full_name, secondReferee: JUNIOR.full_name };
/** The game to watch him at. */
const FIRST = { ...base, id: 'g-1l', matchNo: '2500006', league: '1L ♂', homeTeam: 'VBC Erstheim', awayTeam: 'TV Gast', firstReferee: 'Ex Terne', secondReferee: CANDIDATE_N2.full_name };

const focusPill = (page: Page) => page.getByRole('button', { name: /In focus only|Nur im Fokus|All games|Alle Spiele/ });

async function openGames(page: Page) {
  await stubSignedInApp(page);
  // No per-coachee override: the level decides, as it does for every real row.
  await page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10 },
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, CANDIDATE, VARIA, CANDIDATE_N2, JUNIOR] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [CUP_B, LIGA_B, CUP_V, CUP_BOTH, THIRD, FIRST] }));
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

test('a game on the list for the colleague says so on the candidate\'s chip', async ({ page }) => {
  await openGames(page);
  // Listed — the junior's 3. Liga as 2. SR is in focus — but not as his.
  await expect(page.getByText(THIRD.homeTeam)).toBeVisible();
  await expect(page.getByText(/Coachee · N2-2 · .*(nicht im Fokus|out of focus)/)).toBeVisible();
  await expect(page.getByText(/Coachee · N3-3/)).not.toHaveText(/nicht im Fokus|out of focus/);
  // His own 1. Liga evening carries no such mark.
  await expect(page.getByText(FIRST.homeTeam)).toBeVisible();
  await expect(page.getByText(/Coachee · N2-2 · .*(nicht im Fokus|out of focus)/)).toHaveCount(1);
});

test('filtered to the candidate, only his own focus decides', async ({ page }) => {
  await openGames(page);
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /All coachees|Alle Coachees/ }).click();
  await page.locator('label').filter({ hasText: 'Kandidat, Alex' }).getByRole('checkbox').check();
  await expect(page.getByText(FIRST.homeTeam)).toBeVisible();
  await expect(page.getByText(THIRD.homeTeam)).toHaveCount(0);
  // The escape hatch still opens it up.
  await focusPill(page).click();
  await expect(page.getByText(THIRD.homeTeam)).toBeVisible();
});

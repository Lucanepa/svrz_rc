import { test, expect } from '@playwright/test';
import { stubSignedInApp, BOERSE_RED, GAME, GAME_LD, GAME_MANUAL } from './support/app';

// The console is where a game is handed to a coach, and its row named the 1SR
// and stopped there: the 2SR was invisible, and neither referee said whether
// they were anybody's coachee or which group they were in — the one question
// the assignment is being made to answer. See src/components/CoacheeChips.tsx.

const status = { needsObservation: true, count: 0 };
const coachee = (id: string, full_name: string, groups: string, season?: number) =>
  ({ id, full_name, groups, season, referee_level: 'N3', stage: '2', observation_status: status });

// The slot ids as the server resolves them: Sven Fremd is nobody's coachee.
const GAMES = [
  { ...GAME, id: 'g1', firstReferee: 'Nina Adler', secondReferee: 'Sven Fremd', firstCoacheeId: 'c1', secondCoacheeId: '' },
  { ...GAME, id: 'g2', matchNo: '2345679', homeTeam: 'VBC Limmattal H1', awayTeam: 'Volley Uster H3',
    firstReferee: 'Tim Berger', secondReferee: 'Urs Custer', firstCoacheeId: 'c2', secondCoacheeId: 'c3' },
];

test('the console says which group each referee on a game is in', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
    coachee('c1', 'Nina Adler', 'Varia'),
    coachee('c2', 'Tim Berger', 'Neu-Schiedsrichter 26/27'),
    coachee('c3', 'Urs Custer', 'Beförderung?'),
  ] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: GAMES }));

  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect(page.getByText('Nina Adler')).toBeVisible();

  // The console opens in German, and German is what the groups are stored as.
  await expect(page.getByText('Varia', { exact: true })).toBeVisible();
  await expect(page.getByText('Neu-Schiedsrichter 26/27', { exact: true })).toBeVisible();
  await expect(page.getByText('Beförderung?', { exact: true })).toBeVisible();

  // The 2SR is on the row at all now — and one who is nobody's coachee is
  // listed plainly, with no mark and no group.
  const secondRef = page.getByText('2SR Sven Fremd');
  await expect(secondRef).toBeVisible();
  await expect(secondRef.locator('span', { hasText: /Coachee/ })).toHaveCount(0);
});

test('a referee who is only ANOTHER season\'s coachee is not marked', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  // The console filters its coachee list by the season in settings (2026 in the
  // stub); a row from a different season must not badge this season's game.
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
    coachee('c1', 'Nina Adler', 'Varia', 2025),
  ] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAMES[0]] }));

  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect(page.getByText('1SR Nina Adler')).toBeVisible();
  await expect(page.getByText('Varia', { exact: true })).toHaveCount(0);
});

// The console's row read the whole /api/eligible-games projection and drew a
// subset: no LD, no Testspiel, no Börse, no closed role, and the hall as a
// free-text search rather than the link the sync stored. This is the screen
// an admin hands a game out from, and it could not see that the fixture was
// a Testspiel, in the Börse, or already filed for the 1. SR.
test('the console draws the same marks as the coach app — LD, Testspiel, Börse, observed — and the map link', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [coachee('c1', 'Nina Adler', 'Varia')] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [
    { ...GAMES[0], isLdGame: true, boerse: BOERSE_RED, maps_url: 'https://maps.example/utogrund', feedbackClosedRoles: ['1. SR'] },
    { ...GAME_MANUAL, assignedRc: '', assignedRcId: '' },
    { ...GAME_LD, id: 'g-plain', matchNo: '2345683', isLdGame: false, homeTeam: 'Volley Obfelden' },
  ] }));

  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect(page.getByText('Nina Adler')).toBeVisible();

  await expect(page.getByText(/^(LD Spiel|LD Game)$/)).toHaveCount(1);
  await expect(page.getByText(/^(Testspiel|Test game)$/)).toHaveCount(1);
  // The Börse: the word on the slot and the line under the row.
  await expect(page.getByText('In Börse')).toHaveCount(1);
  await expect(page.getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();
  // The role already filed for, and the Niveau on the coachee mark.
  await expect(page.getByText(/^(beobachtet|observed)$/)).toHaveCount(1);
  await expect(page.getByText('Coachee · N3-2').first()).toBeVisible();
  // The precise link, not a text search for the hall's name.
  await expect(page.getByRole('link', { name: 'Sporthalle Utogrund' }).first()).toHaveAttribute('href', 'https://maps.example/utogrund');
  // The star stays a button here — no chip says it a second time.
  await expect(page.getByText(/^(Gewünscht|Priority)$/)).toHaveCount(0);
});

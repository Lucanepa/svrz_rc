import { test, expect } from '@playwright/test';
import { stubSignedInApp, coacheeGame, BOERSE_RED, COACHEE_LISTED, GAME, RC } from './support/app';

// Finding a game to watch used to mean leaving the coachee behind: the row said
// "1SR: 12" and nothing else, and the games were two modals and a second list
// away. The chevron unfolds them under the row, and a game can be taken there.

/** Free for anyone to take, and inside the season the app opens on (2026/27). */
const FREE = {
  ...GAME,
  id: 'g-free',
  matchNo: '2400001',
  homeTeam: 'VBC Volketswil',
  awayTeam: 'DTV Bülach',
  date: '2026-11-20T19:30:00Z',
  assignedRc: '',
  assignedRcId: '',
};

/** Last season's fixture: the same referee, a season that has been and gone. */
const LAST_SEASON = {
  ...FREE,
  id: 'g-old',
  matchNo: '2300009',
  homeTeam: 'VBC Adliswil',
  awayTeam: 'Volley Kloten',
  date: '2026-01-20T19:30:00Z',
};

const openChevron = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /Show details|Details anzeigen/ }).first();

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
});

test('the chevron lists the coachee\'s next games under their row', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page.getByText(COACHEE_LISTED).first()).toBeVisible();
  // Folded away until asked for — the list is 52 rows long.
  // Home and away sit on their own lines now, with the order saying which is
  // which, so the pair is matched a name at a time rather than as one string.
  await expect(page.getByText(FREE.homeTeam, { exact: true })).toHaveCount(0);
  await expect(page.getByText(FREE.awayTeam, { exact: true })).toHaveCount(0);

  await openChevron(page).click();
  await expect(page.getByText(FREE.homeTeam, { exact: true })).toBeVisible();
  await expect(page.getByText(FREE.awayTeam, { exact: true })).toBeVisible();
});

test('a game can be taken from the row, without opening anything else', async ({ page }) => {
  const assigned: string[] = [];
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push(r.request().url());
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();

  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();
  await expect.poll(() => assigned.length).toBe(1);
  expect(assigned[0]).toContain(`/api/games/${FREE.id}/assign-rc`);
  // Held now, so the row offers the observation instead of the game.
  await expect(page.getByRole('button', { name: /Observe|Beobachten/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Take game|Spiel übernehmen/ })).toHaveCount(0);
});

test('the per-coachee games list can take a game too', async ({ page }) => {
  const assigned: string[] = [];
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push(r.request().url());
    await r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [{ ...FREE, assignedRoles: ['1. SR'] }],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();
  await expect.poll(() => assigned.length).toBe(1);
  await expect(page.getByRole('button', { name: /Start observation|Beobachtung starten/ })).toBeVisible();
});

// The endpoint answers with every game the referee was ever put on. Unscoped,
// last season's fixtures came back as "past games" and were counted into the
// "n games outside the focus hidden" banner — which then read more hidden games
// than the referee has this season.
test('games from another season are not the coachee\'s games this season', async ({ page }) => {
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [
      { ...FREE, assignedRoles: ['1. SR'] },
      { ...LAST_SEASON, assignedRoles: ['1. SR'] },
    ],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByText(/Upcoming Games \(1\)|Bevorstehende Spiele \(1\)/)).toBeVisible();
  await expect(page.getByText(LAST_SEASON.matchNo)).toHaveCount(0);
  // Neither listed nor counted as hidden.
  await expect(page.getByText(/outside the focus|ausserhalb des Fokus/)).toHaveCount(0);
  await expect(page.getByText(/Past Games|Vergangene Spiele/)).toHaveCount(0);
});

// The endpoint answers newest-first — right for the past list underneath, and
// backwards for this one: the game furthest away sat at the top and the next
// one to referee at the bottom.
test('the upcoming list starts with the game that comes next', async ({ page }) => {
  const later = { ...FREE, id: 'g-later', matchNo: '2400003', date: '2027-02-09T19:30:00Z' };
  const middle = { ...FREE, id: 'g-mid', matchNo: '2400002', date: '2026-12-04T19:30:00Z' };
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    // Served the way the API serves them: furthest away first.
    json: [later, middle, FREE].map((g) => ({ ...g, assignedRoles: ['1. SR'] })),
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByText(/Upcoming Games \(3\)|Bevorstehende Spiele \(3\)/)).toBeVisible();
  // Each row is the games-list row: role=button, with the match number beside
  // the league. The "take game" buttons under them carry no number and so are
  // not matched.
  const numbers = page.getByRole('button', { name: /#\d{7}/ });
  await expect(numbers).toHaveText([
    new RegExp(FREE.matchNo),    // 20 Nov 2026 — the next one to referee
    new RegExp(middle.matchNo),  // 4 Dec 2026
    new RegExp(later.matchNo),   // 9 Feb 2027
  ]);
});

test('a game somebody else holds says so instead of offering itself', async ({ page }) => {
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...FREE, assignedRc: 'Jasmin Zimmermann' }],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();

  // The button stays, greyed, and explains itself when clicked. It used to be
  // replaced by a "RC: <name>" label, which reads as a caption rather than as
  // the reason the action is gone — so the row just looked like it had none.
  const take = page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).first();
  await expect(take).toBeVisible();
  await expect(take).toHaveAttribute('aria-disabled', 'true');
  // `force`, because Playwright honours aria-disabled in its actionability
  // check — which is right, and exactly why a real user CAN still click it:
  // the attribute is advisory, the handler is real.
  await take.click({ force: true });
  await expect(page.getByText(/Jasmin Zimmermann (hat dieses Spiel bereits übernommen|already took this game)/)).toBeVisible();
  expect(RC.name).not.toBe('Jasmin Zimmermann');
});

test('a game under the row carries the same marks as on the Games tab — LD, Gewünscht — and says it is in focus', async ({ page }) => {
  // An LD game that the admin also starred. Under the row it read like any
  // other fixture: only the star was drawn there.
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...FREE, isLdGame: true, starred: true }],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  await expect(page.getByText(FREE.homeTeam, { exact: true })).toBeVisible();
  const row = page.locator('[data-testid="game-row"], li, div', { hasText: FREE.homeTeam }).filter({ hasText: /LD Spiel|LD Game/ }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText(/Gewünscht|Priority/);
  await expect(row).toContainText(/Fokus|Focus/);
});

test('an RC-Spiel stays out of the row: it is not on offer, and is counted into "+ n more"', async ({ page }) => {
  // A coach already whistles it next to the coachee (4.4.10), so nobody can
  // take it. It was drawn under the row with a greyed button and a tooltip —
  // "just filter it out, not available" (Luca, 2026-09-16). The full list
  // behind "+ n more" is every game the coachee stands on and keeps it.
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [
      { ...FREE, isRcGame: true, secondReferee: RC.name },
      { ...FREE, id: 'g-plain', matchNo: '2400002', homeTeam: 'Volley Obfelden', awayTeam: 'VBC Kanti Baden', date: '2026-12-04T19:30:00Z' },
    ],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  await expect(page.getByText('Volley Obfelden', { exact: true })).toBeVisible();
  await expect(page.getByText(FREE.homeTeam, { exact: true })).toHaveCount(0);
  await expect(page.getByText(/RC-Spiel|RC Game/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /\+ 1 (more games|weitere Spiele)/ })).toBeVisible();
});

// The row under a coachee is the games list's own row now, not a copy that
// drew the role and the flags alone: a coachee slot in the Börse — the one
// thing Infoschreiben 4.1 asks a coach to check before taking a game — was
// invisible there, and so were the number and the hall.
test('a game under the row carries the Börse mark, the number and the hall, as on the Games tab', async ({ page }) => {
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...FREE, maps_url: 'https://maps.example/utogrund', boerse: BOERSE_RED }],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  const row = page.getByRole('button', { name: new RegExp(FREE.homeTeam) });
  await expect(row.getByText('In Börse')).toBeVisible();
  await expect(row.getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();
  await expect(row.getByText(`#${FREE.matchNo}`)).toBeVisible();
  await expect(row.getByRole('link', { name: /Utogrund/ })).toHaveAttribute('href', 'https://maps.example/utogrund');
  // Both referees, and the Fokus chip, as before.
  await expect(row.getByText(/^Coachee · N3-2/)).toBeVisible();
  await expect(row.getByText(/Fokus|Focus/)).toBeVisible();
});

// The page behind "+ n more" is fed by /api/coachees/:id/games, which carried
// none of the VM marks and never put its Börse verdict on the wire: the same
// LD + RD-marked game showed "LD Spiel" + "Gewünscht" + the Börse wash under
// the coachee's row and none of them one tap later. That was a server bug
// (the route's row map), and it lives in server/index.ts, which no spec here
// runs — every spec stubs the API. What THIS test pins is the client's half:
// the sheet draws every mark the stubbed row carries (LD, Gewünscht with the
// RD title, In Börse with its note, Testspiel) and the "beobachtet" mark on a
// closed role, which it did not before. The open list is empty here on
// purpose, so the marks can only come from the page's own endpoint.
test('the per-coachee games list draws the same marks off its own endpoint', async ({ page }) => {
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [
      coacheeGame({ ...FREE, isLdGame: true, isRdGame: true, vmFlagged: true, starred: true, boerse: BOERSE_RED }),
      coacheeGame({ ...LAST_SEASON, date: '2026-09-02T19:30:00Z', isManual: true, feedbackClosedRoles: ['1. SR'] }),
    ],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await openChevron(page).click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();
  await expect(page.getByText(/Upcoming Games \(1\)|Bevorstehende Spiele \(1\)/)).toBeVisible();

  const upcoming = page.getByRole('button', { name: new RegExp(FREE.homeTeam) });
  await expect(upcoming.getByText(/^(LD Game|LD Spiel)$/)).toBeVisible();
  const star = upcoming.getByText(/^(Priority|Gewünscht)$/);
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('title', /RD/);
  await expect(upcoming.getByText('In Börse')).toBeVisible();
  await expect(upcoming.getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();

  // The past game, behind its button: a Testspiel, already filed for.
  await page.getByRole('button', { name: /Show all games|Alle Spiele|^(Show|Anzeigen)$/ }).first().click();
  const past = page.getByRole('button', { name: new RegExp(LAST_SEASON.homeTeam) });
  await expect(past.getByText(/^(Test game|Testspiel)$/)).toBeVisible();
  await expect(past.getByText(/^(observed|beobachtet)$/)).toBeVisible();
});

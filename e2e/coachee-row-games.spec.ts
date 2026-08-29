import { test, expect } from '@playwright/test';
import { stubSignedInApp, COACHEE, GAME, RC } from './support/app';

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
  page.getByRole('button', { name: /Show games|Spiele anzeigen/ }).first();

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
});

test('the chevron lists the coachee\'s next games under their row', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page.getByText(COACHEE.full_name).first()).toBeVisible();
  // Folded away until asked for — the list is 52 rows long.
  await expect(page.getByText(`${FREE.homeTeam} vs ${FREE.awayTeam}`)).toHaveCount(0);

  await openChevron(page).click();
  await expect(page.getByText(`${FREE.homeTeam} vs ${FREE.awayTeam}`)).toBeVisible();
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
  const numbers = page.locator('div.font-semibold.text-stone-900.text-sm');
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

  await expect(page.getByText(`RC: Jasmin Zimmermann`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Take game|Spiel übernehmen/ })).toHaveCount(0);
  expect(RC.name).not.toBe('Jasmin Zimmermann');
});

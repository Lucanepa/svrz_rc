import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC, COACHEE, COACHEE_LISTED, GAME } from './support/app';

/**
 * A coachee's own list and a filed observation have addresses.
 *
 * They used to be reachable only by clicking: `#/coachee-games` named the
 * screen but not whose it was, so on a cold load it could only drop you back on
 * the coachee list, and a filed observation had no URL at all. Neither could be
 * bookmarked, mailed to the other coach on the game, or reopened after a
 * refresh. The id in the path is what fixes that — with it the app fetches what
 * it needs instead of relying on a selection carried from the screen before.
 */

const RECORD = {
  id: 'fb1',
  role_assessed: '1. SR',
  rc_name: RC.name,
  submitted_at: '2026-03-15T10:00:00Z',
  feedback_json: {
    role: '1. SR', lang: 'EN',
    meta: {
      spielNr: '2345678', liga: '3L', datum: '14.03.2026', ort: 'Utogrund',
      mannschaften: 'A vs B', ergebnis: '3:0', srName: COACHEE.full_name,
      srNiveau: 'N3', rc: RC.name, gruppe: 'B',
    },
    sections: [],
    results: { motivation: 'up', einstufung: 'check', bemerkungen: 'ok', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
    signature: '', rcSignature: '',
  },
  expand: {
    game: {
      id: 'g1', match_no: '2345678', league: '3L', match_date: '2026-03-14',
      location: 'Utogrund', home_team: 'A', away_team: 'B',
      first_referee: COACHEE.full_name, second_referee: '',
    },
  },
};

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [{ ...GAME, assignedRoles: ['1. SR'] }],
  }));
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [RECORD] }));
});

test('a coachee\'s games open from the URL alone, with nothing carried over', async ({ page }) => {
  await page.goto(`/#/games/${COACHEE.id}`);

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  // Whose list it is, not just that it is a list: the header names them.
  await expect(page.getByText(COACHEE.full_name).first()).toBeVisible();
  await expect(page.getByText(`${GAME.homeTeam}`)).toBeVisible();
});

test('clicking through to that list puts its address in the URL', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await page.getByText(COACHEE_LISTED).first().click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#/games/${COACHEE.id}$`));
});

test('a filed observation opens from its own URL', async ({ page }) => {
  await page.goto(`/#/feedbacks/${COACHEE.id}/${RECORD.id}`);

  // The form, filled in from the record rather than blank. A filed observation
  // reopens read-only, which is the tell that the record — not a fresh form —
  // is what is on screen.
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(page.locator('input[value="2345678"]').first()).toBeVisible();
});

test('a link to somebody who is not there says so', async ({ page }) => {
  await page.goto('/#/games/c-nobody');

  await expect(page.getByText(/not found|nicht gefunden/)).toBeVisible();
  // And lands on the list it could not narrow, rather than on an empty shell.
  await expect(page.getByText(COACHEE_LISTED)).toBeVisible();
});

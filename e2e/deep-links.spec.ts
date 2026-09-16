import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC, COACHEE, COACHEE_LISTED, GAME } from './support/app';

/**
 * A coachee's own list and a filed observation have addresses.
 *
 * They used to be reachable only by clicking: `/coachee-games` named the
 * screen but not whose it was, so on a cold load it could only drop you back on
 * the coachee list, and a filed observation had no URL at all. Neither could be
 * bookmarked, mailed to the other coach on the game, or reopened after a
 * refresh. The id in the path is what fixes that — with it the app fetches what
 * it needs instead of relying on a selection carried from the screen before.
 *
 * The coachee half of the address is their SV number once the row is linked
 * to the referee register (`/games/90003`), the record id until then. A
 * licence number outlives the season's row, so the link a coach mailed in
 * April still names the same person after the roll-over; a record id is one
 * season's row. Both shapes resolve, forever: the record-id form is what an
 * unlinked coachee is still addressed by and what every link sent before
 * carries, so the two `/games/c1` tests below are a permanent contract, not a
 * transition. The observation half stays the record id — a filed report has
 * no natural key.
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

test('a coachee\'s games open from their SV number alone, with nothing carried over', async ({ page }) => {
  await page.goto(`/games/${COACHEE.referee_id}`);

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  // Whose list it is, not just that it is a list: the header names them.
  await expect(page.getByText(COACHEE.full_name).first()).toBeVisible();
  await expect(page.getByText(`${GAME.homeTeam}`)).toBeVisible();
  // And the API is still asked by the record id: the number is an address
  // for people, the PWA's cached `/api/coachees/<id>/*` entries stay valid.
  await expect(page).toHaveURL(new RegExp(`/games/${COACHEE.referee_id}$`));
});

test('the record-id form of that link keeps working, and the bar shows the number afterwards', async ({ page }) => {
  await page.goto(`/games/${COACHEE.id}`);

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  await expect(page.getByText(COACHEE.full_name).first()).toBeVisible();
  await expect(page.getByText(`${GAME.homeTeam}`)).toBeVisible();
  // Canonicalised in place — replaceState, so the typed shape leaves no Back
  // entry of its own underneath the one the app writes.
  await expect(page).toHaveURL(new RegExp(`/games/${COACHEE.referee_id}$`));
  expect(await page.goBack()).toBeNull();
});

test('clicking through to that list puts its address in the URL', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await page.getByText(COACHEE_LISTED).first().click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  // The number, not the record id: the fixture is linked to the register.
  await expect(page).toHaveURL(new RegExp(`/games/${COACHEE.referee_id}$`));
});

test('a filed observation opens from its own URL', async ({ page }) => {
  await page.goto(`/feedbacks/${COACHEE.referee_id}/${RECORD.id}`);

  // The form, filled in from the record rather than blank. A filed observation
  // reopens read-only, which is the tell that the record — not a fresh form —
  // is what is on screen.
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(page.locator('input[value="2345678"]').first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/feedbacks/${COACHEE.referee_id}/${RECORD.id}$`));
});

test('a filed observation still opens from the record-id form of its URL', async ({ page }) => {
  await page.goto(`/feedbacks/${COACHEE.id}/${RECORD.id}`);

  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(page.locator('input[value="2345678"]').first()).toBeVisible();
});

test('Back onto an old-shape entry re-resolves it without adding a step', async ({ page }) => {
  // The running app, not a cold load: an entry that still reads `/games/c1`
  // (a bookmark from before the number was written there, a tab that was
  // open across the deploy) is stepped back onto. The app resolves it and
  // writes `/games/90003` — and must REPLACE that entry, not push on top of
  // it: pushed, the next Back would land on `/games/c1` again, be rewritten
  // again, and never get past it. Two things in App.tsx keep that from
  // happening — the popstate flag that makes the next sync replace, and
  // historyKeyOf reading both shapes as one view for the case the render
  // outlives the flag — and this pins the outcome, whichever of them held.
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page).toHaveURL(/\/coachees$/);
  await page.evaluate(() => {
    history.pushState(null, '', '/games/c1');
    history.pushState(null, '', '/coachees');
  });

  await page.goBack();
  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/games/${COACHEE.referee_id}$`));

  // One more Back is the Coachees tab, not the same list under its old name.
  await page.goBack();
  await expect(page).toHaveURL(/\/coachees$/);
  await expect(page.getByText(COACHEE_LISTED)).toBeVisible();
});

test('the SV number in the address does not reach the activity log', async ({ page }) => {
  // The number is no capability — it is printed on every score sheet — but
  // it is a person, and the Protokoll is read by every admin. The logger
  // masks every URL it writes down; the record id, which names nobody to a
  // reader, is left as it is.
  await page.goto(`/games/${COACHEE.referee_id}`);
  await expect(page.getByText(/Upcoming Games|Bevorstehende Spiele/)).toBeVisible();
  // A click, so the ui.click line (which carries the path) is written too.
  await page.getByText(`${GAME.homeTeam}`).click();

  type Entry = { evt: string; msg?: string; data?: Record<string, unknown> };
  const logs = await page.evaluate(() => (window as unknown as { svrzLogs: () => Entry[] }).svrzLogs());
  const start = logs.find((e) => e.evt === 'app.start');
  expect(start?.data?.url).toMatch(/\/games\/<sv>$/);
  const click = logs.filter((e) => e.evt === 'ui.click').pop();
  expect(click?.data?.path).toBe('/games/<sv>');
  expect(JSON.stringify(logs)).not.toContain(`/games/${COACHEE.referee_id}`);
});

test('a link to a record the coachee does not have lands on their list, not on a blank form', async ({ page }) => {
  // The record went (deleted in the console) after the link was mailed. The
  // route's own view is the form; with no record to open, that form is a
  // blank one for whatever game was auto-selected, and the sync effect then
  // wrote ITS address (`/form/2345678/1sr`) over the dead link. Say so, and
  // land on the coachee's history over the list — where `/feedbacks/<coachee>`
  // without a record lands too.
  await page.goto(`/feedbacks/${COACHEE.referee_id}/fb-nobody`);

  await expect(page.getByText(/Observation not found|Beobachtung nicht gefunden/)).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(COACHEE.full_name);
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toHaveCount(0);
  await expect(page).toHaveURL(/\/coachees$/);
});

test('a link to somebody who is not there says so', async ({ page }) => {
  await page.goto('/games/c-nobody');

  await expect(page.getByText(/not found|nicht gefunden/)).toBeVisible();
  // And lands on the list it could not narrow, rather than on an empty shell.
  await expect(page.getByText(COACHEE_LISTED)).toBeVisible();
});

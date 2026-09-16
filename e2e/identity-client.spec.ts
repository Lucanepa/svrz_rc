import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, fillWholeForm, GAME, GAME_NOSV, COACHEE, COACHEE_UNLINKED, RC } from './support/app';

/**
 * The contract the client keeps since the ids went on the wire: it does not
 * match anybody by name.
 *
 * Who stands on a game's slot is `firstCoacheeId` / `secondCoacheeId`, resolved
 * on the server for the game's season (SV number first); whose the game is, is
 * `assignedRcId`. The client reads those and draws the badge, lists the game
 * under the row, fills the form and offers "Abgeben" from them alone — the
 * printed name is what the screen shows, never what it decides on. The one
 * exception is a row that carries no such field at all (an API older than the
 * ids, a list the PWA cached before them), which falls to the folded name the
 * way the whole app used to; that path is pinned here too so it cannot quietly
 * die, and so it cannot quietly take over.
 *
 * Every case below is a fixture the server can send and the old client got
 * wrong: a licence spelling the roster does not hold, a namesake, a coach's
 * name written with two spaces, and the confirm dialog naming the coachee the
 * coach came FROM over the one the report is ABOUT.
 */

const openHeldGame = async (page: Page, homeTeam: string) => {
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
  await page.getByText(homeTeam).first().click();
};

const giveBack = (page: Page) => page.getByRole('button', { name: /^(Give back|Abgeben)$/ });
const takeGame = (page: Page) => page.getByRole('button', { name: /Take game|Spiel übernehmen/ });
const startObservation = (page: Page) => page.getByRole('button', { name: /Start observation|Beobachtung starten/ });
const coacheeBadge = (page: Page) => page.getByText(/^Coachee ·/);
const openChevron = (page: Page) => page.getByRole('button', { name: /Show details|Details anzeigen/ }).first();

test.describe('the slot is whoever the server said', () => {
  // The convocation prints a name the roster does not hold under any fold —
  // and the server matched it by SV number all the same.
  const LICENCE_SPELLING = { ...GAME, firstReferee: 'Zzz Nobody', firstCoacheeId: COACHEE.id };

  test('a referee the roster does not spell that way is still the coachee: badge, and Niveau on the form', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [LICENCE_SPELLING] }));
    await page.goto('/');
    await openHeldGame(page, GAME.homeTeam);

    await expect(page.getByText('Zzz Nobody').first()).toBeVisible();
    await expect(coacheeBadge(page)).toHaveText(/Coachee · N3-2/);

    await startObservation(page).click();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
    await expect(page.getByLabel(/Referee level/i)).toHaveValue('N3 - 2');
  });

  test('...and the game is listed under the coachee\'s row', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [LICENCE_SPELLING] }));
    await page.goto('/coachees');
    await openChevron(page).click();

    await expect(page.getByText(GAME.homeTeam, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Observe|Beobachten/ })).toBeVisible();
  });

  test('a referee spelled exactly like a coachee, whom the server resolved to nobody, is nobody\'s coachee', async ({ page }) => {
    await stubSignedInApp(page);
    // The same string as the row — a namesake, or a row of another season —
    // and the server's answer is ''. That answer stands: no badge, not in the
    // coachee filter, nothing under the row.
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [{ ...GAME, firstReferee: COACHEE.full_name, firstCoacheeId: '', assignedRc: '', assignedRcId: '' }],
    }));
    await page.goto('/games');

    await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
    await expect(page.getByText(COACHEE.full_name).first()).toBeVisible();
    await expect(coacheeBadge(page)).toHaveCount(0);

    await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
    await page.getByRole('button', { name: /All coachees|Alle Coachees/ }).click();
    await expect(page.getByText(/No options|Keine Optionen/)).toBeVisible();

    await page.getByRole('button', { name: /^Coachees$/ }).click();
    await openChevron(page).click();
    await expect(page.getByText(/No upcoming games|Keine bevorstehenden Spiele/)).toBeVisible();
  });
});

test.describe('the holder is whoever the id says', () => {
  const people = (page: Page, rows: Array<{ id: string; fullName: string }>) =>
    page.route('**/api/referee-coach-people', (r) => r.fulfill({ json: rows }));

  test('my id under a name spelled differently: mine — Abgeben and Beobachtung starten', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [{ ...GAME, assignedRc: 'ANNA  MÜSTER', assignedRcId: RC.id }],
    }));
    await page.goto('/');
    await openHeldGame(page, GAME.homeTeam);

    await expect(giveBack(page)).toBeVisible();
    await expect(startObservation(page)).toBeEnabled();
  });

  test('my name under a namesake\'s id: theirs — taken by someone else', async ({ page }) => {
    await stubSignedInApp(page);
    // Two coaches on the roster fold to one name; the game carries the
    // OTHER one's id. The name is not permission to give away their game.
    await people(page, [{ id: RC.id, fullName: RC.name }, { id: 'rc2', fullName: RC.name }]);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [{ ...GAME, assignedRc: RC.name, assignedRcId: 'rc2' }],
    }));
    await page.goto('/');
    await openHeldGame(page, GAME.homeTeam);

    await expect(takeGame(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(giveBack(page)).toHaveCount(0);
    await expect(startObservation(page)).toBeDisabled();
  });

  test('an id nobody on the roster has, under my name: mine — the name fallback the server applies too', async ({ page }) => {
    await stubSignedInApp(page);
    await people(page, [{ id: RC.id, fullName: RC.name }]);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [{ ...GAME, assignedRc: RC.name, assignedRcId: 'rc-gone' }],
    }));
    await page.goto('/');
    await openHeldGame(page, GAME.homeTeam);

    await expect(giveBack(page)).toBeVisible();
    await expect(startObservation(page)).toBeEnabled();
  });

  test('a pushed assignment carrying my id flips the game to mine, whatever name it carries', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [{ ...GAME, assignedRc: '', assignedRcId: '' }],
    }));
    // Held back a moment so the push cannot land before the first render.
    await page.route('**/api/events', async (r) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await r.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
        body: `retry: 5000\n\ndata: ${JSON.stringify({ type: 'game.assignment', gameId: GAME.id, matchNo: GAME.matchNo, assignedRc: 'A. Muster', assignedRcId: RC.id })}\n\n`,
      });
    });
    await page.goto('/games');
    await expect(page.getByText(GAME.homeTeam)).toBeVisible();
    // Taken now, so it leaves the open list...
    await expect(page.getByText(GAME.homeTeam)).toHaveCount(0, { timeout: 10_000 });

    // ...and under the held games it is mine.
    await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
    await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
    await page.getByText(GAME.homeTeam).first().click();
    await expect(giveBack(page)).toBeVisible();
  });
});

test('with every id stripped — an older API, a cached list — the names still carry the day', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME_NOSV] }));
  await page.goto('/');
  await openHeldGame(page, GAME.homeTeam);

  await expect(coacheeBadge(page)).toHaveText(/Coachee · N3-2/);
  await expect(giveBack(page)).toBeVisible();
  await startObservation(page).click();
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
  await expect(page.getByLabel(/Referee level/i)).toHaveValue('N3 - 2');
});

test.describe('the confirm dialog names the referee the report is about', () => {
  test.slow(); // fills the whole form and signs twice — past 30 s on a GitHub runner

  test('after a role flip, not the coachee the coach came from', async ({ page }) => {
    await stubSignedInApp(page);
    // Two coachees on one whistle. The coach opens the game from the FIRST
    // one's row and then flips the form to the second referee: the report,
    // and the mail, are about the second one.
    const second = COACHEE_UNLINKED;
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, second] }));
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [{ ...GAME, secondReferee: second.full_name, secondCoacheeId: second.id, secondCoacheeVia: 'name' }],
    }));
    await page.goto('/coachees');
    await openChevron(page).click();
    await page.getByRole('button', { name: /Observe|Beobachten/ }).click();
    await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();

    // Both are coachees, so the app opened on "both"; single out the 2. SR.
    await page.getByRole('button', { name: /^2SR/ }).click();
    await expect(page.getByLabel('2. SR', { exact: true })).toHaveValue(second.full_name);

    await fillWholeForm(page);
    await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
    const dialog = page.getByRole('heading', { name: /Save feedback|Feedback speichern/ }).locator('xpath=..');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${second.full_name} <${second.email}>`);
    await expect(dialog).not.toContainText(COACHEE.email);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// Confirmations and "it worked" notices are the app's own now: a modal rendered
// by <UiHost/> and a toast stack, in place of window.confirm and window.alert.
// Everything the browser used to guarantee is ours to get right — the answer has
// to travel back to the caller, cancelling has to change nothing at all, and a
// success has to say so out loud. Home's "give game back" is the cheapest real
// flow that exercises all three (it asks, it calls the server, it toasts), so
// the kit is pinned through it rather than through a fixture proving only itself.

const game = (n: number) => ({
  gameId: `g${n}`,
  gameDate: `2026-10-${String(n).padStart(2, '0')}T19:30:00Z`,
  league: '3L ♂ A',
  teams: `Heim ${n} vs Gast ${n}`,
  refereeName: 'Coachee Eins',
  result: '',
});

/** Every request that reached the assign endpoint — an empty array is proof of "nothing happened". */
type Assignment = { url: string; body: string };

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  // Regexes, not globs: "?" is a single-character wildcard in Playwright's glob
  // syntax, so '**/api/rc-overview?*' never matches the query string.
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 2 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Coachee Eins',
      doneFeedbacks: [], outstandingGames: [],
      plannedGames: [game(1), game(2)],
    }],
  }));
});

/** Record every assign-rc call, land on Home and hand back the button that asks. */
async function openHome(page: Page): Promise<{ assigned: Assignment[] }> {
  const assigned: Assignment[] = [];
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push({ url: r.request().url(), body: r.request().postData() || '' });
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto('/#/home');
  await expect(page.getByRole('button', { name: 'Give game back' }).first()).toBeVisible();
  return { assigned };
}

// A success toast fired by another part of the app would make a bare "no toast"
// assertion lie; the ones these tests care about are the successes.
const successToast = (page: Page) =>
  page.locator('[data-testid="toast"][data-toast-kind="success"]');

test('the modal names what it is about to do, and Cancel does none of it', async ({ page }) => {
  const { assigned } = await openHome(page);

  await page.getByRole('button', { name: 'Give game back' }).first().click();

  const dialog = page.getByTestId('confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('confirm-title')).toContainText('Give game back');
  // Which game is the whole point: a confirmation that does not name it is a
  // coin toss, and this row sits beside an identical one. The label lives in the
  // message rather than the title — as a title it wrapped to four bold lines on
  // a phone and pushed the verb away from the question mark.
  await expect(page.getByTestId('confirm-message')).toContainText('Heim 1 vs Gast 1');
  // And what it costs — the game goes back to everyone, not into a bin.
  await expect(page.getByTestId('confirm-message')).toContainText(/referee coach/i);

  await page.getByTestId('confirm-cancel').click();
  await expect(dialog).toHaveCount(0);

  // Cancel means the server was never told anything and the row is still there.
  expect(assigned).toHaveLength(0);
  await expect(page.getByRole('button', { name: /H:\s*Heim 1\s+A:\s*Gast 1/ })).toBeVisible();
  await expect(successToast(page)).toHaveCount(0);
});

test('confirming hands the game back and the toast says so', async ({ page }) => {
  const { assigned } = await openHome(page);

  await page.getByRole('button', { name: 'Give game back' }).first().click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-accept').click();

  // The promise resolved true and the caller carried on: the same call the
  // games list makes, on the game the row was showing.
  await expect.poll(() => assigned.length).toBe(1);
  expect(assigned[0].url).toContain('/api/games/g1/assign-rc');
  // Empty name = release. The server only ever let a coach clear their own.
  expect(JSON.parse(assigned[0].body)).toEqual({ assignedRc: '' });

  // The row vanishing is not enough of an answer on a list of near-identical
  // rows — something has to confirm which game left.
  const toast = successToast(page);
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Heim 1 vs Gast 1');
});

test('Escape closes the modal and counts as a cancel', async ({ page }) => {
  const { assigned } = await openHome(page);

  await page.getByRole('button', { name: 'Give game back' }).first().click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);

  // "Closed" is not the claim being tested — "answered NO" is. A dialog that
  // unmounted while its promise never settled looks exactly the same on screen.
  expect(assigned).toHaveLength(0);
  await expect(successToast(page)).toHaveCount(0);
  // And Escape did not also peel a layer off the screen behind it: Home is
  // still Home, with the row still offering to give the game back.
  await expect(page.getByRole('button', { name: 'Give game back' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /H:\s*Heim 1\s+A:\s*Gast 1/ })).toBeVisible();
});

import { test, expect } from '@playwright/test';
import { stubSignedInApp, summaryGame, BOERSE_RED, GAME, GAME_LD, GAME_MANUAL, GAME_VM, RC } from './support/app';

// Home promises a number of planned games in its counter and then lists them.
// The list used to stop at eight rows without saying so, so a coach with ten
// planned games read "10" beside a list of eight and had no way to reach the
// last two. And handing a game back meant leaving Home, finding the game in the
// list and opening its card — the row that already shows it can do it.

const game = (n: number) => ({
  gameId: `g${n}`,
  gameDate: `2026-10-${String(n).padStart(2, '0')}T19:30:00Z`,
  league: '3L ♂ A',
  teams: `Heim ${n} vs Gast ${n}`,
  refereeName: 'Coachee Eins',
  result: '',
});

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  // Regexes, not globs: "?" is a single-character wildcard in Playwright's glob
  // syntax, so '**/api/rc-overview?*' never matches the query string it looks
  // like it should.
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 10 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Coachee Eins',
      doneFeedbacks: [], outstandingGames: [],
      plannedGames: Array.from({ length: 10 }, (_, i) => game(i + 1)),
    }],
  }));
});

// The games list says "Gewünscht" on a flagged fixture, and taking it must not
// make the request disappear from the coach's own list.
test('a flagged game keeps its star on Home', async ({ page }) => {
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Coachee Eins',
      doneFeedbacks: [], outstandingGames: [],
      plannedGames: [{ ...game(1), starred: true, vmFlagged: true, isRdGame: true }, game(2)],
    }],
  }));
  await page.goto('/home');
  const star = page.getByText(/^(Priority|Gewünscht)$/);
  await expect(star).toHaveCount(1);
  await expect(star).toHaveAttribute('title', /RD/);
  const flagged = page.getByTestId('game-row').filter({ hasText: /Heim 1/ });
  await expect(flagged.getByText(/^(Priority|Gewünscht)$/)).toBeVisible();
});

// The same fixture on the Games tab and on Home draws the same chips: LD
// Spiel, Testspiel, Gewünscht (with its RD tooltip), the coachee with the
// Niveau, and the Börse mark on the slot. 1c26a99 pinned the RC-Spiel chip on
// Home alone; the rest of the set had no spec on this list.
test('LD, Testspiel and a VM-starred game wear the same chips on Home as on the Games tab', async ({ page }) => {
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Ref One',
      doneFeedbacks: [], outstandingGames: [],
      plannedGames: [
        summaryGame(GAME_LD),
        summaryGame(GAME_MANUAL),
        summaryGame(GAME_VM, { boerse: BOERSE_RED }),
        summaryGame(GAME, { feedbackClosedRoles: ['1. SR'] }),
      ],
    }],
  }));
  await page.goto('/home');

  const row = (home: string) => page.getByTestId('game-row').filter({ hasText: home });
  await expect(row(GAME_LD.homeTeam)).toBeVisible();
  await expect(row(GAME_LD.homeTeam).getByText(/^(LD Game|LD Spiel)$/)).toBeVisible();
  await expect(row(GAME_MANUAL.homeTeam).getByText(/^(Test game|Testspiel)$/)).toBeVisible();
  const star = row(GAME_VM.homeTeam).getByText(/^(Priority|Gewünscht)$/);
  await expect(star).toBeVisible();
  await expect(star).toHaveAttribute('title', /RD/);
  // Each chip on its own row and nowhere else.
  await expect(page.getByText(/^(LD Game|LD Spiel)$/)).toHaveCount(1);
  await expect(page.getByText(/^(Test game|Testspiel)$/)).toHaveCount(1);
  await expect(page.getByText(/^(Priority|Gewünscht)$/)).toHaveCount(1);

  // The coachee's slot in the Börse: the word on the chip and the line under
  // the row, as on the Games tab.
  await expect(row(GAME_VM.homeTeam).getByText('In Börse')).toBeVisible();
  await expect(row(GAME_VM.homeTeam).getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();
  // The coachee mark carries the Niveau, as the Games tab's does.
  await expect(row(GAME_LD.homeTeam).getByText(/^Coachee · N3-2$/)).toBeVisible();
  // A role already filed for says so — the field gated the form and was
  // drawn nowhere.
  await expect(row(GAME.homeTeam).getByText(/^(observed|beobachtet)$/)).toBeVisible();
  await expect(page.getByText(/^(observed|beobachtet)$/)).toHaveCount(1);
});

test('every planned game the counter promises is listed', async ({ page }) => {
  await page.goto('/home');
  // The dashboard's summary strip, which replaced the three counter tiles:
  // the same figures, still labelled, on one line.
  await expect(page.getByText(/10 planned|10 geplant/)).toBeVisible();

  // All of them, however many there are: the list is the answer to the counter
  // beside it, and a row that is cut off is a game with no way back.
  // The card is no longer a button (the row carries its own three), so the
  // rows are counted by their test id. `teams` in the API payload still
  // carries " vs " — the separator the app splits on — which is why the
  // confirm text and the toast below still match the original string.
  const rows = page.getByTestId('game-row').filter({ hasText: /Heim \d+/ });
  await expect(rows).toHaveCount(10);
});

test('a game can be given back from the row that shows it', async ({ page }) => {
  const assigned: { url: string; body: string }[] = [];
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push({ url: r.request().url(), body: r.request().postData() || '' });
    await r.fulfill({ json: { ok: true } });
  });

  await page.goto('/home');
  const giveBack = page.getByRole('button', { name: 'Give game back' }).first();
  await expect(giveBack).toBeVisible();

  // Cancelled: the game stays. Nothing is handed back on a mis-tap.
  // The confirmation is the app's own modal now, so the order is the reverse of
  // a native dialog's: click the button, then answer what appears.
  await giveBack.click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
  expect(assigned).toHaveLength(0);

  await giveBack.click();
  await expect(page.getByTestId('confirm-dialog')).toBeVisible();
  await page.getByTestId('confirm-accept').click();
  await expect.poll(() => assigned.length).toBe(1);
  expect(assigned[0].url).toContain('/api/games/g1/assign-rc');
  // Empty name AND empty id = release; both halves travel on every call, the
  // name for an API older than the id. The server only ever let a coach clear
  // their own.
  expect(JSON.parse(assigned[0].body)).toEqual({ assignedRc: '', assignedRcId: '' });
});

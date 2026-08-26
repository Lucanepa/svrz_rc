import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

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

test('every planned game the counter promises is reachable', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByText('Planned', { exact: true })).toBeVisible();

  const rows = page.getByRole('button', { name: /Heim \d+ vs Gast \d+/ });
  await expect(rows).toHaveCount(8);
  // The rest are not dropped in silence — they are behind a control that says
  // how many there are.
  await page.getByRole('button', { name: 'Show 2 more' }).click();
  await expect(rows).toHaveCount(10);
});

test('a game can be given back from the row that shows it', async ({ page }) => {
  const assigned: { url: string; body: string }[] = [];
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push({ url: r.request().url(), body: r.request().postData() || '' });
    await r.fulfill({ json: { ok: true } });
  });

  await page.goto('/#/home');
  const giveBack = page.getByRole('button', { name: 'Give game back' }).first();
  await expect(giveBack).toBeVisible();

  // Dismissed: the game stays. Nothing is handed back on a mis-tap.
  page.once('dialog', (d) => d.dismiss());
  await giveBack.click();
  expect(assigned).toHaveLength(0);

  page.once('dialog', (d) => d.accept());
  await giveBack.click();
  await expect.poll(() => assigned.length).toBe(1);
  expect(assigned[0].url).toContain('/api/games/g1/assign-rc');
  // Empty name = release. The server only ever let a coach clear their own.
  expect(JSON.parse(assigned[0].body)).toEqual({ assignedRc: '' });
});

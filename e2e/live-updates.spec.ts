import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// The API pushes an assignment the moment it changes (/api/events). Two things
// have to hold, and the second one matters more: the pushed change lands without
// anyone asking, and the app is exactly as usable when the stream never
// connects — a hotel WiFi, a proxy that eats text/event-stream, a suspended iOS
// tab. The poll is the floor under all of it.

const sse = (frames: string[]) => ({
  status: 200,
  headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  body: `retry: 5000\n\n${frames.map((f) => `data: ${f}\n\n`).join('')}`,
});

test('a game taken elsewhere leaves the list on a pushed event, with no refetch', async ({ page }) => {
  let listFetches = 0;
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => {
    listFetches += 1;
    return r.fulfill({ json: [{ ...GAME, id: 'g1', assignedRc: '' }] });
  });
  await page.route('**/api/events', (r) => r.fulfill(sse([
    JSON.stringify({ type: 'game.assignment', gameId: 'g1', matchNo: '402430', assignedRc: 'Bea Beispiel' }),
  ])));

  await page.goto('/#/games');
  await expect(page.getByText(GAME.homeTeam)).toBeVisible();
  const afterFirstLoad = listFetches;

  // Held by somebody else now, so it is not on offer — and the row went without
  // the list being fetched again: the event carried the answer.
  await expect(page.getByText(GAME.homeTeam)).toHaveCount(0, { timeout: 10_000 });
  expect(listFetches).toBe(afterFirstLoad);
});

test('a refused stream costs nothing — the list still works', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, id: 'g1', assignedRc: '' }] }));
  await page.route('**/api/events', (r) => r.abort('failed'));

  await page.goto('/#/games');
  await expect(page.getByText(GAME.homeTeam)).toBeVisible();
  // Still interactive: the row opens, and the take button is there to be used.
  await page.getByText(GAME.homeTeam).click();
  await expect(page.getByRole('button', { name: 'Take game' })).toBeVisible();
});

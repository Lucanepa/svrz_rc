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
    return r.fulfill({ json: [{ ...GAME, id: 'g1', assignedRc: '', assignedRcId: '' }] });
  });
  // Held back until the app is at rest: a push that lands before the first
  // render asserts on a row that never appeared, and one that lands while the
  // boot is still reading would be credited with the boot's own fetches.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/events', async (r) => {
    await released;
    // The holder's id rides beside the name, the way the API sends it now;
    // the client reads whose the game is off the id (identity-client.spec.ts
    // pins that) and the row leaves the list either way.
    await r.fulfill(sse([
      JSON.stringify({ type: 'game.assignment', gameId: 'g1', matchNo: '402430', assignedRc: 'Bea Beispiel', assignedRcId: 'rc2' }),
    ]));
  });

  await page.goto('/games');
  await expect(page.getByText(GAME.homeTeam)).toBeVisible();
  // At rest: after the first load the offline warm-up (App.tsx, once per
  // session) reads the list once more, and how soon depends on the machine —
  // 12.10.2026 it landed after the row on every local run. The baseline is
  // taken once a full second passes with no fetch.
  await expect.poll(async () => {
    const before = listFetches;
    await page.waitForTimeout(1000);
    return listFetches === before;
  }, { timeout: 10_000 }).toBe(true);
  const afterFirstLoad = listFetches;
  release();

  // Held by somebody else now, so it is not on offer — and the row went without
  // the list being fetched again: the event carried the answer.
  await expect(page.getByText(GAME.homeTeam)).toHaveCount(0, { timeout: 10_000 });
  expect(listFetches).toBe(afterFirstLoad);
});

test('a refused stream costs nothing — the list still works', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, id: 'g1', assignedRc: '', assignedRcId: '' }] }));
  await page.route('**/api/events', (r) => r.abort('failed'));

  await page.goto('/games');
  await expect(page.getByText(GAME.homeTeam)).toBeVisible();
  // Still interactive: the row opens, and the take button is there to be used.
  await page.getByText(GAME.homeTeam).click();
  await expect(page.getByRole('button', { name: 'Take game' })).toBeVisible();
});

import { test, expect, type Page } from '@playwright/test';

/**
 * The demo (`/demo`, src/lib/demo.ts) is a throwaway coach with a season of
 * fake data and a promise of ZERO backend calls. Every client site that has
 * moved onto an id — the summary asked by roster id, "mine" decided by the
 * holder's id — is a site the demo has to answer with an id of its own, and
 * one it silently does not answer is a Home with no rows and a taken game
 * that never reads as taken. Nobody notices until the guide video is
 * re-recorded. So this is the demo's contract, not stubbed: the dev proxy
 * points at a closed port (playwright.config.ts), so any call that leaks
 * fails loudly rather than being quietly served.
 */

const enterDemo = async (page: Page) => {
  await page.goto('/demo');
  await expect(page.getByText(/^DEMO — /)).toBeVisible();
  await expect(page).toHaveURL(/\/home$/);
};

const giveBack = (page: Page) => page.getByRole('button', { name: /^(Give back|Abgeben)$/ });
const takeGame = (page: Page) => page.getByRole('button', { name: /Take game|Spiel übernehmen/ });
const startObservation = (page: Page) => page.getByRole('button', { name: /Start observation|Beobachtung starten/ });

test('Home shows the demo coach\'s summary — the lists behind the counters', async ({ page }) => {
  await enterDemo(page);

  // The counters come from the overview, the rows from the summary — asked
  // by the coach's roster id now, which the demo must answer like the name
  // it used to be asked by. Three planned fixtures in the dataset, one
  // outstanding, two filed.
  await expect(page.getByText(/3 planned|3 geplant/)).toBeVisible();
  await expect(page.getByText(/1 outstanding|1 offen/)).toBeVisible();
  // A planned game, on its row: GameRow prints the two teams on their own
  // lines, so the home team is what to look for.
  await expect(page.getByRole('button', { name: /DTV Bülach\s+VBC Züri Unterland/ })).toBeVisible();
  // The outstanding one — a past game still owed an observation.
  await expect(page.getByRole('button', { name: /TV Wittenbach\s+VBC Kanti Schaffhausen/ })).toBeVisible();
});

test('a game taken in the demo reads as mine', async ({ page }) => {
  await enterDemo(page);

  // The one fixture nobody holds yet: taking it stores the demo coach's id
  // beside the name, and the row decides "mine" off that id — the same rule
  // the server applies (identity-client.spec.ts pins it against the API).
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).click();
  await page.getByText('VBC Volketswil').first().click();
  await expect(takeGame(page)).toBeEnabled();
  await takeGame(page).click();
  const dialog = page.getByTestId('confirm-dialog');
  if (await dialog.isVisible().catch(() => false)) await page.getByTestId('confirm-accept').click();

  await expect(giveBack(page)).toBeVisible();
  await expect(startObservation(page)).toBeEnabled();

  // ...and Home counts it as planned from then on: the demo's counters are
  // derived from the same store the take wrote to.
  await page.getByRole('button', { name: /^(Home|Start)$/ }).click();
  await expect(page.getByText(/4 planned|4 geplant/)).toBeVisible();
  await expect(page.getByRole('button', { name: /VBC Volketswil\s+DTV Bülach/ })).toBeVisible();
});

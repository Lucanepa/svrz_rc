import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// Taking a game changes what everyone else may take, and nothing pushes that
// out. A coach who left the list open kept seeing "Take game" on a game that
// was already gone, and only found out by tapping it. Two things have to hold:
// the server refuses the second taker, and the screen that was behind repairs
// itself instead of staying wrong.

test('a game taken elsewhere leaves the open list when the window is looked at again', async ({ page }) => {
  let takenBySomeoneElse = false;
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...GAME, assignedRc: takenBySomeoneElse ? 'Bea Beispiel' : '' }],
  }));

  await page.goto('/#/games');
  await expect(page.getByText(GAME.homeTeam)).toBeVisible();

  // Somebody else takes it while this window sits in the background.
  takenBySomeoneElse = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));

  // Games held by another coach are not on offer, so the row goes — rather than
  // sitting there with a button that would only have been refused.
  await expect(page.getByText(GAME.homeTeam)).toHaveCount(0, { timeout: 10_000 });
});

test('a refused take says so and repairs the row it was refused on', async ({ page }) => {
  let assignedRc = '';
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, assignedRc }] }));
  await page.route('**/api/games/*/assign-rc', async (r) => {
    // What the server answers when the game is already held: 409, never a
    // silent overwrite of the other coach's claim.
    assignedRc = 'Bea Beispiel';
    await r.fulfill({ status: 409, json: { error: 'Dieses Spiel wurde bereits von einem anderen RC übernommen.' } });
  });

  await page.goto('/#/games');
  await page.getByText(GAME.homeTeam).click();
  await page.getByRole('button', { name: 'Take game' }).click();

  await expect(page.getByText(/bereits von einem anderen RC übernommen/)).toBeVisible();
  // And the affordance that was refused is gone, so the next tap cannot repeat
  // it: the list behind the message has been refetched.
  await expect(page.getByRole('button', { name: 'Take game' })).toHaveCount(0, { timeout: 10_000 });
});

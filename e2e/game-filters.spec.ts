import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// The filter bar is six near-identical white pills, and an active filter used to
// announce itself only through a 20px switch inside one of them. It also offered
// toggles for markings no game in the list carried — controls whose only
// possible effect was to empty the screen.
//
// And an RC game is one a coach is already whistling next to their coachee: not
// a game for a second coach to take, so it does not belong in the open list.

const games = [
  { ...GAME, id: 'plain', matchNo: '1', homeTeam: 'Volley Obfelden', assignedRc: '' },
  { ...GAME, id: 'rcgame', matchNo: '2', homeTeam: 'VBC Voléro Zürich', assignedRc: '', isRcGame: true },
];

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: games }));
  await page.goto('/#/games');
  await page.getByRole('button', { name: /Filter/i }).first().click();
});

test('an RC game stays out of the open list until its filter asks for it', async ({ page }) => {
  await expect(page.getByText('Volley Obfelden')).toBeVisible();
  await expect(page.getByText('VBC Voléro Zürich')).toHaveCount(0);

  await page.getByRole('button', { name: 'RC Game' }).click();
  await expect(page.getByText('VBC Voléro Zürich')).toBeVisible();
  await expect(page.getByText('Volley Obfelden')).toHaveCount(0);
});

test('a filter that is on says so on the button, not just in its switch', async ({ page }) => {
  const rc = page.getByRole('button', { name: 'RC Game' });
  await expect(rc).toHaveAttribute('aria-pressed', 'false');
  await expect(rc).toHaveClass(/border-stone-300/);

  await rc.click();
  await expect(rc).toHaveAttribute('aria-pressed', 'true');
  await expect(rc).toHaveClass(/border-red-500/);
});

test('a toggle with nothing to filter is not offered', async ({ page }) => {
  // No game here carries an RD or LD marking, and no coachee is inactive.
  await expect(page.getByRole('button', { name: 'RD Game' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'LD Game' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show inactive' })).toHaveCount(0);
  // The RC-game toggle is offered, because a game in the list is one.
  await expect(page.getByRole('button', { name: 'RC Game' })).toBeVisible();
});

test('the toggle that is on stays reachable even with nothing left to match', async ({ page }) => {
  // Switched on, then the games change under it: it must remain, or there is no
  // way to switch it off again.
  await page.getByRole('button', { name: 'RC Game' }).click();
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [games[0]] }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: 'RC Game' })).toBeVisible();
});

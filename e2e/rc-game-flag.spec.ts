import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// A game where a referee coach whistles next to one of their coachees is where
// the coaching happens on the court instead of from the stands. Nobody marks
// those anywhere — they fall out of the two rosters — so the API works them out
// and the list says so, either way round: the coach may be the 1. or the 2. SR.

test('a game marked as an RC game is labelled and can be filtered to', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [
      // Unassigned, because the open list only offers games nobody holds.
      { ...GAME, id: 'g-rc', matchNo: '402430', homeTeam: 'VBC Voléro Zürich', assignedRc: '', isRcGame: true },
      { ...GAME, id: 'g-plain', matchNo: '402431', homeTeam: 'Volley Obfelden', assignedRc: '', isRcGame: false },
    ],
  }));

  await page.goto('/#/games');
  await expect(page.getByText('VBC Voléro Zürich')).toBeVisible();
  await expect(page.getByText('Volley Obfelden')).toBeVisible();

  // The label sits on the game that has one, and only on that one.
  await expect(page.getByText('RC Game', { exact: true })).toHaveCount(1);

  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: 'RC Game' }).click();
  await expect(page.getByText('VBC Voléro Zürich')).toBeVisible();
  await expect(page.getByText('Volley Obfelden')).toHaveCount(0);
});

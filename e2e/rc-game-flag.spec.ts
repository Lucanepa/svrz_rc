import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// A game where a referee coach whistles next to one of their coachees is where
// the coaching happens on the court instead of from the stands. Nobody marks
// those anywhere — they fall out of the two rosters — so the API works them out,
// either way round: the coach may be the 1. or the 2. SR.
//
// They are also not games to take, so they stay out of the open list until the
// filter asks for them — and when it does, they are labelled.

test('an RC game is labelled, and only listed when its filter is on', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [
      // Unassigned, because the open list only offers games nobody holds.
      { ...GAME, id: 'g-rc', matchNo: '402430', homeTeam: 'VBC Voléro Zürich', assignedRc: '', isRcGame: true },
      { ...GAME, id: 'g-plain', matchNo: '402431', homeTeam: 'Volley Obfelden', assignedRc: '', isRcGame: false },
    ],
  }));

  await page.goto('/#/games');
  // Out of the way by default: a coach is already on the whistle there.
  await expect(page.getByText('Volley Obfelden')).toBeVisible();
  await expect(page.getByText('VBC Voléro Zürich')).toHaveCount(0);

  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: 'RC Game' }).click();

  await expect(page.getByText('VBC Voléro Zürich')).toBeVisible();
  await expect(page.getByText('Volley Obfelden')).toHaveCount(0);
  // Close the filter panel first: its own toggle is called "RC Game" too, and
  // the point here is the label on the row.
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await expect(page.getByText('RC Game', { exact: true })).toHaveCount(1);
});

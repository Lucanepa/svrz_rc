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

  await page.goto('/games');
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

test('an RC game is not offered: the button is greyed and says why, on every list', async ({ page }) => {
  // 4.4.10: the coach on the whistle files a Rückmeldung; a second coach does
  // not observe the game, so nobody can take it. The button stays — greyed
  // and still clickable — so it can explain itself, like a taken game's.
  await stubSignedInApp(page);
  const assigned: string[] = [];
  await page.route('**/api/games/*/assign-rc', (r) => { assigned.push(r.request().url()); r.fulfill({ json: { ok: true } }); });
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...GAME, id: 'g-rc', matchNo: '402430', assignedRc: '', isRcGame: true }],
  }));

  // Under the coachee's row.
  await page.goto('/coachees');
  await page.getByRole('button', { name: /Show details|Details anzeigen/ }).first().click();
  const take = page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).first();
  await expect(take).toHaveAttribute('aria-disabled', 'true');
  await take.click({ force: true });
  await expect(page.getByText(/RC game: a referee coach is whistling|RC-Spiel: Hier pfeift ein Referee Coach/).first()).toBeVisible();
  expect(assigned).toEqual([]);

  // On the Games tab, with the RC filter on.
  await page.goto('/games');
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: 'RC Game' }).click();
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByText(GAME.homeTeam).first().click();
  const take2 = page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).first();
  await expect(take2).toHaveAttribute('aria-disabled', 'true');
  await take2.click({ force: true });
  expect(assigned).toEqual([]);
});

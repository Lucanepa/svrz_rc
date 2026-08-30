import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// Flagging a game "we want this one observed" lives in the console's Games tab.
//
// It used to live in the coach app behind an admin check; when admin work moved
// to the console the button was dropped and never re-drawn, so for four days the
// only flags anyone could see were the ones VolleyManager set. Nothing failed —
// there was no test to fail. This is that test.

/** VolleyManager's own RD/RSV marking. The server forces `starred` on these. */
const VM_GAME = {
  ...GAME, id: 'g2', matchNo: '999', homeTeam: 'RD Team', awayTeam: 'RSV Team',
  assignedRc: '', starred: true, vmFlagged: true,
};

test('an admin flags a game from the console, and cannot unflag VolleyManager', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [{ ...GAME, starred: false }, VM_GAME] }));
  const calls: string[] = [];
  await page.route('**/api/admin/games/*/star', async (r) => {
    calls.push(`${r.request().url().split('/api')[1]} ${r.request().postData()}`);
    await r.fulfill({ json: { ok: true, starred: true, vmFlagged: false } });
  });

  await page.goto('/#/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
  await expect(page.getByText(/VBC Züri Unterland/)).toBeVisible();

  await page.getByRole('button', { name: /^(Vormerken|Flag)$/ }).click();
  await expect(page.getByRole('button', { name: /^(Vorgemerkt|Flagged)$/ })).toBeVisible();
  expect(calls).toEqual(['/admin/games/g1/star {"starred":true}']);

  // The VM-marked game says where its flag came from, and the button is dead:
  // the marking lives in VM and comes back on the next sync anyway.
  await expect(page.getByRole('button', { name: /Vorgemerkt \(VM\)|Flagged \(VM\)/ })).toBeDisabled();
  expect(calls).toHaveLength(1);
});

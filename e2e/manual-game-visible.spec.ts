import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// A test game exists to be walked through: created in the console, then found
// in the app, observed, filed, mailed. It was filtered out of the games list
// with everything else — /api/eligible-games only lists games with a coachee on
// them, and a throwaway fixture rarely has one — so the only place it could be
// reached from was the console that made it, which is not where the flow it is
// testing lives.

test('a test game is listed even with nobody coachable on it, and says what it is', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [
      // Referees nobody is coaching — exactly the shape a throwaway has.
      { ...GAME, id: 'g-test', matchNo: 'TEST-1', homeTeam: 'VBC Test 1', awayTeam: 'VBC Test 2', firstReferee: 'Niemand Bekannt', secondReferee: '', assignedRc: '', isManual: true },
      { ...GAME, id: 'g-real', matchNo: '402431', homeTeam: 'Volley Obfelden', assignedRc: '' },
    ],
  }));

  await page.goto('/#/games');
  await expect(page.getByText('VBC Test 1')).toBeVisible();
  // Badged, or "Test 1 vs Test 2 on a Tuesday" is obvious only to whoever made it.
  // The suite's stubbed session runs in English, like the RC-game spec.
  await expect(page.getByText('Test game', { exact: true })).toHaveCount(1);
  // The badge belongs to the test game, not to the fixture beside it.
  await expect(page.getByText('Volley Obfelden')).toBeVisible();
});

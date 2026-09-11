import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

// A game VolleyManager marked for observation reaches the Games tab on the
// mark alone — nobody on its whistle needs to be a coachee. The server now
// imports and lists such games (gamesSync.ts, /api/eligible-games); this checks
// the tab does not quietly filter them back out: every coachee-aware rule in
// the list treats "no coachee on the row" as a pass, and the star chip says
// where the flag came from.

const COACHEE_GAME = { ...GAME, id: 'g-coachee', assignedRc: '', starred: false };
const MARKED_NO_COACHEE = {
  ...COACHEE_GAME,
  id: 'g-marked', matchNo: '406282',
  homeTeam: 'VC Tornado Adliswil H1', awayTeam: 'OTA VOLLEY H1',
  firstReferee: 'Christian Wolf', secondReferee: 'Mateja Gligorijevic',
  isRdGame: true, vmFlagged: true, starred: true,
};

const flagPill = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /^(Flagged|Vorgemerkt)$/ });

test('an RD-marked game with no coachee on it is listed, and the Flagged pill finds it', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [COACHEE_GAME, MARKED_NO_COACHEE] }));
  await page.goto('/#/games');

  // On the open list as-is: no coachee-aware filter drops it.
  await expect(page.getByText(MARKED_NO_COACHEE.homeTeam)).toBeVisible();
  await expect(page.getByText(COACHEE_GAME.homeTeam).first()).toBeVisible();

  // And it is what the pill is for.
  await flagPill(page).click();
  await expect(page.getByText(MARKED_NO_COACHEE.homeTeam)).toBeVisible();
  await expect(page.getByText(COACHEE_GAME.homeTeam)).toHaveCount(0);

  // The star says WHY: the RD mark, not an admin's hand.
  await expect(page.getByTitle(/Marked as an RD game in VolleyManager|als RD-Spiel markiert/)).toBeVisible();
});

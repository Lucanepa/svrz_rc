import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME, GAME_MANUAL } from './support/app';

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
      // Referees nobody is coaching — exactly the shape a throwaway has: the
      // server resolves the slot to nobody (firstCoacheeId ''), and the
      // client reads that, not the name.
      { ...GAME, id: 'g-test', matchNo: 'TEST-1', homeTeam: 'VBC Test 1', awayTeam: 'VBC Test 2', firstReferee: 'Niemand Bekannt', firstRefereeId: '', firstCoacheeId: '', secondReferee: '', assignedRc: '', assignedRcId: '', isManual: true },
      { ...GAME, id: 'g-real', matchNo: '402431', homeTeam: 'Volley Obfelden', assignedRc: '', assignedRcId: '' },
    ],
  }));

  await page.goto('/games');
  await expect(page.getByText('VBC Test 1')).toBeVisible();
  // Badged, or "Test 1 vs Test 2 on a Tuesday" is obvious only to whoever made it.
  // The suite's stubbed session runs in English, like the RC-game spec.
  await expect(page.getByText('Test game', { exact: true })).toHaveCount(1);
  // The badge belongs to the test game, not to the fixture beside it.
  await expect(page.getByText('Volley Obfelden')).toBeVisible();
});

test('a test game dated out of season is still shown, an ordinary game is not', async ({ page }) => {
  // A season runs September to April, and a test game is usually made today —
  // which in May, June, July or August is in no season at all. It then vanished
  // from every list in the app while sitting in the console that made it.
  await stubSignedInApp(page);
  // "Made today": the Games list keeps played games behind a button, so the
  // fixture below is today's, not a played one — this spec is about the season.
  await page.clock.setFixedTime(new Date('2026-08-28T12:00:00Z'));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [
      { ...GAME, id: 'g-aug-test', matchNo: 'TEST-2', date: '2026-08-28T18:00:00.000Z', homeTeam: 'VBC August Test', assignedRc: '', assignedRcId: '', isManual: true },
      { ...GAME, id: 'g-aug-real', matchNo: '402432', date: '2026-08-28T18:00:00.000Z', homeTeam: 'VBC August Real', assignedRc: '', assignedRcId: '' },
    ],
  }));

  await page.goto('/games');
  await expect(page.getByText('VBC August Test')).toBeVisible();
  // The season bound still holds for everything else.
  await expect(page.getByText('VBC August Real')).toHaveCount(0);
});

test('a test game keeps its record id in the form URL, and its number still opens it when typed', async ({ page }) => {
  // A fixture's URL is its VolleyManager match number (path-routing.spec.ts).
  // A manual game's number is typed, or generated — and a typed one is the
  // one that can collide with a real fixture's, so a manual game is addressed
  // by its record id whatever its number reads. The number is still a valid
  // address when it names exactly one game on the list: what a coach types
  // off the console's "Angelegt" line.
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME, GAME_MANUAL] }));
  await page.goto('/games');
  // Held games live behind this filter; the row folds its actions away.
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).click();
  await page.getByText(GAME_MANUAL.homeTeam).first().click();
  await page.getByRole('button', { name: /Start observation|Beobachtung starten/ }).click();
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
  await expect(page.locator(`input[value="${GAME_MANUAL.matchNo}"]`).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/form/${GAME_MANUAL.id}/1sr$`));

  await page.goto(`/form/${GAME_MANUAL.matchNo}/1sr`);
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
  await expect(page.locator(`input[value="${GAME_MANUAL.matchNo}"]`).first()).toBeVisible();
  // Canonicalised to the record id (without a Back step of its own —
  // path-routing.spec.ts pins that for the typed shape of any game).
  await expect(page).toHaveURL(new RegExp(`/form/${GAME_MANUAL.id}/1sr$`));
});

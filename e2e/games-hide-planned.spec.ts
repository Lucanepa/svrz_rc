import { test, expect } from '@playwright/test';
import { stubSignedInApp, GAME } from './support/app';

/**
 * Games tab: a coachee whose observation is already booked (GAME, taken by the
 * RC) is taken care of, so by default their other games leave the list too —
 * "Ohne Geplante", a pill beside "Vorgemerkt", on by default and remembered on
 * the device. It no longer rides on "Beobachtung nötig": switching that off
 * must not bring the booked coachee's games back on its own.
 */

const OPEN = { ...GAME, id: 'g-open', matchNo: '2345679', homeTeam: 'VBC Offen', awayTeam: 'Gast Offen', date: '2026-11-22T19:30:00Z', assignedRc: '', assignedRcId: '' };

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.clock.setFixedTime(new Date('2026-11-10T10:00:00Z'));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME, OPEN] }));
});

test('games of a coachee with a booked observation are hidden by default, and one tap shows them', async ({ page }) => {
  await page.goto('/games');
  const pill = page.getByRole('button', { name: /^(Ohne Geplante|Hide planned)$/ });
  await expect(pill).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(OPEN.homeTeam)).toHaveCount(0);

  await pill.click();
  await expect(page.getByText(OPEN.homeTeam)).toBeVisible();

  await page.reload();
  await expect(page.getByText(OPEN.homeTeam)).toBeVisible();
});

test('switching off "Beobachtung nötig" does not bring them back on its own', async ({ page }) => {
  await page.goto('/games');
  await page.getByRole('button', { name: /^(Filters|Filter)$/ }).first().click();
  await page.getByRole('button', { name: /Beobachtung nötig|Needs observation/ }).click();
  await expect(page.getByText(OPEN.homeTeam)).toHaveCount(0);
});

test('the list/calendar switch sits on the date row, and there is no "Gestern" chip', async ({ page }) => {
  await page.goto('/games');
  await expect(page.getByRole('button', { name: /^(Gestern|Yesterday)$/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^(Kalender|Calendar)$/ }).click();
  await expect(page.getByRole('button', { name: /^(Kalender|Calendar)$/ })).toHaveAttribute('aria-pressed', 'true');
});

/**
 * "Ohne Geplante" hides only what cannot be taken (asked 2026-10-14): games on
 * or after the coachee's booking, flagged ones included — a flag does not make
 * them takeable. An EARLIER game stays: there the coach asks for the earlier
 * observation, or — when the booking is their own — is told to give it back.
 */
test('a flagged later game is hidden, an earlier game stays and says why it is greyed', async ({ page }) => {
  const LATER_FLAGGED = { ...OPEN, id: 'g-late', matchNo: '2345680', homeTeam: 'VBC Später', starred: true };
  const EARLIER = { ...OPEN, id: 'g-early', matchNo: '2345681', homeTeam: 'VBC Früher', date: '2026-11-12T19:30:00Z' };
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME, LATER_FLAGGED, EARLIER] }));
  await page.goto('/games');
  await expect(page.getByRole('button', { name: /^(Ohne Geplante|Hide planned)$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText(LATER_FLAGGED.homeTeam)).toHaveCount(0);
  await expect(page.getByText(EARLIER.homeTeam)).toBeVisible();

  // The booking is the coach's own: no switch to ask, so the greyed button
  // says to give the later game back.
  await page.getByRole('button', { name: new RegExp(EARLIER.matchNo) }).first().click();
  await expect(page.getByTestId('take-booked')).toHaveAttribute('title', /give that one back|Gib jenes Spiel ab/);
});

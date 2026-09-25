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

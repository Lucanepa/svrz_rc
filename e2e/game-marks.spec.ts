import { test, expect } from '@playwright/test';
import { stubSignedInApp, BOERSE_RED, GAME_LD, GAME_MANUAL, GAME_RC, GAME_VM, RC } from './support/app';

/**
 * The marks — what a game IS — on the three surfaces no other spec pins them
 * on: the /calendar list (reachable by URL, fed by /api/games/calendar-status,
 * which carried a status dot and nothing else), the header of the open
 * feedback form (a Testspiel walk-through was indistinguishable from a real
 * observation up there), and the Games tab's month grid (a dot per game,
 * which can carry the marks in its title and the Börse level in a ring).
 *
 * Every other list has its own spec: home-planned-games, home-done-open,
 * rc-game-note, coachee-row-games, admin-overview-detail, admin-games-groups
 * and manual-game-picker each pin the chips on their own rows.
 */

test('the calendar list draws the same row as every other list, marks and all', async ({ page }) => {
  await stubSignedInApp(page);
  const status = (over: Record<string, unknown>) => ({ hasOutstanding: false, hasCompleted: false, status: 'none', ...over });
  await page.route('**/api/games/calendar-status*', (r) => r.fulfill({ json: [
    status({ ...GAME_RC, status: 'outstanding', hasOutstanding: true }),
    status({ ...GAME_LD, boerse: BOERSE_RED, maps_url: 'https://maps.example/utogrund', feedbackClosedRoles: ['1. SR'] }),
    status({ ...GAME_MANUAL, assignedRc: '', assignedRcId: '' }),
    status({ ...GAME_VM }),
  ] }));
  await page.goto('/calendar');
  await expect(page.getByText(GAME_RC.homeTeam)).toBeVisible();

  await expect(page.getByText(/^(RC Game|RC-Spiel)$/)).toHaveCount(1);
  await expect(page.getByText(/^(LD Game|LD Spiel)$/)).toHaveCount(1);
  await expect(page.getByText(/^(Test game|Testspiel)$/)).toHaveCount(1);
  const star = page.getByText(/^(Priority|Gewünscht)$/);
  await expect(star).toHaveCount(1);
  await expect(star).toHaveAttribute('title', /RD/);
  // The crew with its marks: the coachee (with the Niveau, off the roster),
  // the coach on the other whistle of the RC-Spiel unmarked, the Börse word
  // and its line, the role already filed for.
  await expect(page.getByText(`2SR ${RC.name}`)).toBeVisible();
  await expect(page.getByText('Coachee · N3-2').first()).toBeVisible();
  await expect(page.getByText('In Börse')).toHaveCount(1);
  await expect(page.getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();
  await expect(page.getByText(/^(observed|beobachtet)$/)).toHaveCount(1);
  // The holder, and the hall as the precise link — on the LD game's row (the
  // rows here open nothing, so they are not buttons; the row is the chip's
  // nearest GameRow).
  await expect(page.getByText(RC.name, { exact: true }).first()).toBeVisible();
  const ldRow = page.getByText(/^(LD Game|LD Spiel)$/).locator('xpath=ancestor::div[contains(@class, "py-0.5")][1]');
  await expect(ldRow.getByRole('link', { name: 'Sporthalle Utogrund' })).toHaveAttribute('href', 'https://maps.example/utogrund');
});

test('the open form says what the game is, and marks a slot in the Börse', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...GAME_MANUAL, secondReferee: 'Sven Fremd', secondRefereeId: '', secondCoacheeId: '', boerse: { ...BOERSE_RED, markedSlots: ['2'], level: 'none', reason: 'not-my-concern' } }],
  }));
  await page.goto(`/form/${GAME_MANUAL.id}/1sr`);
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
  // The Testspiel chip in the header — the one place a throwaway walk-through
  // has to be visibly a test.
  await expect(page.getByText(/^(Test game|Testspiel)$/).first()).toBeVisible();
  // The other referee's slot is in the Börse: the word beside the name.
  await expect(page.getByText('In Börse').first()).toBeVisible();
  // The coachee mark carries the Niveau, as on the lists.
  await expect(page.getByText('Coachee · N3-2').first()).toBeVisible();
});

test('the month grid names the marks in each dot\'s title and rings a Börse level', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [
      GAME_LD,
      { ...GAME_VM, boerse: BOERSE_RED },
    ],
  }));
  // The list hides taken games by default; the grid draws whatever the list
  // would, so the held games come out from behind their filter first.
  await page.goto('/games?view=calendar&month=2026-11');
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: /RC assigned|RC zugewiesen/ }).first().click();
  await page.getByRole('button', { name: /Filter/i }).first().click();

  const dots = page.locator('span[title*="VBC"]');
  await expect(dots).toHaveCount(2);
  await expect(page.locator(`span[title*="${GAME_LD.homeTeam}"]`)).toHaveAttribute('title', /LD game|LD Spiel/);
  const flagged = page.locator(`span[title*="${GAME_VM.homeTeam}"]`);
  await expect(flagged).toHaveAttribute('title', /Priority|Gewünscht/);
  await expect(flagged).toHaveAttribute('title', /In Börse/);
  await expect(flagged).toHaveClass(/ring-red-400/);
});

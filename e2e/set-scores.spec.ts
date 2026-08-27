import { test, expect, type Page } from '@playwright/test';
import { openFeedbackForm, stubSignedInApp } from './support/app';

// The set scores are the input; the match score is derived from them. So the
// sets are where a wrong number has to be caught — and 12:23 is not a set
// anybody played: a set runs to 25, and past 24-all until someone leads by two.
//
// What the field said instead was "A 1:1 result is not possible: the winner
// needs 3 sets" — true of every score before the third set is won, so it was on
// screen for the whole of a normal entry and said nothing about the set that
// was actually wrong.

const setBox = (page: Page, set: number, side: 'home' | 'away') =>
  page.getByLabel(new RegExp(`(Set|Satz) ${set} (${side}|${side === 'home' ? 'Heim' : 'Gast'})`));

async function typeSet(page: Page, set: number, home: string, away: string) {
  await setBox(page, set, 'home').fill(home);
  await setBox(page, set, 'away').fill(away);
}

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);
});

test('a set the winner did not win to 25 is refused, on that set', async ({ page }) => {
  await typeSet(page, 1, '25', '12');
  await typeSet(page, 2, '12', '23');

  await expect(page.getByText(/Set 2 \(12:23\): the winner needs at least 25 points/)).toBeVisible();
  // The offending set is marked, so nobody has to count boxes.
  await expect(setBox(page, 2, 'home')).toHaveClass(/border-red-500/);
  await expect(setBox(page, 1, 'home')).not.toHaveClass(/border-red-500/);
});

test('a set stopped one point short of a two-point lead is refused', async ({ page }) => {
  await typeSet(page, 1, '26', '25');
  await expect(page.getByText(/Set 1 \(26:25\): a two-point lead is required/)).toBeVisible();
});

test('past 25 the set ends at exactly two', async ({ page }) => {
  await typeSet(page, 1, '28', '20');
  await expect(page.getByText(/Set 1 \(28:20\): past 25 the set ends at a two-point lead/)).toBeVisible();
});

test('a match halfway through is not an error', async ({ page }) => {
  await typeSet(page, 1, '25', '12');
  await typeSet(page, 2, '23', '25');

  // 1:1 is what every five-set match looks like after two sets.
  await expect(page.getByText(/is not possible/)).toHaveCount(0);
  await expect(page.getByText(/the winner needs at least/)).toHaveCount(0);
});

test('a third set played to 15 is a best-of-three decider, not a mistake', async ({ page }) => {
  await typeSet(page, 1, '25', '20');
  await typeSet(page, 2, '18', '25');
  await typeSet(page, 3, '15', '13');

  await expect(page.getByText(/the winner needs at least/)).toHaveCount(0);
  await expect(page.getByText(/is not possible/)).toHaveCount(0);
});

test('the two teams stand where their own numbers do', async ({ page }) => {
  // The boxes said nothing about which side was which: the pairing is on the
  // TEAMS row above, but which column belongs to whom was left to the reader,
  // and the result row was three quarters empty.
  const cell = page.locator('label', { hasText: /^(RESULT|ERGEBNIS)$/i }).locator('xpath=..');
  await expect(cell).toContainText('VBC Züri Unterland');
  await expect(cell).toContainText('Volley Näfels II');
  // Home to the left of the colon, away to the right.
  await expect(cell).toHaveText(/VBC Züri Unterland[^]*Volley Näfels II/);
});

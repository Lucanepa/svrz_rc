import { test, expect, type Page } from '@playwright/test';
import { validateResult } from '../src/lib/matchResult';
import { openFeedbackForm, stubSignedInApp } from './support/app';

/**
 * Only the final result is required (Luca, 2026-10-09). A coach who knows the
 * match went 3:0 but did not write down the set points can still send the
 * report; set points that ARE entered still have to add up.
 */

test.describe('the rule', () => {
  test('a final result alone is complete', () => {
    for (const r of ['3:0', '3:1', '2:3', '2:0', '1:2']) expect(validateResult(r, 'EN')).toBeNull();
  });

  test('an impossible final result is still refused', () => {
    expect(validateResult('3:3', 'EN')).toMatch(/3:3 result is not possible/);
    expect(validateResult('1:0', 'EN')).toMatch(/1:0 result is not possible/);
  });

  test('no result at all is still refused, and says what to type', () => {
    expect(validateResult('', 'DE')).toBe('Bitte das Endergebnis eintragen (z. B. 3:0).');
  });

  test('set points that are given still have to add up', () => {
    expect(validateResult('3:0 | 25:15, 25:21, 25:14', 'EN')).toBeNull();
    expect(validateResult('3:0 | 25:15, 21:25, 25:14', 'EN')).toMatch(/add up to 2:1/);
  });

  test('sets that stop short say how to get out of it', () => {
    expect(validateResult('1:0 | 25:15', 'EN')).toMatch(/only add up to 1:0.*clear them and enter just the final result/);
  });
});

const scoreBox = (page: Page, side: 'home' | 'away') =>
  page.getByLabel(side === 'home' ? /^(Home sets|Sätze Heim)$/ : /^(Away sets|Sätze Gast)$/);
const setBox = (page: Page, set: number, side: 'home' | 'away') =>
  page.getByLabel(new RegExp(`(Set|Satz) ${set} (${side}|${side === 'home' ? 'Heim' : 'Gast'})`));

test.describe('the form', () => {
  test.beforeEach(async ({ page }) => {
    await stubSignedInApp(page);
    await page.goto('/');
    await openFeedbackForm(page);
  });

  test('the final result can be typed with no set points', async ({ page }) => {
    await scoreBox(page, 'home').fill('3');
    await scoreBox(page, 'away').fill('0');

    await expect(scoreBox(page, 'home')).toHaveValue('3');
    await expect(scoreBox(page, 'away')).toHaveValue('0');
    await expect(page.getByText(/is not possible|ist nicht möglich/)).toHaveCount(0);
    await expect(page.getByText(/optional|freiwillig/)).toBeVisible();
  });

  test('a typed result that no match produces is flagged', async ({ page }) => {
    await scoreBox(page, 'home').fill('3');
    await scoreBox(page, 'away').fill('3');
    await expect(page.getByText(/3:3 (result is not possible|ist nicht möglich)/)).toBeVisible();
  });

  test('once a set is filled in, the score is counted from the sets', async ({ page }) => {
    await scoreBox(page, 'home').fill('3');
    await scoreBox(page, 'away').fill('0');
    await setBox(page, 1, 'home').fill('25');
    await setBox(page, 1, 'away').fill('20');

    // No longer a box to type in: the sets decide it, so the two cannot disagree.
    const home = page.locator('output[aria-label="Home sets"], output[aria-label="Sätze Heim"]');
    await expect(home).toHaveText('1');

    // Clearing the set hands the score back to the boxes — empty, since the
    // counted 1:0 was never something the coach typed.
    await setBox(page, 1, 'home').fill('');
    await setBox(page, 1, 'away').fill('');
    await expect(scoreBox(page, 'home')).toHaveValue('');
  });
});

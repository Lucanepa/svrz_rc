import { test, expect } from '@playwright/test';
import { stubSignedInApp, COACHEE_LISTED } from './support/app';

/**
 * Coachees tab: a coachee whose next observation is already booked is taken
 * care of, so by default the list leaves them out ("Ohne Geplante",
 * on). One tap shows them again, and the choice is remembered on the device.
 * The shared fixture's coachee has a booked game, which is why every other
 * spec starts with the switch off (support/app.ts).
 */

async function openCoachees(page: import('@playwright/test').Page) {
  await stubSignedInApp(page, { keepHidePlannedDefault: true });
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
}

test('coachees with a booked observation are hidden by default, and one tap shows them', async ({ page }) => {
  await openCoachees(page);
  await expect(page.getByText(COACHEE_LISTED)).toHaveCount(0);

  // A pill above the list, beside "Vorgemerkt" — not inside the filter panel.
  const toggle = page.getByRole('button', { name: /Ohne Geplante|Hide planned/ });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.getByText(COACHEE_LISTED).first()).toBeVisible();

  // Remembered: after a reload the list still shows them.
  await page.reload();
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page.getByText(COACHEE_LISTED).first()).toBeVisible();
});

test('the booked game is named without its teams', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  const row = page.getByText(COACHEE_LISTED).first().locator('xpath=ancestor::div[contains(@class,"cursor-pointer")][1]');
  const line = row.locator('.text-sky-700').first();
  await expect(line).toBeVisible();
  await expect(line).not.toContainText(' vs ');
});

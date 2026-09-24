import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

/**
 * The (i) beside a form label opens a panel anchored at its left edge. Near
 * the right edge of a phone that panel used to open off the screen; it is now
 * pulled back inside.
 */

test('a (i) at the right edge opens its panel on the screen, on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);

  const cell = page.getByRole('heading', { name: /^(Referee Goal|SR-Ziel)$/ }).locator('xpath=..');
  await cell.getByRole('button', { name: /Show explanation|Erklärung anzeigen/ }).click();
  const panel = page.getByRole('dialog', { name: /Show explanation|Erklärung anzeigen/ });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test('the grading-scale (i) under the header opens on the screen too', async ({ page }) => {
  // The one in the report: at the end of the A–E legend line, far right.
  await page.setViewportSize({ width: 390, height: 844 });
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);

  const legend = page.getByText(/A: (Exemplary|Beispielhaft)/i).first().locator('xpath=..');
  await legend.getByRole('button', { name: /Show explanation|Erklärung anzeigen/ }).click();
  const panel = page.getByRole('dialog', { name: /Show explanation|Erklärung anzeigen/ });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

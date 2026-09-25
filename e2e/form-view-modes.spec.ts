import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

/**
 * How the sheet is shown while it is filled in.
 *
 * The form is a page-wide document being typed into on a laptop, and it was
 * pinned to a reading column with the rest of the screen left empty. It now
 * always spans the window; beside the language sits the browser's own
 * fullscreen. Neither belongs to the report — nothing here
 * may change what is filed.
 */

/** The width of the sheet itself, as the browser lays it out. */
async function sheetWidth(page: Page) {
  const box = await page.locator('.shadow-xl').first().boundingBox();
  return box!.width;
}

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);
});

test('the sheet uses the whole window, with no width toggle to find', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('form-widen')).toHaveCount(0);
  // The root pads 16px each side; the sheet takes everything in between.
  expect(await sheetWidth(page)).toBeGreaterThan(1440 - 64);
});

test('fullscreen is the browser\'s own, and the button says which state it is in', async ({ page }) => {
  const button = page.getByTestId('form-fullscreen');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);

  // Left from outside the app — Esc, or the browser's own control — and the
  // button must not go on claiming a state the browser is not in.
  await page.evaluate(() => document.exitFullscreen());
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

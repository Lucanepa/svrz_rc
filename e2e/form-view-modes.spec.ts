import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

/**
 * How the sheet is shown while it is filled in.
 *
 * The form is a page-wide document being typed into on a laptop, and it was
 * pinned to a reading column with the rest of the screen left empty. Two
 * toggles beside the language: the browser's own fullscreen, and a full-width
 * column the device remembers. Neither belongs to the report — nothing here
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

test('the form can be widened to the whole window, and the device remembers it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const narrow = await sheetWidth(page);

  await page.getByTestId('form-widen').click();
  await expect(page.getByTestId('form-widen')).toHaveAttribute('aria-pressed', 'true');
  expect(await sheetWidth(page)).toBeGreaterThan(narrow);

  // Remembered, so a coach sets it once and not on every observation. The
  // reload lands straight back on the form — it is its own address.
  await page.reload();
  await expect(page.getByTestId('form-widen')).toHaveAttribute('aria-pressed', 'true');
  expect(await sheetWidth(page)).toBeGreaterThan(narrow);

  await page.getByTestId('form-widen').click();
  await expect(page.getByTestId('form-widen')).toHaveAttribute('aria-pressed', 'false');
  expect(await sheetWidth(page)).toBe(narrow);
});

test('the width is a view mode, not a phone layout: no widen button where the sheet already fills the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('form-widen')).toBeHidden();
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

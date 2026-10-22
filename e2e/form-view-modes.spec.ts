import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

/**
 * How the sheet is shown while it is filled in.
 *
 * The form was pinned to a paperback-wide column (until 2026-09-22), then
 * spanned the whole window — where a criteria row ran 2000 px from its text to
 * its grade. Since 2026-10-22 it is a sheet of A4 on a laptop, centred, and a
 * phone keeps the whole width it always had. Beside the language sits the
 * browser's own fullscreen. Neither belongs to the report — nothing here may
 * change what is filed.
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

test('on a laptop the sheet is A4 wide, with no width toggle to find', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('form-widen')).toHaveCount(0);
  // 210 mm at the CSS 96 dpi.
  expect(Math.abs(await sheetWidth(page) - 793.7)).toBeLessThan(2);
  // The send button lines up with the sheet, not with the window.
  const sheet = (await page.locator('.shadow-xl').first().boundingBox())!;
  const send = (await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).boundingBox())!;
  expect(Math.abs(send.x + send.width - (sheet.x + sheet.width))).toBeLessThan(2);
});

test('a phone keeps the whole width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The root pads 16px each side; the sheet takes everything in between.
  expect(await sheetWidth(page)).toBeGreaterThan(390 - 40);
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

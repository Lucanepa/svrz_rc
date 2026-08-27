import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';

// The remarks a coach writes carry bold, italic, underline, strikethrough and
// colour now. Three renderers have to agree on the same string — the editor, the
// PDF and the e-mail — so what is stored is a restricted subset, and anything
// outside it is text. That last part is the one that matters: these remarks end
// up inside an e-mail somebody else opens.

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);
});

test('formatting survives the editor as the stored subset', async ({ page }) => {
  // The toolbar lives in the full-screen editor; inline, the browser's own
  // Ctrl+B/I/U still apply, since it is the same contenteditable.
  await page.getByRole('button', { name: /Edit larger|Grösser bearbeiten/ }).first().click();
  const surface = page.getByRole('dialog').locator('.rich-surface');
  await surface.click();
  await page.keyboard.type('gut');
  await surface.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  await page.getByRole('button', { name: /^(Bold|Fett)$/ }).first().click();
  await expect(surface.locator('b')).toHaveText('gut');
});

test('a pasted script tag is text, not markup', async ({ page }) => {
  const surface = page.locator('.rich-surface').first();
  await surface.click();
  // Paste is intercepted and inserted as plain text, so the tag never becomes an
  // element in the first place.
  await surface.evaluate((el) => {
    const data = new DataTransfer();
    data.setData('text/plain', '<script>alert(1)</script>');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(surface.locator('script')).toHaveCount(0);
  await expect(surface).toContainText('<script>');
});

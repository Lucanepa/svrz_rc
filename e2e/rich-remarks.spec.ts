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

// Written first, listed afterwards: lines selected and "Bullet" tapped become
// bullets, and a second tap takes the bullets off again. Until 31.10.2026 the
// button only ever added a new bullet at the end, whatever was selected.
test('selected lines become bullets, and a second tap takes them off', async ({ page }) => {
  await page.getByRole('button', { name: /Edit larger|Grösser bearbeiten/ }).first().click();
  const surface = page.getByRole('dialog').locator('.rich-surface');
  await surface.click();
  await page.keyboard.type('Ruhige Präsenz');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Netzkontrolle besprochen');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Schreiber instruiert');
  await expect(surface).toHaveText(/^Ruhige Präsenz\s*Netzkontrolle besprochen\s*Schreiber instruiert$/);
  // From the middle of the second line to the middle of the third.
  const selectFromTo = (a: string, b: string) => surface.evaluate((el, [a, b]) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n as Text);
    const find = (word: string) => { const n = nodes.find((t) => t.data.includes(word))!; return [n, n.data.indexOf(word) + 2] as const; };
    const [sn, so] = find(a);
    const [en, eo] = find(b);
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(en, eo);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  }, [a, b]);
  const bullet = page.getByRole('dialog').getByRole('button', { name: /^• (Aufzählung|Bullet)$/ });
  await selectFromTo('Netzkontrolle', 'Schreiber');
  await bullet.click();
  await expect(surface).toHaveText(/^Ruhige Präsenz\s*• Netzkontrolle besprochen\s*• Schreiber instruiert$/);
  // The same lines are still selected: a second tap takes the bullets off.
  await bullet.click();
  await expect(surface).toHaveText(/^Ruhige Präsenz\s*Netzkontrolle besprochen\s*Schreiber instruiert$/);
  // Two lines, one of them already a bullet: the other joins it, nothing doubles.
  await selectFromTo('Netzkontrolle', 'Schreiber');
  await bullet.click();
  await selectFromTo('Ruhige', 'Netzkontrolle');
  await bullet.click();
  await expect(surface).toHaveText(/^• Ruhige Präsenz\s*• Netzkontrolle besprochen\s*• Schreiber instruiert$/);
  // With nothing selected the button still adds a new bullet at the end.
  await surface.press('Control+End');
  await bullet.click();
  await expect(surface).toHaveText(/• Schreiber instruiert\s*•\s?$/);
});

import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * The court under the handwriting turns across the page (29.10.2026: "can we
 * also rotate to landscape"). The background stays 'court' — what the server
 * and every older build know — and the turn rides in the page's `extra` bag
 * as `court: 'h'`, so an older app shows the same page with the court upright.
 */

const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });

function storedPages(page: Page): Promise<{ bg: string; extra?: Record<string, unknown>; deleted: boolean }[]> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('svrz-notebook', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = open.result.transaction('pages', 'readonly').objectStore('pages').getAll();
      req.onsuccess = () => resolve(req.result);
    };
  }));
}

test('the court turns across the page and back, kept with the page', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
  await sheet(page).getByTestId('pad-new-page').click();
  await sheet(page).getByTestId('pad-side-ink').click();
  // A page is made by its first stroke (until then it is not saved anywhere).
  const box = (await sheet(page).getByTestId('ink-page').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.15, { steps: 10 });
  await page.mouse.up();
  const rotate = sheet(page).getByTestId('pad-court-rotate');
  // Only with a court to turn.
  await expect(rotate).toHaveCount(0);
  await sheet(page).getByRole('button', { name: /^(Spielfeld|Court)$/ }).click();
  await expect(rotate).toHaveAttribute('aria-pressed', 'false');
  await rotate.click();
  await expect(rotate).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await storedPages(page)).filter((p) => !p.deleted).map((p) => [p.bg, p.extra?.court ?? null]))
    .toEqual([['court', 'h']]);
  // Still across after a reload.
  await page.reload();
  await page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ }).click();
  await expect(sheet(page).getByTestId('pad-court-rotate')).toHaveAttribute('aria-pressed', 'true');
  await sheet(page).getByTestId('pad-court-rotate').click();
  await expect.poll(async () => (await storedPages(page)).filter((p) => !p.deleted).map((p) => [p.bg, p.extra?.court ?? null]))
    .toEqual([['court', null]]);
});

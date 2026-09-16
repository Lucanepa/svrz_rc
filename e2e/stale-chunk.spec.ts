import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm } from './support/app';
import {
  decideStaleChunkReload, isStaleChunkError, readLastReload, STALE_CHUNK_FORGET_MS, STALE_CHUNK_STATE_KEY,
} from '../src/lib/freshImport';

// After a deploy the old page's chunk URLs are gone. A lazy import that fails
// for that reason reloads the page once — never mid-form, never twice in a
// row — and when it may not reload, it says so instead of crashing the app.

test('the rule: reload once, not mid-form, not twice in a row', () => {
  const now = 1_000_000;
  expect(decideStaleChunkReload({ lastReloadAt: null, now, formDirty: false })).toBe('reload');
  expect(decideStaleChunkReload({ lastReloadAt: null, now, formDirty: true })).toBe('form-dirty');
  // A reload a moment ago did not help: the NEW build is missing the chunk.
  expect(decideStaleChunkReload({ lastReloadAt: now - 5_000, now, formDirty: false })).toBe('already-reloaded');
  // Even a dirty form does not hide that fact.
  expect(decideStaleChunkReload({ lastReloadAt: now - 5_000, now, formDirty: true })).toBe('already-reloaded');
  // Long enough ago is a different deploy.
  expect(decideStaleChunkReload({ lastReloadAt: now - STALE_CHUNK_FORGET_MS - 1, now, formDirty: false })).toBe('reload');
  expect(readLastReload(null)).toBeNull();
  expect(readLastReload('abc')).toBeNull();
  expect(readLastReload('123')).toBe(123);
});

test('only the missing-chunk failure counts as a stale build', () => {
  expect(isStaleChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/PdfReader-Clh0hgE_.js'))).toBe(true);
  expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
  expect(isStaleChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
  expect(isStaleChunkError(new SyntaxError('Unexpected token'))).toBe(false);
  expect(isStaleChunkError(new Error('Network request failed'))).toBe(false);
});

// The reader's chunk, refused as the edge refuses a chunk of a build that is
// gone. In dev the import is a request for the source file itself.
const refuseReader = (page: import('@playwright/test').Page) =>
  page.route(/\/src\/components\/PdfReader\.tsx/, (r) => r.fulfill({ status: 404, body: 'not found' }));

test('a gone chunk reloads the page once; a second miss shows the notice instead of crashing', async ({ page }) => {
  await stubSignedInApp(page);
  await refuseReader(page);
  await page.goto('/coachees');
  // No reload yet in this tab.
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STALE_CHUNK_STATE_KEY)).toBeNull();

  await page.getByRole('button', { name: /Leitfaden SR-Technik|Refereeing technique guide/ }).click();
  // The page went away and came back — the reload stamped itself first. Read
  // through the navigation: an evaluate mid-reload throws, which is "not yet".
  await expect.poll(() => page.evaluate((k) => sessionStorage.getItem(k), STALE_CHUNK_STATE_KEY).catch(() => null)).not.toBeNull();
  const doc = page.getByRole('button', { name: /Leitfaden SR-Technik|Refereeing technique guide/ });
  await expect(doc).toBeVisible();
  await expect(page.getByText(/Da ist etwas schiefgelaufen/)).toHaveCount(0);

  // Still the same missing chunk after the reload: no second reload, a notice.
  await doc.click();
  const notice = page.getByTestId('stale-build');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('App-Update nötig');
  await expect(page.getByText(/Da ist etwas schiefgelaufen/)).toHaveCount(0);
  // The way out, and the way back.
  await expect(notice.getByRole('button', { name: 'Neu laden' })).toBeVisible();
  await notice.getByRole('button', { name: 'Schliessen' }).click();
  await expect(notice).toHaveCount(0);
});

test('mid-form there is no reload: the notice says the entries are kept', async ({ page }) => {
  await stubSignedInApp(page);
  await refuseReader(page);
  await page.goto('/');
  await openFeedbackForm(page);
  // Something typed: the form is dirty, and a reload would be a loss.
  await page.locator('.rich-surface').first().click();
  await page.keyboard.type('halb fertig');
  // The reader the form can open: the eye on a document in "Dokumente beilegen".
  await page.getByRole('button', { name: /Dokumente auswählen|Choose documents/ }).click();
  await page.getByRole('button', { name: /ansehen|^View / }).first().click();

  const notice = page.getByTestId('stale-build');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/deine Eingaben bleiben erhalten/);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), STALE_CHUNK_STATE_KEY)).toBeNull();
  await expect(page.getByText(/Da ist etwas schiefgelaufen/)).toHaveCount(0);
});

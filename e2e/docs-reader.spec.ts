import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The documents card used to be a column of links: every one of them left the
// app for a browser tab, and the two rulebooks left it for a 7 MB download that
// a phone then had to find a viewer for. They open in the app's own reader now,
// which is only worth having if it can be searched — that is the whole reason a
// coach opens a rulebook mid-match.

const PDF = readFileSync(fileURLToPath(new URL('../public/docs/Leitfaden-SR-Technik.pdf', import.meta.url)));

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  // What the API proxy serves for the documents volleyball.ch and fivb.com
  // publish without CORS. The bytes are a document we ship, so the assertions
  // below can name words that are really in it.
  await page.route(/\/api\/docs\//, (r) => r.fulfill({ contentType: 'application/pdf', body: PDF }));
});

test('a document opens in the app instead of a browser tab', async ({ page }) => {
  await page.goto('/#/coachees');
  await page.getByRole('button', { name: /Leitfaden SR-Technik|Refereeing technique guide/ }).click();

  const reader = page.getByRole('dialog', { name: /Leitfaden SR-Technik|Refereeing technique guide/ });
  await expect(reader).toBeVisible();
  await expect(reader.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  // Still the app underneath, not a navigation.
  expect(page.url()).toContain('#/coachees');
});

test('the rulebook comes through the API proxy, because volleyball.ch sends no CORS header', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/docs/')) asked.push(r.url()); });

  await page.goto('/#/coachees');
  await page.getByRole('button', { name: /Offizielle Volleyball-Regeln|Official volleyball rules/ }).click();

  await expect(page.getByRole('dialog').locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  expect(asked.some((url) => url.endsWith('/api/docs/rules-de'))).toBe(true);
});

test('searching the document finds the word and jumps to it', async ({ page }) => {
  await page.goto('/#/coachees');
  await page.getByRole('button', { name: /Leitfaden SR-Technik|Refereeing technique guide/ }).click();
  const reader = page.getByRole('dialog');
  await expect(reader.locator('canvas').first()).toBeVisible({ timeout: 20_000 });

  // Lower case, against a word the document capitalises: the search folds case
  // and accents on both sides, the way every other lookup in this app does.
  await reader.getByPlaceholder(/Im Dokument suchen|Search this document/).fill('halle');
  await expect(reader.getByText(/^\d+\/\d+$/)).toBeVisible({ timeout: 20_000 });
  await expect(reader.getByRole('button', { name: /(S\.|p\.) \d+/ }).first()).toBeVisible();
});

test('Escape gives the page back', async ({ page }) => {
  await page.goto('/#/coachees');
  await page.getByRole('button', { name: /Leitfaden SR-Technik|Refereeing technique guide/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a document is downloaded once, however often it is opened', async ({ page }) => {
  // What makes the reader usable in a gym: the bytes land in Cache Storage on
  // the first read and are never asked for again. (The service worker keeps
  // pdf.js itself; that part only exists in a built app, not under the dev
  // server this suite runs against.)
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('Leitfaden-SR-Technik.pdf')) asked.push(r.url()); });

  await page.goto('/#/coachees');
  const open = () => page.getByRole('button', { name: /Leitfaden SR-Technik|Refereeing technique guide/ }).click();

  await open();
  await expect(page.getByRole('dialog').locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  // Whatever the idle prefetch did before the click is not the point — what
  // follows the first read is.
  const beforeSecondRead = asked.length;

  await open();
  await expect(page.getByRole('dialog').locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  expect(asked).toHaveLength(beforeSecondRead);
});

// September 2026: the RSK chair offered the sheets svrz.ch lists for referees,
// the federation's regulations and the commission's addresses for the app.
// The PDFs join the proxied set (svrz.ch sends no CORS header either); the
// addresses are cards of their own that hand over to the mail app.

test('an SVRZ regulation reads in the app, through the proxy', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/docs/')) asked.push(r.url()); });

  await page.goto('/#/coachees');
  await page.getByRole('button', { name: /Reglement der Unparteiischen|Regulation for officials/ }).click();

  await expect(page.getByRole('dialog').locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  expect(asked.some((url) => url.endsWith('/api/docs/unparteiische'))).toBe(true);
  expect(page.url()).toContain('#/coachees');
});

test('a contact is a mailto link that stays in this tab', async ({ page }) => {
  await page.goto('/#/coachees');
  const card = page.getByRole('link', { name: /Vorsitz RSK|RSK chair/ });
  await expect(card).toBeVisible();
  // The address, as written — not the app's base prefixed to it, and not in
  // small caps: it is there to be read out to a coachee.
  await expect(card).toHaveAttribute('href', 'mailto:rsk@svrz.ch');
  await expect(card).not.toHaveAttribute('target', '_blank');
  await expect(card).toContainText('rsk@svrz.ch');
});

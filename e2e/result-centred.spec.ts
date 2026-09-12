import { test, expect, type Page } from '@playwright/test';
import { openFeedbackForm, stubSignedInApp } from './support/app';

/**
 * The RESULT cell of the feedback form: the match score above, the set scores
 * below, both meant to sit on the middle of a cell that spans all four columns.
 *
 * The row was `justify-center`, which centres the ROW — not the same thing. The
 * row is `home name · score : score · away name`, and the two names are rarely
 * the same length ("VBC Rämi D1" against "VBC Freies Gymnasium ZH"), so the
 * longer one pushed the colon off to one side. The colon is what the eye reads
 * as the centre, and the sets underneath ARE centred on the cell, so the two
 * rows visibly disagreed about where the middle was.
 *
 * Geometry, because that is the whole of the bug: nothing about the classes
 * looked wrong.
 */

const centreOf = async (page: Page, sel: ReturnType<Page['locator']>) => {
  const box = await sel.boundingBox();
  return box!.x + box!.width / 2;
};

/** The ":" between the two match-score outputs. */
const resultColon = (page: Page) =>
  page.locator('output[aria-label*="ets"]').first().locator('xpath=following-sibling::span[1]');

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);
});

test('the score sits on the middle of its cell, not on the middle of the row', async ({ page }) => {
  const cell = page.locator('output[aria-label*="ets"]').first()
    .locator('xpath=ancestor::div[contains(@class,"border-b")][1]');
  const colon = await centreOf(page, resultColon(page));
  const box = await cell.boundingBox();
  const cellCentre = box!.x + box!.width / 2;
  // Within a pixel of the cell's own centre — the failure it replaces was ~60px.
  expect(Math.abs(colon - cellCentre)).toBeLessThanOrEqual(1.5);
});

test('and it shares that centre with the sets underneath', async ({ page }) => {
  // A set has to exist for the sets block to render at all.
  await page.getByLabel(/(Set|Satz) 1 (home|Heim)/).fill('25');
  await page.getByLabel(/(Set|Satz) 1 (away|Gast)/).fill('20');

  const setsRow = page.getByLabel(/(Set|Satz) 1 (home|Heim)/)
    .locator('xpath=ancestor::div[contains(@class,"flex-wrap")][1]');
  const colon = await centreOf(page, resultColon(page));
  const sets = await centreOf(page, setsRow);
  expect(Math.abs(colon - sets)).toBeLessThanOrEqual(1.5);
});

test('an away team with a much longer name does not drag the score off centre', async ({ page }) => {
  // The real shape from the report: a short home name against a long away one.
  const colon = await centreOf(page, resultColon(page));
  const cell = page.locator('output[aria-label*="ets"]').first()
    .locator('xpath=ancestor::div[contains(@class,"border-b")][1]');
  const box = await cell.boundingBox();
  // Both names are capped and equal, so the two outputs straddle the centre.
  const home = await centreOf(page, page.locator('output[aria-label*="ets"]').first());
  const away = await centreOf(page, page.locator('output[aria-label*="ets"]').nth(1));
  expect(colon - home).toBeCloseTo(away - colon, 0);
  expect(Math.abs(colon - (box!.x + box!.width / 2))).toBeLessThanOrEqual(1.5);
});

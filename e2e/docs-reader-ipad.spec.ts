import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Locator, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// Mike's first coaching with the app, on an iPad mini
// (27.10.2026), and Luca's note the same day:
//  - the Notizblock should be there while a regulation is open, to copy a
//    passage into it;
//  - the regulations "could not be searched on the iPad mini";
//  - copy/paste out of them did not work;
//  - the table of contents should jump to the article;
//  - back from the form, the regulation should still be where it was;
//  - "if I zoom, it is super bad resolution".
// Each test below is one of those, as the coach meets it.

const GUIDE_PDF = readFileSync(fileURLToPath(new URL('../public/docs/Leitfaden-SR-Technik.pdf', import.meta.url)));

/** Nine pages of tables; "Laufwege" first stands on page 6. */
const GUIDE = /Leitfaden SR-Technik|Refereeing technique guide/;
/** Eight pages; the contents on pages 1–2 are links (page 2's lead to section 7, on page 7). */
const RC_LETTER = /Infoschreiben RC-Wesen|RC information sheet/;
const RULES = /Offizielle Volleyball-Regeln|Official volleyball rules/;

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pageIndicator = (reader: Locator) => reader.getByText(/^(Seite|Page) \d+ (von|of) \d+$/);
const scrollBox = (reader: Locator) => reader.locator('[data-pdf-scroll]');

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route(/\/api\/docs\//, (r) => r.fulfill({ contentType: 'application/pdf', body: GUIDE_PDF }));
});

async function openDoc(page: Page, name: RegExp): Promise<Locator> {
  await page.getByRole('button', { name }).first().click();
  const reader = page.getByRole('dialog', { name });
  await expect(reader.locator('canvas').first()).toBeVisible({ timeout: 20_000 });
  return reader;
}

/** Scroll the reader so that `n` is the page at the top. */
async function scrollToPage(reader: Locator, n: number): Promise<void> {
  await scrollBox(reader).evaluate((box, n) => {
    const el = box.querySelector(`#pdf-page-${n}`) as HTMLElement;
    const wrap = el.parentElement as HTMLElement;
    box.scrollTop = wrap.offsetTop + el.offsetTop + 20;
  }, n);
  await expect(pageIndicator(reader)).toHaveText(new RegExp(`^(Seite|Page) ${n} `));
}

test('a word on the page can be selected, copied, and pasted into the Notizblock', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions are a Chromium thing in Playwright');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);

  // The words lie over the page as text, in the place the page draws them.
  const span = reader.locator('#pdf-page-1 .pdf-text-layer span', { hasText: /^Leitfaden SR-Technik/ }).first();
  await expect(span).toBeAttached({ timeout: 20_000 });
  // A drag across the title, as a finger or a mouse would select it.
  const b = (await span.boundingBox())!;
  await page.mouse.move(b.x + 1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 1, b.y + b.height / 2, { steps: 5 });
  await page.mouse.up();
  const selected = (await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim();
  expect(selected).toMatch(/^Leitfaden SR-Techni/);
  await page.keyboard.press('ControlOrMeta+C');

  // The Notizblock is on top of the reader, not hidden under it.
  await launcher(page).click();
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByTestId('pad-new-page').click();
  await sheet(page).getByTestId('pad-side-text').click();
  await sheet(page).locator('.rich-surface').click();
  await page.keyboard.press('ControlOrMeta+V');
  await expect(sheet(page).locator('.rich-surface')).toContainText('Leitfaden SR-Techni');
});

test('the Notizblock opens over the reader, and Escape gives the reader back where it was', async ({ page }) => {
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  await scrollToPage(reader, 5);
  const before = await scrollBox(reader).evaluate((box) => box.scrollTop);

  await launcher(page).click();
  await expect(sheet(page)).toBeVisible();
  // One Escape peels the sheet, not the reader under it as well.
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
  await expect(reader).toBeVisible();
  expect(await scrollBox(reader).evaluate((box) => box.scrollTop)).toBe(before);
  await expect(pageIndicator(reader)).toHaveText(/^(Seite|Page) 5 /);
});

test('closed and opened again — even after a reload — the document is where it was left', async ({ page }) => {
  await page.goto('/coachees');
  let reader = await openDoc(page, GUIDE);
  await scrollToPage(reader, 6);
  await reader.getByRole('button', { name: /^(Grösser|Zoom in)$/ }).click();
  const zoom = await reader.getByText(/^\d+%$/).textContent();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  reader = await openDoc(page, GUIDE);
  await expect(pageIndicator(reader)).toHaveText(/^(Seite|Page) 6 /);
  await expect(reader.getByText(/^\d+%$/)).toHaveText(zoom!);

  // iOS ends a backgrounded Safari tab without warning; the coach comes back
  // to a reloaded app.
  await page.keyboard.press('Escape');
  await page.reload();
  reader = await openDoc(page, GUIDE);
  await expect(pageIndicator(reader)).toHaveText(/^(Seite|Page) 6 /);
});

test('a line of the table of contents jumps to its section, and "Back" returns to the contents', async ({ page }) => {
  await page.goto('/coachees');
  const reader = await openDoc(page, RC_LETTER);
  await scrollToPage(reader, 2);

  const link = reader.locator('#pdf-page-2 [data-pdf-link]').first();
  await expect(link).toBeVisible({ timeout: 20_000 });
  // Named by the line it covers, not by forty identical "go to" labels.
  await expect(link).toHaveAttribute('aria-label', /Spezielles für die Saison/);
  await link.click();
  await expect(pageIndicator(reader)).toHaveText(/^(Seite|Page) 7 /);

  await reader.getByRole('button', { name: /^(Zurück zu Seite|Back to page) 2$/ }).click();
  await expect(pageIndicator(reader)).toHaveText(/^(Seite|Page) 2 /);
});

test('the search box is 16 px, so Safari on an iPad mini does not zoom into it', async ({ page }) => {
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  const box = reader.getByPlaceholder(/Im Dokument suchen|Search this document/);
  expect(await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  // And nothing "corrects" a term of art on the way in.
  await expect(box).toHaveAttribute('autocorrect', 'off');
  await expect(box).toHaveAttribute('autocapitalize', 'off');
});

test('a typed search goes to its first match, not only into the list', async ({ page }) => {
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  await reader.getByPlaceholder(/Im Dokument suchen|Search this document/).fill('laufwege');
  await expect(reader.locator('header').getByText(/^1\/\d+$/)).toBeVisible({ timeout: 20_000 });
  // The current match is on screen, wherever it is in the document.
  await expect(reader.locator('#pdf-page-6 .ring-amber-500').first()).toBeInViewport({ timeout: 10_000 });
});

test('while the document is still on its way, the search says so instead of "no matches"', async ({ page }) => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/docs\//, async (r) => { await held; await r.fulfill({ contentType: 'application/pdf', body: GUIDE_PDF }); });
  await page.goto('/coachees');
  await page.getByRole('button', { name: RULES }).first().click();
  const reader = page.getByRole('dialog', { name: RULES });
  await reader.getByPlaceholder(/Im Dokument suchen|Search this document/).fill('halle');
  const status = reader.locator('header');
  await expect(status.getByText(/^(Dokument lädt noch…|Still loading…)$/)).toBeVisible();
  await expect(status.getByText(/^(Keine Treffer|No matches)$/)).toHaveCount(0);
  release();
  await expect(status.getByText(/^\d+\/\d+$/)).toBeVisible({ timeout: 20_000 });
});

/** The bitmap's pixels per CSS pixel of the page on screen: ~1 when drawn for
 *  the size shown (devicePixelRatio is 1 here), well under 1 when a smaller
 *  bitmap is being stretched — the blur of a browser zoom. */
const sharpness = (reader: Locator) => reader.locator('[data-page] canvas').first()
  .evaluate((c: HTMLCanvasElement) => c.width / c.getBoundingClientRect().width);

test('Ctrl + wheel (a trackpad pinch) zooms the reader and draws the page again, sharp', async ({ page, isMobile }) => {
  test.skip(isMobile, 'a phone has no wheel');
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  const percent = async () => parseInt((await reader.getByText(/^\d+%$/).textContent()) || '0', 10);
  const before = await percent();

  const b = (await scrollBox(reader).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');

  await expect.poll(percent).toBeGreaterThan(before + 20);
  await expect.poll(() => sharpness(reader)).toBeGreaterThan(0.95);
  // The browser itself did not zoom: no stretched app around the reader.
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
});

test('a two-finger pinch zooms the reader and draws the page again, sharp', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'touch points are sent through the Chrome DevTools Protocol');
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  const percent = async () => parseInt((await reader.getByText(/^\d+%$/).textContent()) || '0', 10);
  const before = await percent();

  const b = (await scrollBox(reader).boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + 250;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', spread: number) => cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: type === 'touchEnd' ? [] : [{ x: cx - spread, y: cy, id: 0 }, { x: cx + spread, y: cy, id: 1 }],
  });
  await touch('touchStart', 40);
  for (const spread of [60, 80, 100, 120]) await touch('touchMove', spread);
  await touch('touchEnd', 0);

  await expect.poll(percent).toBeGreaterThan(before * 2);
  await expect.poll(() => sharpness(reader)).toBeGreaterThan(0.95);
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
});

test('a phrase broken over two lines of the page is still found', async ({ page }) => {
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  // "… seine" ends one line of page 3 and "Position …" starts the next.
  await reader.getByPlaceholder(/Im Dokument suchen|Search this document/).fill('seine position');
  await expect(reader.locator('header').getByText(/^1\/\d+$/)).toBeVisible({ timeout: 20_000 });
});

test('a phrase not in the document as typed finds the pages that hold every word of it', async ({ page }) => {
  await page.goto('/coachees');
  const reader = await openDoc(page, GUIDE);
  // Both words are on page 1, far apart; together they are nowhere.
  await reader.getByPlaceholder(/Im Dokument suchen|Search this document/).fill('netzhöhe kontrollblick');
  await expect(reader.locator('header').getByText(/^1\/\d+$/)).toBeVisible({ timeout: 20_000 });
  await expect(reader.locator('header').getByText(/^(Wörter einzeln|words one by one)$/)).toHaveCount(1);
  await expect(reader.locator('header').getByRole('button', { name: /^(S\.|p\.) 1\D/ }).first()).toBeVisible();
});

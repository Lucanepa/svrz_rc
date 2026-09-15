import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * The pen page: strokes are stored as vectors (never a bitmap), a pen draws
 * with pressure, a finger is ignored once a pen was seen, a palm never draws,
 * undo works, the court background is kept with the page, and an ink page is
 * pushed in a request of its own, with its strokes.
 *
 * Playwright has no stylus: pen and touch input are dispatched as synthetic
 * pointer events (which is also why setPointerCapture has to be guarded).
 */

const PAD_DB = 'svrz-notebook';
const SYNC = { timeout: 12_000 };

type StoredInk = { id: string; ownerId: string; page: { w: number; h: number; strokes: { c: number; w: number; p: number; d: number[] }[] } };
type StoredPage = { pageId: string; kind: string; bg: string; points: number; dirty: boolean };

function storedInk(page: Page): Promise<StoredInk[]> {
  return page.evaluate((db) => new Promise<StoredInk[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction('ink', 'readonly').objectStore('ink').getAll(); req.onsuccess = () => { d.close(); resolve(req.result as StoredInk[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), PAD_DB);
}
function storedPages(page: Page): Promise<StoredPage[]> {
  return page.evaluate((db) => new Promise<StoredPage[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction('pages', 'readonly').objectStore('pages').getAll(); req.onsuccess = () => { d.close(); resolve(req.result as StoredPage[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), PAD_DB);
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const pad = (page: Page) => sheet(page).getByTestId('ink-page');

async function openPenPage(page: Page, court = false): Promise<void> {
  await launcher(page).click();
  await sheet(page).getByRole('button', { name: /^(Stift|Pen)$/ }).click();
  await expect(pad(page)).toBeVisible();
  if (court) await sheet(page).getByRole('button', { name: /^(Spielfeld|Court)$/ }).click();
}

async function mouseStroke(page: Page, fromX: number, fromY: number, toX: number, toY: number): Promise<void> {
  const box = (await pad(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * fromX, box.y + box.height * fromY);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toX, box.y + box.height * toY, { steps: 12 });
  await page.mouse.up();
}

type PointerInit = Record<string, unknown>;
async function syntheticStroke(page: Page, init: PointerInit, points: [number, number][]): Promise<void> {
  const box = (await pad(page).boundingBox())!;
  const at = (fx: number, fy: number) => ({ clientX: box.x + box.width * fx, clientY: box.y + box.height * fy });
  const base = { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, ...init };
  await pad(page).dispatchEvent('pointerdown', { ...base, ...at(...points[0]) });
  for (const [fx, fy] of points.slice(1)) await pad(page).dispatchEvent('pointermove', { ...base, ...at(fx, fy) });
  const last = points[points.length - 1];
  await page.evaluate(([b, xy]) => { window.dispatchEvent(new PointerEvent('pointerup', { ...(b as PointerEventInit), ...(xy as PointerEventInit) })); }, [base, at(...last)] as const);
}

async function nonBlank(page: Page): Promise<boolean> {
  return pad(page).locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
}

test('a mouse stroke is stored as integer strokes, not a PNG, and the page counts its points', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await mouseStroke(page, 0.1, 0.5, 0.9, 0.3);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const ink = (await storedInk(page))[0];
  expect(ink.ownerId).toBe(RC.id);
  expect(ink.page.w).toBe(1000);
  expect(ink.page.h).toBe(1414);
  const stroke = ink.page.strokes[0];
  expect(stroke.d.length % 4).toBe(0);
  expect(stroke.d.length).toBeGreaterThan(8);
  for (const v of stroke.d) expect(Number.isInteger(v)).toBe(true);
  expect(JSON.stringify(ink)).not.toMatch(/data:image/);
  const pages = await storedPages(page);
  expect(pages[0].kind).toBe('ink');
  expect(pages[0].points).toBe(stroke.d.length / 4);
  expect(await nonBlank(page)).toBe(true);
});

test('a pen stroke draws with pressure, and no js.error is filed for the synthetic pointer', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await syntheticStroke(page, { pointerType: 'pen', pointerId: 7, pressure: 0.6 }, [[0.2, 0.2], [0.4, 0.3], [0.6, 0.35], [0.8, 0.5]]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  expect((await storedInk(page))[0].page.strokes[0].p).toBe(1);
  const errors = await page.evaluate(() => {
    const w = window as unknown as { svrzLogs?: () => { lvl: string; evt: string }[] };
    return (w.svrzLogs ? w.svrzLogs() : []).filter((e) => e.lvl === 'error' && e.evt === 'js.error');
  });
  expect(errors).toEqual([]);
});

test('touch is ignored while a pen was just used; a palm never draws; the finger toggle brings touch back', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await syntheticStroke(page, { pointerType: 'pen', pointerId: 7, pressure: 0.5 }, [[0.2, 0.2], [0.5, 0.5]]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const finger = sheet(page).getByRole('button', { name: /^(Finger)$/ });
  // The first pen sighting turns the finger off.
  await expect(finger).toHaveAttribute('aria-pressed', 'false');
  await syntheticStroke(page, { pointerType: 'touch', pointerId: 8, width: 10, height: 10 }, [[0.3, 0.7], [0.6, 0.8]]);
  await page.waitForTimeout(300);
  expect((await storedInk(page))[0].page.strokes.length).toBe(1);
  await finger.click();
  await expect(finger).toHaveAttribute('aria-pressed', 'true');
  // The 500 ms trailing window after the pen IS the behaviour under test.
  await page.waitForTimeout(600);
  await syntheticStroke(page, { pointerType: 'touch', pointerId: 9, width: 10, height: 10 }, [[0.3, 0.7], [0.6, 0.8]]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await syntheticStroke(page, { pointerType: 'touch', pointerId: 10, width: 60, height: 60 }, [[0.3, 0.9], [0.6, 0.95]]);
  await page.waitForTimeout(300);
  expect((await storedInk(page))[0].page.strokes.length).toBe(2);
});

test('a phone with no pen draws with the finger by default', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await syntheticStroke(page, { pointerType: 'touch', pointerId: 11, width: 10, height: 10 }, [[0.2, 0.2], [0.6, 0.6]]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
});

test('pointercancel drops the stroke; undo and clear work; the court stays with the page', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page, true);
  // A cancelled stroke never lands.
  const box = (await pad(page).boundingBox())!;
  await pad(page).dispatchEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, buttons: 1, clientX: box.x + 10, clientY: box.y + 10 });
  await pad(page).dispatchEvent('pointermove', { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, buttons: 1, clientX: box.x + 60, clientY: box.y + 60 });
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })));
  await page.waitForTimeout(200);
  expect(await storedInk(page)).toHaveLength(0);
  await mouseStroke(page, 0.1, 0.1, 0.5, 0.2);
  await mouseStroke(page, 0.1, 0.4, 0.5, 0.5);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await sheet(page).getByRole('button', { name: /^(Rückgängig|Undo)$/ }).click();
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  await sheet(page).getByRole('button', { name: /^(Seite leeren|Clear page)$/ }).click();
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(0);
  expect((await storedPages(page))[0].bg).toBe('court');
  // The court lines are drawn even with no ink on the page.
  expect(await nonBlank(page)).toBe(true);
});

test('a resize re-renders from the vectors', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop viewport only');
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await mouseStroke(page, 0.1, 0.5, 0.9, 0.5);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const before = (await storedInk(page))[0].page.strokes[0].d;
  await page.setViewportSize({ width: 900, height: 700 });
  await page.waitForTimeout(300);
  expect(await nonBlank(page)).toBe(true);
  expect((await storedInk(page))[0].page.strokes[0].d).toEqual(before);
});

test('an ink page is pushed in its own request, with its strokes and its court; the index carries no ink', async ({ page }) => {
  await stubSignedInApp(page);
  const puts: Record<string, unknown>[][] = [];
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: [] } }));
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: Record<string, unknown>[] };
    puts.push(body.pages);
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date().toISOString(), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
  });
  await page.goto('/');
  await openPenPage(page, true);
  await mouseStroke(page, 0.1, 0.5, 0.9, 0.5);
  await expect.poll(() => puts.length, SYNC).toBeGreaterThanOrEqual(1);
  const inkPush = puts.find((batch) => batch.some((p) => p.kind === 'ink'))!;
  expect(inkPush).toHaveLength(1);
  const sent = inkPush[0] as { ink?: { strokes: unknown[] }; bg?: string };
  expect(sent.bg).toBe('court');
  expect(sent.ink?.strokes).toHaveLength(1);
  await expect.poll(async () => (await storedPages(page))[0]?.dirty, SYNC).toBe(false);
});

test('a page whose ink is not local is fetched when opened', async ({ page }) => {
  await stubSignedInApp(page);
  const asked: string[] = [];
  const at = Date.now() - 60_000;
  const stroke = { c: 0, w: 3, p: 0, d: [1000, 5000, 0, 0, 3000, 0, 0, 16, 3000, 200, 0, 32] };
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: [{ pageId: 'page-ink-remote', kind: 'ink', bg: '', points: 3, createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: new Date(at).toISOString() }] } }));
  await page.route('**/api/notebook/pages/page-ink-remote', (r) => { asked.push(r.request().url()); return r.fulfill({ json: { ownerId: RC.id, page: { pageId: 'page-ink-remote', kind: 'ink', bg: '', points: 3, createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: new Date(at).toISOString(), ink: { w: 1000, h: 1414, strokes: [stroke] } } } }); });
  await page.goto('/');
  await launcher(page).click();
  await expect(pad(page)).toBeVisible();
  await expect.poll(() => asked.length, SYNC).toBe(1);
  await expect.poll(() => nonBlank(page), SYNC).toBe(true);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
});

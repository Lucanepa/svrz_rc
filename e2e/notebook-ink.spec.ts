import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, RC, suiteNow } from './support/app';

/**
 * The pen page: strokes are stored as vectors (never a bitmap), a pen draws
 * with pressure, a finger is ignored once a pen was seen, a palm never draws,
 * undo works, the court background is kept with the page, and an ink page is
 * pushed in a request of its own, with its strokes. The writing hand on the
 * sheet around the page changes nothing.
 *
 * Playwright has no stylus: pen and touch input are dispatched as synthetic
 * pointer events (which is also why setPointerCapture has to be guarded).
 * Zoom and pan have their own spec (notebook-ink-zoom.spec.ts); here every
 * page is shown whole, so a fraction of the page is a point on screen.
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
/** The paper: its box is the page, wherever the view puts it. */
const pad = (page: Page) => sheet(page).getByTestId('ink-page');
/** The grey area the pad fills; the canvases are its children. */
const stage = (page: Page) => sheet(page).getByTestId('ink-stage');

/** A new pen page, shown whole. A page opens at fit-width, taller than the
 *  stage, and the helpers below aim at fractions of the page. */
async function openPenPage(page: Page, court = false): Promise<void> {
  await launcher(page).click();
  // By test id: the black pen in the toolbar is called "Stift" too.
  await sheet(page).getByTestId('pad-new-ink').click();
  await expect(pad(page)).toBeVisible();
  await sheet(page).getByTestId('ink-zoom').click();
  await expect(sheet(page).getByRole('button', { name: /^(Verkleinern|Zoom out)$/ })).toBeDisabled();
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
  return stage(page).locator('canvas').first().evaluate((c: HTMLCanvasElement) => {
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
  // A palm is hundreds of px; a light fingertip reads about 42 on an iPad.
  await syntheticStroke(page, { pointerType: 'touch', pointerId: 10, width: 120, height: 120 }, [[0.3, 0.9], [0.6, 0.95]]);
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

test('pointercancel keeps what was drawn and counts for the Scribble hint; undo and clear work; the court stays with the page', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page, true);
  // iPadOS cancels a stroke it hands to Scribble or a system gesture: the ink
  // drawn until then stays (it vanishing looked like lost handwriting), and
  // the second cancel brings the hint about Scribble.
  const box = (await pad(page).boundingBox())!;
  for (const [n, y] of [[1, 10], [2, 80]] as const) {
    await pad(page).dispatchEvent('pointerdown', { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, buttons: 1, clientX: box.x + 10, clientY: box.y + y });
    await pad(page).dispatchEvent('pointermove', { bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true, buttons: 1, clientX: box.x + 60, clientY: box.y + y + 50 });
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', bubbles: true })));
    await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(n);
  }
  await expect(sheet(page).getByText(/Kritzeln aus|Scribble off/)).toBeVisible();
  await mouseStroke(page, 0.1, 0.4, 0.5, 0.5);
  await mouseStroke(page, 0.1, 0.6, 0.5, 0.7);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(4);
  await sheet(page).getByRole('button', { name: /^(Rückgängig|Undo)$/ }).click();
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(3);
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
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date(suiteNow()).toISOString(), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
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
  const at = suiteNow() - 60_000;
  const stroke = { c: 0, w: 3, p: 0, d: [1000, 5000, 0, 0, 3000, 0, 0, 16, 3000, 200, 0, 32] };
  await page.route('**/api/notebook', (r) => r.fulfill({ json: { ownerId: RC.id, pages: [{ pageId: 'page-ink-remote', kind: 'ink', bg: '', points: 3, createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: new Date(at).toISOString() }] } }));
  await page.route('**/api/notebook/pages/page-ink-remote', (r) => { asked.push(r.request().url()); return r.fulfill({ json: { ownerId: RC.id, page: { pageId: 'page-ink-remote', kind: 'ink', bg: '', points: 3, createdAt: at, updatedAt: at, deleted: false, schema: 1, savedAt: new Date(at).toISOString(), ink: { w: 1000, h: 1414, strokes: [stroke] } } } }); });
  await page.goto('/');
  await launcher(page).click();
  await expect(pad(page)).toBeVisible();
  await expect.poll(() => asked.length, SYNC).toBe(1);
  // The stroke is halfway down the page, below a page opened at its top.
  await sheet(page).getByTestId('ink-zoom').click();
  await expect.poll(() => nonBlank(page), SYNC).toBe(true);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
});

/** A pen stroke with a pressure per event: [fx, fy, pressure] of the page. */
async function penStroke(page: Page, pointerId: number, points: [number, number, number][]): Promise<void> {
  const box = (await pad(page).boundingBox())!;
  await page.evaluate(([b, id, pts]) => {
    const target = document.querySelector('[data-testid="ink-stage"] canvas')!;
    const init = (fx: number, fy: number, pressure: number) => ({ bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: 'pen', pointerId: id, pressure, clientX: b.x + b.width * fx, clientY: b.y + b.height * fy });
    pts.forEach(([fx, fy, p], i) => target.dispatchEvent(new PointerEvent(i === 0 ? 'pointerdown' : 'pointermove', init(fx, fy, p))));
    const [lx, ly] = pts[pts.length - 1];
    window.dispatchEvent(new PointerEvent('pointerup', { ...init(lx, ly, 0), buttons: 0 }));
  }, [box, pointerId, points] as const);
}

test('a pen whose first event reads no pressure keeps its real pressure; one that never reads any is drawn simulated', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  // Safari can report 0 on the Pencil's first event. That used to switch the
  // whole stroke to speed-simulated pressure, which thins fast writing.
  await penStroke(page, 7, [[0.2, 0.2, 0], [0.3, 0.21, 0.3], [0.4, 0.22, 0.3], [0.5, 0.23, 0.3]]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const first = (await storedInk(page))[0].page.strokes[0];
  expect(first.p).toBe(1);
  const pressures = first.d.filter((_, i) => i % 4 === 2);
  expect(pressures.every((p) => p > 0)).toBe(true);
  // A pen that never reported a pressure is stored as simulated, not as a hairline.
  await penStroke(page, 8, [[0.2, 0.5, 0], [0.4, 0.52, 0], [0.6, 0.55, 0]]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  const second = (await storedInk(page))[0].page.strokes[1];
  expect(second.p).toBe(0);
  expect(second.d.filter((_, i) => i % 4 === 2).every((p) => p === 0)).toBe(true);
});

test('each sample stores its own time since the one before it', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const box = (await pad(page).boundingBox())!;
  const at = (fx: number, fy: number) => ({ clientX: box.x + box.width * fx, clientY: box.y + box.height * fy });
  const base = { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: 'pen', pointerId: 7, pressure: 0.4 };
  const started = Date.now();
  await pad(page).dispatchEvent('pointerdown', { ...base, ...at(0.2, 0.3) });
  for (let i = 1; i <= 5; i += 1) {
    await page.waitForTimeout(40);
    await pad(page).dispatchEvent('pointermove', { ...base, ...at(0.2 + i * 0.1, 0.3) });
  }
  const elapsed = Date.now() - started;
  await page.evaluate((b) => { window.dispatchEvent(new PointerEvent('pointerup', b as PointerEventInit)); }, { ...base, buttons: 0 });
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const d = (await storedInk(page))[0].page.strokes[0].d;
  const dts = d.filter((_, i) => i % 4 === 3).slice(1);
  expect(dts).toHaveLength(5);
  for (const dt of dts) expect(dt).toBeGreaterThanOrEqual(30);
  // Every delta used to be the whole stroke's duration.
  expect(dts.reduce((n, dt) => n + dt, 0)).toBeLessThanOrEqual(elapsed + 20);
});

test('the writing hand on the sheet: a touch on its buttons right after the pen does nothing, a touch beside it never closes it', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const undo = sheet(page).getByRole('button', { name: /^(Rückgängig|Undo)$/ });
  await mouseStroke(page, 0.1, 0.2, 0.5, 0.25);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  // In one go: the pen writes, and the palm lands on Rückgängig as it lifts.
  const box = (await pad(page).boundingBox())!;
  await page.evaluate((b) => {
    const target = document.querySelector('[data-testid="ink-stage"] canvas')!;
    const pen = (type: string, fx: number) => new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'pen', pointerId: 7, pressure: 0.4, clientX: b.x + b.width * fx, clientY: b.y + b.height * 0.5 });
    target.dispatchEvent(pen('pointerdown', 0.2));
    target.dispatchEvent(pen('pointermove', 0.4));
    window.dispatchEvent(pen('pointerup', 0.4));
    const button = [...document.querySelectorAll('button')].find((el) => /^(Rückgängig|Undo)$/.test(el.getAttribute('aria-label') || ''))!;
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 30, width: 60, height: 60 }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, box);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await page.waitForTimeout(300);
  expect((await storedInk(page))[0].page.strokes).toHaveLength(2);
  // Once the pen has been away for a moment, a finger's tap is a tap again.
  await page.waitForTimeout(300);
  await undo.dispatchEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 31, width: 20, height: 20 });
  await undo.dispatchEvent('click');
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  // A palm beside the sheet does not close it; a mouse click there does.
  const backdrop = sheet(page).locator('xpath=..');
  await backdrop.dispatchEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 32, width: 120, height: 120 });
  await backdrop.dispatchEvent('click');
  await page.waitForTimeout(200);
  await expect(sheet(page)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(sheet(page)).toHaveCount(0);
});

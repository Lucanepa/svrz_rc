import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * Zoom and pan on the pen page (Jennifer, 23.10.2026: "on the handwriting
 * paper I cannot zoom in"). The page opens at fit-width, at its top; two
 * fingers pinch and move it; one finger moves it while the finger does not
 * draw; the pen always draws and a hand near it never moves the page; the
 * buttons and a desktop's wheel do the same; the level is remembered per
 * device, never the position.
 *
 * A gesture is fired in ONE page.evaluate, so the 250 / 300 / 500 ms windows
 * under test are not at the mercy of the runner's speed. Points are fractions
 * of the STAGE (the grey area the pad fills), not of the page.
 */

const PAD_DB = 'svrz-notebook';
const SYNC = { timeout: 12_000 };

type StoredInk = { page: { strokes: { c: number; w: number; p: number; d: number[] }[] } };
function storedInk(page: Page): Promise<StoredInk[]> {
  return page.evaluate((db) => new Promise<StoredInk[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction('ink', 'readonly').objectStore('ink').getAll(); req.onsuccess = () => { d.close(); resolve(req.result as StoredInk[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), PAD_DB);
}
function storedPages(page: Page): Promise<unknown[]> {
  return page.evaluate((db) => new Promise<unknown[]>((resolve, reject) => {
    const open = indexedDB.open(db, 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => { const d = open.result; const req = d.transaction('pages', 'readonly').objectStore('pages').getAll(); req.onsuccess = () => { d.close(); resolve(req.result as unknown[]); }; req.onerror = () => { d.close(); reject(req.error); }; };
  }), PAD_DB);
}

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const stage = (page: Page) => sheet(page).getByTestId('ink-stage');
const paper = (page: Page) => sheet(page).getByTestId('ink-page');
const zoomIn = (page: Page) => sheet(page).getByRole('button', { name: /^(Vergrössern|Zoom in)$/ });
const zoomOut = (page: Page) => sheet(page).getByRole('button', { name: /^(Verkleinern|Zoom out)$/ });
/** The middle button, named for what it shows first, the level, then what a
 *  tap does: the whole page from any other view, the page width from there. */
const wholePage = (page: Page) => sheet(page).getByRole('button', { name: /^\d+ % — (Ganze Seite|Whole page)$/ });
const pageWidth = (page: Page) => sheet(page).getByRole('button', { name: /^\d+ % — (Seitenbreite|Page width)$/ });

/** A new page on its handwritten side (the switch is a no-op once this
 *  device remembers that side). */
async function newPenPage(page: Page): Promise<void> {
  await sheet(page).getByTestId('pad-new-page').click();
  await sheet(page).getByTestId('pad-side-ink').click();
  await expect(paper(page)).toBeVisible();
}

async function openPenPage(page: Page): Promise<void> {
  await launcher(page).click();
  await newPenPage(page);
  await expect(stage(page)).toHaveAttribute('data-zoom', /\d/);
}

type Box = { x: number; y: number; width: number; height: number };
const box = async (page: Page, which: 'stage' | 'paper'): Promise<Box> => (await (which === 'stage' ? stage(page) : paper(page)).boundingBox())!;

type Step = { type: 'down' | 'move' | 'up' | 'cancel'; id: number; kind: 'touch' | 'pen' | 'mouse'; fx: number; fy: number; pressure?: number; size?: number };

/** Fires the steps synchronously, in one evaluate. Downs and moves go to the
 *  page canvas (what a real contact hits), ups and cancels to the window. */
async function fire(page: Page, steps: Step[]): Promise<void> {
  await page.evaluate((list) => {
    const stageEl = document.querySelector('[data-testid="ink-stage"]')!;
    const target = stageEl.querySelector('canvas')!;
    const r = stageEl.getBoundingClientRect();
    for (const s of list) {
      const size = s.size ?? (s.kind === 'touch' ? 10 : 1);
      const init: PointerEventInit = {
        bubbles: true, cancelable: true, pointerId: s.id, pointerType: s.kind, isPrimary: s.id === 1 || s.id === 7 || s.id === 21,
        buttons: s.type === 'up' || s.type === 'cancel' ? 0 : 1, width: size, height: size,
        pressure: s.pressure ?? (s.kind === 'pen' ? 0.5 : 0), clientX: r.left + r.width * s.fx, clientY: r.top + r.height * s.fy,
      };
      const type = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' }[s.type];
      (s.type === 'up' || s.type === 'cancel' ? window : target).dispatchEvent(new PointerEvent(type, init));
    }
  }, steps);
}

/** Two fingers on a horizontal line through (cx, cy), from ±from to ±to of
 *  the stage's width; down, moved in steps, and (unless `hold`) lifted. */
function pinch(ids: [number, number], cx: number, cy: number, from: number, to: number, opts: { steps?: number; hold?: boolean } = {}): Step[] {
  const n = opts.steps ?? 6;
  const out: Step[] = [
    { type: 'down', id: ids[0], kind: 'touch', fx: cx - from, fy: cy },
    { type: 'down', id: ids[1], kind: 'touch', fx: cx + from, fy: cy },
  ];
  for (let i = 1; i <= n; i += 1) {
    const half = from + ((to - from) * i) / n;
    out.push({ type: 'move', id: ids[0], kind: 'touch', fx: cx - half, fy: cy }, { type: 'move', id: ids[1], kind: 'touch', fx: cx + half, fy: cy });
  }
  if (!opts.hold) out.push({ type: 'up', id: ids[0], kind: 'touch', fx: cx - to, fy: cy }, { type: 'up', id: ids[1], kind: 'touch', fx: cx + to, fy: cy });
  return out;
}

function penLine(id: number, fx0: number, fx1: number, fy: number, n = 6): Step[] {
  const out: Step[] = [{ type: 'down', id, kind: 'pen', fx: fx0, fy }];
  for (let i = 1; i <= n; i += 1) out.push({ type: 'move', id, kind: 'pen', fx: fx0 + ((fx1 - fx0) * i) / n, fy });
  out.push({ type: 'up', id, kind: 'pen', fx: fx1, fy });
  return out;
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

/** The page point (page units) under a stage point. */
async function pageUnder(page: Page, fx: number, fy: number): Promise<[number, number]> {
  const s = await box(page, 'stage'); const p = await box(page, 'paper');
  return [((s.x + s.width * fx - p.x) / p.width) * 1000, ((s.y + s.height * fy - p.y) / p.height) * 1414];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

test('a two-finger pinch zooms about the fingers and draws nothing', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  // No pen seen yet: the finger draws, and the first finger starts a stroke
  // that the second one, landing at once, turns into the pinch.
  await expect(sheet(page).getByRole('button', { name: /^(Finger)$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  const before = await box(page, 'paper');
  const anchor = await pageUnder(page, 0.5, 0.5);
  await fire(page, pinch([21, 22], 0.5, 0.5, 0.1, 0.25));
  await expect(stage(page)).toHaveAttribute('data-zoom', '2.50');
  const after = await box(page, 'paper');
  expect(after.width / before.width).toBeCloseTo(2.5, 2);
  const [ax, ay] = await pageUnder(page, 0.5, 0.5);
  expect(Math.abs(ax - anchor[0])).toBeLessThan(1);
  expect(Math.abs(ay - anchor[1])).toBeLessThan(1);
  // Nothing drawn, and a page not yet written stays unwritten.
  await page.waitForTimeout(300);
  expect(await nonBlank(page)).toBe(false);
  expect(await storedPages(page)).toHaveLength(0);
  await expect(sheet(page).getByText(/Kritzeln aus|Scribble off/)).toHaveCount(0);
  await expect(sheet(page).getByTestId('ink-zoom')).toHaveText('250 %');
});

test('zoomed in, the pen lands where it touches: the view is inverted exactly', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await zoomIn(page).click();
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '2.25');
  const s = await box(page, 'stage'); const p = await box(page, 'paper');
  await fire(page, penLine(7, 0.5, 0.6, 0.5));
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const d = (await storedInk(page))[0].page.strokes[0].d;
  const sx = s.x + s.width * 0.5; const sy = s.y + s.height * 0.5;
  expect(Math.abs(d[0] - ((sx - p.x) / p.width) * 10_000)).toBeLessThanOrEqual(5);
  expect(Math.abs(d[1] - ((sy - p.y) / p.height) * 14_140)).toBeLessThanOrEqual(5);
});

test('the pen always wins: two fingers while it writes do nothing, nor right after; later they zoom', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const pen = penLine(7, 0.3, 0.7, 0.3, 8);
  // Pen down and writing, a pinch in the middle of it, the pen goes on.
  await fire(page, [...pen.slice(0, 4), ...pinch([21, 22], 0.5, 0.7, 0.1, 0.3), ...pen.slice(4)]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  // A pinch the moment the pen lifts: the hand that held it.
  await fire(page, [...penLine(7, 0.3, 0.6, 0.4), ...pinch([23, 24], 0.5, 0.7, 0.1, 0.3)]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await page.waitForTimeout(200);
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  // The 500 ms after the pen IS the behaviour under test.
  await page.waitForTimeout(600);
  await fire(page, pinch([25, 26], 0.5, 0.5, 0.1, 0.2));
  await expect(stage(page)).toHaveAttribute('data-zoom', '2.00');
});

test('a hand that moved the page just before the pen landed is undone, and the stroke lands', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const anchor = await pageUnder(page, 0.5, 0.3);
  await fire(page, [...pinch([21, 22], 0.5, 0.6, 0.1, 0.2, { hold: true }), ...penLine(7, 0.5, 0.6, 0.3),
    { type: 'up', id: 21, kind: 'touch', fx: 0.3, fy: 0.6 }, { type: 'up', id: 22, kind: 'touch', fx: 0.7, fy: 0.6 }]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  const d = (await storedInk(page))[0].page.strokes[0].d;
  expect(Math.abs(d[0] / 10 - anchor[0])).toBeLessThan(2);
  expect(Math.abs(d[1] / 10 - anchor[1])).toBeLessThan(2);
});

test('with the finger off, one finger moves the page and draws nothing', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('svrz_ink_finger', '0'); } catch { /* private mode */ } });
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  const s = await box(page, 'stage'); const p0 = await box(page, 'paper');
  const dx = -80 / s.width; const dy = -120 / s.height;
  const steps: Step[] = [{ type: 'down', id: 21, kind: 'touch', fx: 0.5, fy: 0.5 }];
  for (let i = 1; i <= 6; i += 1) steps.push({ type: 'move', id: 21, kind: 'touch', fx: 0.5 + (dx * i) / 6, fy: 0.5 + (dy * i) / 6 });
  steps.push({ type: 'up', id: 21, kind: 'touch', fx: 0.5 + dx, fy: 0.5 + dy });
  await fire(page, steps);
  const ex = clamp(p0.x - 80, s.x + s.width - 8 - p0.width, s.x + 8);
  const ey = clamp(p0.y - 120, s.y + s.height - 8 - p0.height, s.y + 8);
  await expect.poll(async () => Math.abs((await box(page, 'paper')).x - ex)).toBeLessThan(0.5);
  await expect.poll(async () => Math.abs((await box(page, 'paper')).y - ey)).toBeLessThan(0.5);
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await page.waitForTimeout(300);
  expect(await nonBlank(page)).toBe(false);
  expect(await storedPages(page)).toHaveLength(0);
});

test('a resting hand: of two still contacts one lifts, and the other drifting a little moves nothing; its move just before the pen is undone', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('svrz_ink_finger', '0'); } catch { /* private mode */ } });
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  const s = await box(page, 'stage'); const p0 = await box(page, 'paper');
  const px = (n: number) => n / s.width; const py = (n: number) => n / s.height;
  const hand = (ids: [number, number]): Step[] => [
    { type: 'down', id: ids[0], kind: 'touch', fx: 0.5, fy: 0.6, size: 40 },
    { type: 'down', id: ids[1], kind: 'touch', fx: 0.56, fy: 0.6, size: 40 },
    { type: 'up', id: ids[0], kind: 'touch', fx: 0.5, fy: 0.6, size: 40 },
  ];
  const drift = (id: number, by: number): Step => ({ type: 'move', id, kind: 'touch', fx: 0.56 + px(by), fy: 0.6 + py(by), size: 40 });
  // Two contacts that never moved the page, one lifts, the other drifts 4 px
  // (up and left: the page opens at its top-left corner and goes no further):
  // under the slop, so the page stays. It used to follow from the first pixel.
  await fire(page, [...hand([21, 22]), drift(22, -4), { type: 'up', id: 22, kind: 'touch', fx: 0.56, fy: 0.6, size: 40 }]);
  await page.waitForTimeout(100);
  const p1 = await box(page, 'paper');
  expect(Math.abs(p1.x - p0.x)).toBeLessThan(0.01);
  expect(Math.abs(p1.y - p0.y)).toBeLessThan(0.01);
  // Past the slop it moves the page, as one finger does.
  await fire(page, [...hand([23, 24]), drift(24, -4), drift(24, -30), { type: 'up', id: 24, kind: 'touch', fx: 0.56, fy: 0.6, size: 40 }]);
  await expect.poll(async () => p0.y - (await box(page, 'paper')).y).toBeGreaterThan(10);
  const p2 = await box(page, 'paper');
  // The same, with the pen landing right after: the hand came first, and what
  // it moved is put back (the undo never fired for a pinch turned pan). The
  // stroke says where the page was when the pen landed; the paper itself may
  // shift a little later, when the page the stroke made adds its meta line.
  const anchor = [((s.x + s.width * 0.3 - p2.x) / p2.width) * 1000, ((s.y + s.height * 0.3 - p2.y) / p2.height) * 1414];
  await fire(page, [...hand([25, 26]), drift(26, -4), drift(26, -30), ...penLine(7, 0.3, 0.4, 0.3), { type: 'up', id: 26, kind: 'touch', fx: 0.56, fy: 0.6, size: 40 }]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const d = (await storedInk(page))[0].page.strokes[0].d;
  expect(Math.abs(d[0] / 10 - anchor[0])).toBeLessThan(2);
  expect(Math.abs(d[1] / 10 - anchor[1])).toBeLessThan(2);
});

test('the zoom buttons: in, the whole page, the page width, out; the canvases never grow', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const width = () => stage(page).locator('canvas').first().evaluate((c: HTMLCanvasElement) => c.width);
  const w0 = await width();
  const level = sheet(page).getByTestId('ink-zoom');
  await expect(level).toHaveAccessibleName(/^100 % — (Ganze Seite|Whole page)$/);
  await zoomIn(page).click();
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '2.25');
  await expect(level).toHaveAccessibleName(/^225 % — (Ganze Seite|Whole page)$/);
  expect(await width()).toBe(w0);
  await wholePage(page).click();
  await expect(zoomOut(page)).toBeDisabled();
  // The button says what it shows and, by its icon, what it will do: from
  // the whole page, back to the page width. A second tap there used to do
  // nothing.
  await expect(level).toHaveAccessibleName(/^\d+ % — (Seitenbreite|Page width)$/);
  await expect(level).toHaveText(/^\d+ %$/);
  await expect(level.locator('svg')).toHaveCount(1);
  await pageWidth(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  await expect(level).toHaveAccessibleName(/^100 % — (Ganze Seite|Whole page)$/);
  await wholePage(page).click();
  await expect(zoomOut(page)).toBeDisabled();
  const s = await box(page, 'stage'); const p = await box(page, 'paper');
  // The whole page, centred, with the margin on the side that limits it.
  expect(p.width / p.height).toBeCloseTo(1000 / 1414, 3);
  expect(p.x).toBeGreaterThanOrEqual(s.x + 7.5);
  expect(p.y).toBeGreaterThanOrEqual(s.y + 7.5);
  expect(p.x + p.width).toBeLessThanOrEqual(s.x + s.width - 7.5);
  expect(p.y + p.height).toBeLessThanOrEqual(s.y + s.height - 7.5);
  expect(Math.min(p.x - s.x, p.y - s.y)).toBeLessThan(8.5);
  await expect(zoomIn(page)).toBeEnabled();
  await zoomIn(page).click();
  await expect(zoomOut(page)).toBeEnabled();
});

test('desktop: Ctrl + wheel zooms about the cursor, the wheel moves a page bigger than the stage, Safari gestures are held', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop only');
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const s = await box(page, 'stage');
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.49');
  const p0 = await box(page, 'paper');
  await page.mouse.wheel(0, 200);
  const ey = clamp(p0.y - 200, s.y + s.height - 8 - p0.height, s.y + 8);
  await expect.poll(async () => Math.abs((await box(page, 'paper')).y - ey)).toBeLessThan(0.5);
  const prevented = await stage(page).evaluate((el) => {
    const gesture = new Event('gesturestart', { bubbles: true, cancelable: true });
    el.dispatchEvent(gesture);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    el.dispatchEvent(wheel);
    el.dispatchEvent(new Event('gestureend', { bubbles: true, cancelable: true }));
    return { gesture: gesture.defaultPrevented, wheel: wheel.defaultPrevented };
  });
  expect(prevented).toEqual({ gesture: true, wheel: true });
});

test('the zoom level is remembered on this device, and every page opens at its top', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  // The two-finger hint is for a touch screen; a desktop keeps the line that
  // says the handwriting is not inserted.
  const touchScreen = await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches);
  const zoomHint = sheet(page).getByText(/Mit zwei Fingern|Pinch with two fingers/);
  const notInserted = sheet(page).getByText(/Handschrift wird nicht übernommen|Handwriting is not inserted/);
  await expect(zoomHint).toHaveCount(touchScreen ? 1 : 0);
  await expect(notInserted).toHaveCount(touchScreen ? 0 : 1);
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await expect(zoomHint).toHaveCount(0);
  await expect(notInserted).toBeVisible();
  await fire(page, penLine(7, 0.3, 0.6, 0.5));
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  // The stroke made the page; the view she is writing in stayed.
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await newPenPage(page);
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  const s = await box(page, 'stage');
  await expect.poll(async () => Math.abs((await box(page, 'paper')).y - (s.y + 8))).toBeLessThan(0.5);
  expect(await nonBlank(page)).toBe(false);
  await page.reload();
  await launcher(page).click();
  await expect(paper(page)).toBeVisible();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
});

test('the whole page, remembered, reopens whole after a reload: not a few px too tall', async ({ page }) => {
  // An iPad in portrait: the whole page is 0.6776 of fit-width, which was
  // stored as 0.68 and reopened 2.6 px taller than the stage's room.
  await page.setViewportSize({ width: 820, height: 1180 });
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await wholePage(page).click();
  await expect(zoomOut(page)).toBeDisabled();
  await page.reload();
  await launcher(page).click();
  await newPenPage(page);
  await expect(zoomOut(page)).toBeDisabled();
  const s = await box(page, 'stage'); const p = await box(page, 'paper');
  expect(p.y).toBeGreaterThanOrEqual(s.y + 7.5);
  expect(p.y + p.height).toBeLessThanOrEqual(s.y + s.height - 7.5);
  expect(Math.abs((p.y - s.y) - (s.y + s.height - p.y - p.height))).toBeLessThan(0.5);
});

test('fullscreen keeps the zoom and the point in the middle', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  const before = await pageUnder(page, 0.5, 0.5);
  await sheet(page).getByRole('button', { name: /^(Vollbild|Fullscreen)$/ }).click();
  await expect(sheet(page)).toHaveAttribute('data-full', 'true');
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await expect.poll(async () => { const [x, y] = await pageUnder(page, 0.5, 0.5); return Math.max(Math.abs(x - before[0]), Math.abs(y - before[1])); }).toBeLessThan(2);
});

test('a phone in fullscreen: the page keeps the A4 shape, so the ink lands under the finger', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => { try { localStorage.setItem('svrz_pad_full', '1'); } catch { /* private mode */ } });
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await expect(sheet(page)).toHaveAttribute('data-full', 'true');
  // The stage is taller than the page at its width: the page width IS the
  // whole page, nothing to switch between, and the button says so by being off.
  const level = sheet(page).getByTestId('ink-zoom');
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  await expect(zoomOut(page)).toBeDisabled();
  await expect(level).toBeDisabled();
  // Zoomed in, it is the one-tap way back to the page width.
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await expect(level).toBeEnabled();
  await expect(level).toHaveAccessibleName(/^150 % — (Seitenbreite|Page width)$/);
  await level.click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  await expect(level).toBeDisabled();
  const whole = await box(page, 'paper');
  expect(Math.abs(whole.width / whole.height - 1000 / 1414)).toBeLessThan(0.002);
  // Drawn at 85 % of the page's height, it is stored there (it landed up to
  // 28 px above the finger when the box was stretched).
  const p = await box(page, 'paper'); const s = await box(page, 'stage');
  const fy = (p.y + p.height * 0.85 - s.y) / s.height;
  const fx0 = (p.x + p.width * 0.3 - s.x) / s.width; const fx1 = (p.x + p.width * 0.6 - s.x) / s.width;
  await fire(page, penLine(7, fx0, fx1, fy));
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const d = (await storedInk(page))[0].page.strokes[0].d;
  expect(Math.abs(d[1] / 10 - 1414 * 0.85)).toBeLessThan(2);
});

test('a whole page within a hair of the page width is the same view: the level button is off there, and brings a zoomed page back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    try { localStorage.setItem('svrz_pad_full', '1'); } catch { /* private mode */ }
    // An iPhone: no fullscreen API, the sheet's own fullscreen layout is the
    // whole feature, and Safari's toolbar changes the height under it. (A
    // browser in real fullscreen would not let the window be resized here.)
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => false });
  });
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await expect(sheet(page)).toHaveAttribute('data-full', 'true');
  // In fullscreen the stage grows with the window's height one for one. The
  // window is made as tall as puts the whole page at 0.997 of the width
  // (about 390 × 810): inside the snap, so the page width opens as the whole
  // page and the two are one view.
  const s0 = await box(page, 'stage');
  const target = 16 + ((s0.width - 16) / 1000) * 1414 * 0.997;
  await page.setViewportSize({ width: 390, height: Math.round(844 - s0.height + target) });
  await expect.poll(async () => Math.abs((await box(page, 'stage')).height - target)).toBeLessThan(1);
  const s = await box(page, 'stage');
  const min = ((s.height - 16) / 1414) / ((s.width - 16) / 1000);
  expect(min).toBeGreaterThan(0.995);
  expect(min).toBeLessThan(0.999);
  const level = sheet(page).getByTestId('ink-zoom');
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  await expect(level).toHaveAccessibleName(/^100 % — (Seitenbreite|Page width)$/);
  // It was on, and a tap did nothing: the page width snapped back to this view.
  await expect(level).toBeDisabled();
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await expect(level).toBeEnabled();
  await expect(level).toHaveAccessibleName(/^150 % — (Seitenbreite|Page width)$/);
  await level.click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  await expect(level).toBeDisabled();
});

test.describe('the pen toolbar on an iPad, in German (its longest labels)', () => {
  test.use({ locale: 'de-CH' });
  // An iPad mini in portrait (744 wide) cut 'Finger' to 'F' once the zoom
  // group came in (final review, 24.10.2026). A 9.7" iPad upright is 768 wide,
  // its sheet 736; the last two are every larger iPad's sheet, 768 px wide,
  // with every label shown.
  for (const vp of [{ width: 744, height: 1133 }, { width: 768, height: 1024 }, { width: 820, height: 1180 }, { width: 1180, height: 820 }]) {
    test(`fits on one row at ${vp.width} × ${vp.height}, at the page width and at the whole page`, async ({ page }) => {
      await page.setViewportSize(vp);
      await stubSignedInApp(page);
      await page.goto('/');
      await openPenPage(page);
      const bar = sheet(page).getByRole('group', { name: /^Zoom$/ }).locator('xpath=..');
      const finger = sheet(page).getByRole('button', { name: /^(Finger)$/ });
      for (const view of ['page width', 'whole page']) {
        if (view === 'whole page') { await wholePage(page).click(); await expect(zoomOut(page)).toBeDisabled(); }
        const { client, scroll } = await bar.evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth }));
        expect(scroll, `${view}: ${scroll} px of toolbar in ${client}`).toBeLessThanOrEqual(client + 1);
        const b = (await bar.boundingBox())!; const f = (await finger.boundingBox())!;
        expect(f.x + f.width).toBeLessThanOrEqual(b.x + b.width + 0.5);
      }
    });
  }
});

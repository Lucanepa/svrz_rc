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
const wholePage = (page: Page) => sheet(page).getByRole('button', { name: /^(Ganze Seite|Whole page)$/ });

async function openPenPage(page: Page): Promise<void> {
  await launcher(page).click();
  await sheet(page).getByTestId('pad-new-ink').click();
  await expect(paper(page)).toBeVisible();
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

test('the zoom buttons: in, the whole page, out; the canvases never grow', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  const width = () => stage(page).locator('canvas').first().evaluate((c: HTMLCanvasElement) => c.width);
  const w0 = await width();
  await zoomIn(page).click();
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '2.25');
  expect(await width()).toBe(w0);
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
  await expect(sheet(page).getByText(/Mit zwei Fingern|Pinch with two fingers/)).toBeVisible();
  await zoomIn(page).click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await expect(sheet(page).getByText(/Mit zwei Fingern|Pinch with two fingers/)).toHaveCount(0);
  await fire(page, penLine(7, 0.3, 0.6, 0.5));
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  // The stroke made the page; the view she is writing in stayed.
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  await sheet(page).getByTestId('pad-new-ink').click();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
  const s = await box(page, 'stage');
  await expect.poll(async () => Math.abs((await box(page, 'paper')).y - (s.y + 8))).toBeLessThan(0.5);
  expect(await nonBlank(page)).toBe(false);
  await page.reload();
  await launcher(page).click();
  await expect(paper(page)).toBeVisible();
  await expect(stage(page)).toHaveAttribute('data-zoom', '1.50');
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
  for (const view of ['fit-width', 'whole page']) {
    if (view === 'whole page') { await wholePage(page).click(); await expect(zoomOut(page)).toBeDisabled(); }
    const p = await box(page, 'paper');
    expect(Math.abs(p.width / p.height - 1000 / 1414)).toBeLessThan(0.002);
  }
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

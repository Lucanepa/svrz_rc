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

test('a stroke written while the newer server copy of its page is on the way stays: on screen, in IndexedDB and in the push', async ({ page }) => {
  // Another device wrote on the page; the pull says so and its strokes are
  // fetched, slowly (a gym). The coach goes on writing meanwhile. That stroke
  // used to vanish: the sheet's next read shared the fetch that started
  // before it, and the server's strokes replaced the page.
  const at = suiteNow() - 60_000;
  const id = `${RC.id}|page-ink-race`;
  const mine = { c: 0, w: 4, p: 0, d: [1000, 2000, 0, 0, 3000, 0, 0, 16] };
  const row = { id, schema: 1, ownerId: RC.id, pageId: 'page-ink-race', kind: 'ink', title: '', text: '', bg: '', points: 2, usedIn: [], createdAt: at, updatedAt: at, deleted: false, dirty: false, savedAt: new Date(at).toISOString(), rejectedReason: '' };
  await page.addInitScript(([db, r, ink]) => {
    const open = indexedDB.open(db, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('pages')) open.result.createObjectStore('pages', { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains('ink')) open.result.createObjectStore('ink', { keyPath: 'id' });
    };
    open.onsuccess = () => {
      const d = open.result;
      const tx = d.transaction(['pages', 'ink'], 'readwrite');
      tx.objectStore('pages').put(r);
      tx.objectStore('ink').put(ink);
      tx.oncomplete = () => d.close();
    };
  }, [PAD_DB, row, { id, ownerId: RC.id, page: { w: 1000, h: 1414, strokes: [mine] } }] as const);
  await stubSignedInApp(page);
  const server = { pageId: 'page-ink-race', kind: 'ink', bg: '', points: 1, createdAt: at, updatedAt: at + 1000, deleted: false, schema: 1, savedAt: new Date(at + 1000).toISOString() };
  let releaseIndex!: () => void;
  const indexGate = new Promise<void>((resolve) => { releaseIndex = resolve; });
  await page.route('**/api/notebook', async (r) => { await indexGate; await r.fulfill({ json: { ownerId: RC.id, pages: [server] } }); });
  let fetched = 0; let answered = false;
  let releaseInk!: () => void;
  const inkGate = new Promise<void>((resolve) => { releaseInk = resolve; });
  await page.route('**/api/notebook/pages/page-ink-race', async (r) => {
    fetched += 1;
    await inkGate;
    await r.fulfill({ json: { ownerId: RC.id, page: { ...server, ink: { w: 1000, h: 1414, strokes: [{ c: 0, w: 7, p: 0, d: [5000, 9000, 0, 0, 1000, 0, 0, 16] }] } } } });
    answered = true;
  });
  const pushed: number[] = [];
  await page.route('**/api/notebook/pages', async (r) => {
    const body = JSON.parse(r.request().postData() || '{"pages":[]}') as { pages: { pageId: string; updatedAt: number; createdAt: number; ink?: { strokes: unknown[] } }[] };
    for (const p of body.pages) if (p.ink) pushed.push(p.ink.strokes.length);
    await r.fulfill({ json: { ok: true, ownerId: RC.id, saved: body.pages.map((p) => ({ pageId: p.pageId, savedAt: new Date(suiteNow()).toISOString(), updatedAt: p.updatedAt, createdAt: p.createdAt })), stale: [], rejected: [] } });
  });
  await page.goto('/');
  await launcher(page).click();
  await expect(pad(page)).toBeVisible();
  await sheet(page).getByTestId('ink-zoom').click();
  // The pull answers: the server's copy is newer, and its strokes are asked for.
  releaseIndex();
  await expect.poll(() => fetched, SYNC).toBe(1);
  await mouseStroke(page, 0.1, 0.4, 0.5, 0.45);
  await page.waitForTimeout(300);
  releaseInk();
  await expect.poll(() => answered, SYNC).toBe(true);
  await page.waitForTimeout(500);
  await mouseStroke(page, 0.1, 0.6, 0.5, 0.65);
  const strokes = async () => (await storedInk(page)).find((i) => i.id === id)?.page.strokes;
  await expect.poll(async () => (await strokes())?.length, SYNC).toBe(3);
  expect((await strokes())!.map((st) => st.w)).toEqual([4, 4, 4]);
  await expect.poll(() => pushed[pushed.length - 1], { timeout: 15_000 }).toBe(3);
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
  await mouseStroke(page, 0.1, 0.2, 0.5, 0.25);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  /** In one go, so the 500 ms window is not the runner's: the pen on the page
   *  and whatever `after` names happening to Rückgängig. (One stroke ending
   *  per call: two in one synchronous go would end before the sheet renders
   *  the first, which no hand can do.) */
  const penThen = (after: 'tap-18.2' | 'tap-letter-between' | 'pen-tap' | 'hover-then-finger') => page.evaluate(async ([b, kind]) => {
    const target = document.querySelector('[data-testid="ink-stage"] canvas')!;
    const undo = [...document.querySelectorAll('button')].find((el) => /^(Rückgängig|Undo)$/.test(el.getAttribute('aria-label') || ''))!;
    const pen = (type: string, fx: number, buttons = type === 'pointerup' ? 0 : 1) => new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, buttons, pointerType: 'pen', pointerId: 7, pressure: buttons ? 0.4 : 0, clientX: b.x + b.width * fx, clientY: b.y + b.height * 0.5 });
    const touch = (type: string) => new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 30, width: 30, height: 30 });
    if (kind === 'tap-18.2' || kind === 'pen-tap') {
      target.dispatchEvent(pen('pointerdown', 0.2));
      target.dispatchEvent(pen('pointermove', 0.4));
      window.dispatchEvent(pen('pointerup', 0.4));
    }
    if (kind === 'tap-18.2') {
      // iPadOS Safari 18.2 and later: the tap's click is a PointerEvent that
      // says 'mouse' (WebKit bug 282988).
      undo.dispatchEvent(touch('pointerdown'));
      undo.dispatchEvent(touch('pointerup'));
      undo.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    } else if (kind === 'tap-letter-between') {
      // Safari before 18.2 (a MouseEvent click), and the pen's next letter
      // starts between the palm landing and its click.
      undo.dispatchEvent(touch('pointerdown'));
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: 'pen', pointerId: 8, pressure: 0.4, clientX: b.x + b.width * 0.6, clientY: b.y + b.height * 0.5 }));
      target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: 'pen', pointerId: 8, pressure: 0.4, clientX: b.x + b.width * 0.7, clientY: b.y + b.height * 0.5 }));
      undo.dispatchEvent(touch('pointerup'));
      undo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 8, clientX: b.x + b.width * 0.7, clientY: b.y + b.height * 0.5 }));
    } else if (kind === 'pen-tap') {
      // The Pencil itself on the button is a deliberate tap, whatever the
      // click calls itself. (After a render: a tap a person makes comes in a
      // later task, when the sheet already holds the stroke.)
      await new Promise((resolve) => setTimeout(resolve, 30));
      undo.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 7, buttons: 1, pressure: 0.4 }));
      undo.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'pen', pointerId: 7 }));
      undo.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerType: 'mouse' }));
    } else {
      // The Pencil hovering over the page (an iPad Pro sees it before it
      // touches) while the other hand taps the button: that tap is meant.
      for (const fx of [0.3, 0.35, 0.4]) target.dispatchEvent(pen('pointermove', fx, 0));
      undo.dispatchEvent(touch('pointerdown'));
      undo.dispatchEvent(touch('pointerup'));
      undo.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, pointerType: 'touch' }));
    }
  }, [box, after] as const);
  const box = (await pad(page).boundingBox())!;
  const strokes = async () => (await storedInk(page))[0]?.page.strokes.length;

  // The palm lands on Rückgängig as the pen lifts: the stroke stays. (Had
  // the tap gone through, the stroke and the undo would reach IndexedDB in
  // one debounced write, and 2 would never be read.)
  await penThen('tap-18.2');
  await expect.poll(strokes, SYNC).toBe(2);
  await penThen('tap-letter-between');
  await expect.poll(strokes, SYNC).toBe(3);
  // The Pencil tapping Rückgängig right after writing undoes the stroke it just wrote.
  await penThen('pen-tap');
  await page.waitForTimeout(2_500);
  expect(await strokes()).toBe(3);
  // Once the pen has been off the page for a moment, a finger's tap is a tap
  // again, even with the Pencil hovering over the page.
  await page.waitForTimeout(600);
  await penThen('hover-then-finger');
  await expect.poll(strokes, SYNC).toBe(2);
  // A palm beside the sheet does not close it; a mouse click there does.
  const backdrop = sheet(page).locator('xpath=..');
  await backdrop.dispatchEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 32, width: 120, height: 120 });
  await backdrop.dispatchEvent('click');
  await page.waitForTimeout(200);
  await expect(sheet(page)).toBeVisible();
  await page.mouse.click(5, 5);
  await expect(sheet(page)).toHaveCount(0);
});

test('a real tap on Rückgängig right after the pen is the writing hand, a tap later is a tap', async ({ page, hasTouch }) => {
  test.skip(!hasTouch, 'A touch screen only');
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await mouseStroke(page, 0.1, 0.2, 0.5, 0.25);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const undo = sheet(page).getByRole('button', { name: /^(Rückgängig|Undo)$/ });
  await undo.scrollIntoViewIfNeeded();
  const u = (await undo.boundingBox())!;
  const p = (await pad(page).boundingBox())!;
  // A trusted tap: in WebKit its click says 'mouse', as on an iPad since 18.2.
  await page.evaluate(() => {
    const w = window as unknown as { __penUpAt: number; __clickAt: number };
    w.__clickAt = 0;
    document.addEventListener('click', () => { if (!w.__clickAt) w.__clickAt = performance.now(); }, true);
  });
  await page.evaluate((b) => {
    (window as unknown as { __penUpAt: number }).__penUpAt = performance.now();
    const target = document.querySelector('[data-testid="ink-stage"] canvas')!;
    const pen = (type: string, fx: number) => new PointerEvent(type, { bubbles: true, cancelable: true, isPrimary: true, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'pen', pointerId: 7, pressure: 0.4, clientX: b.x + b.width * fx, clientY: b.y + b.height * 0.5 });
    target.dispatchEvent(pen('pointerdown', 0.2));
    target.dispatchEvent(pen('pointermove', 0.4));
    window.dispatchEvent(pen('pointerup', 0.4));
  }, p);
  await page.touchscreen.tap(u.x + u.width / 2, u.y + u.height / 2);
  const gap = await page.evaluate(() => { const w = window as unknown as { __penUpAt: number; __clickAt: number }; return w.__clickAt - w.__penUpAt; });
  expect(gap, 'the tap must come within the 500 ms the guard holds').toBeLessThan(450);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await page.waitForTimeout(600);
  await page.touchscreen.tap(u.x + u.width / 2, u.y + u.height / 2);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
});

test('a pen page files one line of counts when it is left, never a coordinate', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openPenPage(page);
  await syntheticStroke(page, { pointerType: 'pen', pointerId: 7, pressure: 0.3 }, [[0.2, 0.2], [0.4, 0.3], [0.6, 0.35]]);
  await mouseStroke(page, 0.1, 0.6, 0.5, 0.7);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await sheet(page).getByRole('button', { name: /^(Schliessen|Close)$/ }).click();
  await expect(sheet(page)).toHaveCount(0);
  const lines = await page.evaluate(() => {
    const w = window as unknown as { svrzLogs?: () => { evt: string; data?: Record<string, unknown> }[] };
    return (w.svrzLogs ? w.svrzLogs() : []).filter((e) => e.evt === 'ink.page');
  });
  expect(lines).toHaveLength(1);
  const data = lines[0].data!;
  expect(data).toMatchObject({ pen: 1, mouse: 1, touch: 0, cancels: 0, pressureMedian: 0.3 });
  for (const v of Object.values(data)) expect(v === null || typeof v === 'number').toBe(true);
  expect(Object.keys(data).sort()).toEqual(['cancels', 'coalescedPerMove', 'mouse', 'palms', 'pen', 'penZeroStart', 'pressureMedian', 'slowFrameMs', 'touch', 'zoomMax'].sort());
});

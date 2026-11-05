import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * How the pen feels on the pen page (a coach's voice note, 05.11.2026: harder
 * to write on than GoodNotes "with the actual iPad pen").
 *
 * The live layer draws a short predicted tail ahead of the pen. The tail is
 * for the eye alone: it never reaches a sample, the stored stroke, the saved
 * page or the size guard, and it must not flick past a corner or the place the
 * pen stopped.
 *
 * Playwright has no stylus: pointer events are synthetic, and getPredictedEvents
 * is stubbed on each one. A gesture runs in ONE page.evaluate, and a 'read'
 * waits for the frame after it, so what is measured is what that frame drew.
 * Coordinates are CSS px from the stage's corner: the guards are distances on
 * screen, and every stroke here lies on the paper at fit-width.
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

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });

async function openPenPage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 820, height: 1180 });
  await stubSignedInApp(page);
  await page.goto('/');
  await launcher(page).click();
  await sheet(page).getByTestId('pad-new-page').click();
  await sheet(page).getByTestId('pad-side-ink').click();
  await expect(sheet(page).getByTestId('ink-stage')).toHaveAttribute('data-zoom', '1.00');
}

type Kind = 'pen' | 'touch' | 'mouse';
type Pointer = { kind?: Kind; id?: number; pressure?: number };
type Step =
  | (Pointer & { t: 'down' | 'move' | 'up' | 'cancel'; x: number; y: number; predicted?: [number, number][]; noApi?: boolean })
  /** The ink on a canvas, `frames` frames from now. */
  | { t: 'read'; frames?: number; canvas?: 'live' | 'page' };
type Ink = { left: number; right: number; top: number; bottom: number };

/** Fires the steps in one evaluate; returns what each 'read' saw (null: blank). */
function run(page: Page, steps: Step[]): Promise<(Ink | null)[]> {
  return page.evaluate(async (list) => {
    const stage = document.querySelector('[data-testid="ink-stage"]')!;
    const [pageCanvas, liveCanvas] = [...stage.querySelectorAll('canvas')];
    const r = stage.getBoundingClientRect();
    const read = (c: HTMLCanvasElement) => {
      const { data, width, height } = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
      const k = c.width / r.width;
      let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity;
      for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] < 64) continue;
        if (x < left) left = x;
        if (x + 1 > right) right = x + 1;
        if (y < top) top = y;
        if (y + 1 > bottom) bottom = y + 1;
      }
      return right < 0 ? null : { left: left / k, right: right / k, top: top / k, bottom: bottom / k };
    };
    const seen: ({ left: number; right: number; top: number; bottom: number } | null)[] = [];
    for (const s of list) {
      if (s.t === 'read') {
        for (let i = 0; i < (s.frames ?? 1); i += 1) await new Promise((done) => requestAnimationFrame(done));
        seen.push(read(s.canvas === 'page' ? pageCanvas : liveCanvas));
        continue;
      }
      const kind = s.kind ?? 'pen';
      const up = s.t === 'up' || s.t === 'cancel';
      const type = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' }[s.t];
      const at = (x: number, y: number) => ({ clientX: r.left + x, clientY: r.top + y });
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, isPrimary: true, pointerId: s.id ?? 7, pointerType: kind, buttons: up ? 0 : 1,
        width: kind === 'touch' ? 10 : 1, height: kind === 'touch' ? 10 : 1, pressure: s.pressure ?? (kind === 'pen' ? 0.4 : 0), ...at(s.x, s.y),
      });
      if (s.predicted) { const offered = s.predicted.map(([x, y]) => new PointerEvent('pointermove', at(x, y))); Object.defineProperty(ev, 'getPredictedEvents', { value: () => offered }); }
      if (s.noApi) Object.defineProperty(ev, 'getPredictedEvents', { value: undefined });
      (up ? window : liveCanvas.parentElement!.querySelector('canvas')!).dispatchEvent(ev);
    }
    return seen;
  }, steps);
}

/** Down at (100, y), `n` moves of `step` px to the right; the last one offers
 *  the prediction. The pen ends at x = 100 + n · step. */
function line(y: number, opts: { n?: number; step?: number; predicted?: (tip: number) => [number, number][]; pointer?: Pointer } = {}): Step[] {
  const n = opts.n ?? 6; const step = opts.step ?? 10;
  const out: Step[] = [{ t: 'down', x: 100, y, ...opts.pointer }];
  for (let i = 1; i <= n; i += 1) {
    const x = 100 + step * i;
    out.push({ t: 'move', x, y, ...opts.pointer, ...(i === n && opts.predicted ? { predicted: opts.predicted(x) } : {}) });
  }
  return out;
}
const lift = (x: number, y: number, pointer: Pointer = {}): Step => ({ t: 'up', x, y, ...pointer });

/** The x, y and pressure of each sample: a stroke but for its timing and where it starts. */
const shape = (d: number[]) => d.filter((_, i) => i !== 1 && i % 4 !== 3);

test('the tail draws ahead of the pen on the live layer, and is in neither the committed stroke nor the saved page', async ({ page }) => {
  await openPenPage(page);
  // The same line twice, the second with a tail on its last move.
  const [plain, liveAfterPlain] = await run(page, [...line(200), { t: 'read' }, lift(160, 200), { t: 'read' }]);
  const [tailed, liveAfterLift, committed] = await run(page, [...line(300, { predicted: (tip) => [[tip + 8, 300], [tip + 15, 300]] }), { t: 'read' }, lift(160, 300), { t: 'read' }, { t: 'read', canvas: 'page' }]);
  expect(tailed!.right - plain!.right).toBeGreaterThan(6);
  // Pen-up: the live layer is empty, and the line ends at the pen (the round
  // cap, no tail), though the live one ran past it.
  expect(liveAfterPlain).toBeNull();
  expect(liveAfterLift).toBeNull();
  expect(tailed!.right).toBeGreaterThan(165);
  expect(committed!.right).toBeLessThan(164);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  const [a, b] = (await storedInk(page))[0].page.strokes;
  expect(b.d.length).toBe(a.d.length);
  expect(shape(b.d)).toEqual(shape(a.d));
});

test('a mouse and a finger get the tail too, and an eraser never does', async ({ page }) => {
  await openPenPage(page);
  // No pen seen yet, so the finger draws.
  for (const [i, kind] of (['mouse', 'touch'] as const).entries()) {
    const pointer = { kind, id: 20 + i };
    const y = 200 + i * 100;
    const [plain] = await run(page, [...line(y, { pointer }), { t: 'read' }, lift(160, y, pointer)]);
    const [tailed] = await run(page, [...line(y + 50, { pointer, predicted: (tip) => [[tip + 8, y + 50], [tip + 15, y + 50]] }), { t: 'read' }, lift(160, y + 50, pointer)]);
    expect(tailed!.right - plain!.right, kind).toBeGreaterThan(6);
  }
  await sheet(page).getByRole('button', { name: /^(Radierer|Eraser)$/ }).click();
  const [erasing] = await run(page, [...line(600, { predicted: (tip) => [[tip + 8, 600]] }), { t: 'read' }, lift(160, 600)]);
  expect(erasing).toBeNull();
});

test.describe('the tail never runs away from the pen', () => {
  test('past twice the last move it is cut, and only from there on', async ({ page }) => {
    await openPenPage(page);
    // A slow pen: the last move covered 5 px, so 10 px of tail at most, well
    // inside the limit on screen.
    const slow = { n: 12, step: 5 };
    const [plain] = await run(page, [...line(200, slow), { t: 'read' }, lift(160, 200)]);
    const [far] = await run(page, [...line(250, { ...slow, predicted: (tip) => [[tip + 13, 250]] }), { t: 'read' }, lift(160, 250)]);
    const [both] = await run(page, [...line(300, { ...slow, predicted: (tip) => [[tip + 8, 300], [tip + 13, 300]] }), { t: 'read' }, lift(160, 300)]);
    expect(Math.abs(far!.right - plain!.right)).toBeLessThan(0.6);
    expect(both!.right - plain!.right).toBeGreaterThan(3);
    expect(both!.right).toBeLessThan(160 + 13);
  });

  test('past a few mm on screen it is cut, however fast the pen', async ({ page }) => {
    await openPenPage(page);
    // 30 px a move: twice that would allow 60 px, the screen limit allows 16.
    const [plain] = await run(page, [...line(200, { step: 30 }), { t: 'read' }, lift(280, 200)]);
    const [far] = await run(page, [...line(250, { step: 30, predicted: (tip) => [[tip + 25, 250]] }), { t: 'read' }, lift(280, 250)]);
    const [near] = await run(page, [...line(300, { step: 30, predicted: (tip) => [[tip + 14, 300]] }), { t: 'read' }, lift(280, 300)]);
    expect(Math.abs(far!.right - plain!.right)).toBeLessThan(0.6);
    expect(near!.right - plain!.right).toBeGreaterThan(4);
  });

  test('heading back the way the pen came it is cut; turning a corner it is not', async ({ page }) => {
    await openPenPage(page);
    const [plain] = await run(page, [...line(200), { t: 'read' }, lift(160, 200)]);
    // Within reach, but behind the pen: the flick past a corner it just turned.
    const [back] = await run(page, [...line(250, { predicted: (tip) => [[tip - 6, 260]] }), { t: 'read' }, lift(160, 250)]);
    const [turn] = await run(page, [...line(300, { predicted: (tip) => [[tip, 312]] }), { t: 'read' }, lift(160, 300)]);
    expect(Math.abs((back!.bottom - 250) - (plain!.bottom - 200))).toBeLessThan(0.6);
    expect((turn!.bottom - 300) - (plain!.bottom - 200)).toBeGreaterThan(4);
  });

  test('an i-dot has no tail: a pen that has not moved predicts nothing', async ({ page }) => {
    await openPenPage(page);
    const y = 200;
    const [dot, plainDot] = await run(page, [
      { t: 'down', x: 100, y }, { t: 'move', x: 100, y, predicted: [[108, y], [114, y]] }, { t: 'read' }, lift(100, y),
      { t: 'down', x: 100, y: y + 50 }, { t: 'move', x: 100, y: y + 50 }, { t: 'read' }, lift(100, y + 50),
    ]);
    expect(dot!.right - dot!.left).toBeCloseTo(plainDot!.right - plainDot!.left, 0);
    expect(dot!.right).toBeLessThan(106);
    await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
    expect((await storedInk(page))[0].page.strokes[0].d).toHaveLength(4);
  });

  test('a pen that stops: the tail is gone within a few frames, and the next move brings a new one', async ({ page }) => {
    await openPenPage(page);
    const [plain] = await run(page, [...line(200), { t: 'read' }, lift(160, 200)]);
    const [first, stopped, again] = await run(page, [
      ...line(300, { predicted: (tip) => [[tip + 8, 300], [tip + 15, 300]] }),
      { t: 'read' },
      { t: 'read', frames: 4 },
      { t: 'move', x: 170, y: 300, predicted: [[178, 300], [185, 300]] },
      { t: 'read' },
      lift(170, 300),
    ]);
    expect(first!.right - plain!.right).toBeGreaterThan(6);
    expect(Math.abs(stopped!.right - plain!.right)).toBeLessThan(0.6);
    expect(again!.right).toBeGreaterThan(first!.right);
  });

  test('a cancelled pen stroke keeps its samples and no tail; a dropped finger stroke leaves nothing', async ({ page }) => {
    await openPenPage(page);
    // No pen yet, so the finger draws: a second finger right after it makes a
    // pinch, and the stroke goes with its tail. No read before that second
    // finger: under load it would take longer than the 250 ms it must land in.
    const finger = { kind: 'touch' as const, id: 21 };
    const [dropped] = await run(page, [
      ...line(500, { pointer: finger, predicted: (tip) => [[tip + 8, 500]] }),
      { t: 'down', x: 400, y: 500, kind: 'touch', id: 22 }, { t: 'read' },
      { t: 'up', x: 160, y: 500, kind: 'touch', id: 21 }, { t: 'up', x: 400, y: 500, kind: 'touch', id: 22 },
    ]);
    expect(dropped).toBeNull();
    expect(await storedInk(page)).toHaveLength(0);
    const [plain] = await run(page, [...line(200), { t: 'read' }, lift(160, 200)]);
    const [cancelled] = await run(page, [...line(300, { predicted: (tip) => [[tip + 8, 300], [tip + 15, 300]] }), { t: 'cancel', x: 160, y: 300 }, { t: 'read' }]);
    expect(cancelled).toBeNull();
    await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
    const [a, b] = (await storedInk(page))[0].page.strokes;
    expect(shape(b.d)).toEqual(shape(a.d));
    expect(plain).not.toBeNull();
  });
});

test('the size guard never sees the tail: a page\'s worth of predicted points fills nothing', async ({ page }) => {
  await openPenPage(page);
  // Every sample takes at least 9 characters of JSON, so these would be past
  // the 800 000 a page may hold, were they ever a part of the stroke.
  const many = Array.from({ length: 100_000 }, (_, i): [number, number] => [160 + (15 * i) / 100_000, 200]);
  await run(page, [...line(200, { predicted: () => many }), { t: 'read' }, lift(160, 200)]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  await expect(page.getByText(/Seite voll|Page full/)).toHaveCount(0);
  expect((await storedInk(page))[0].page.strokes[0].d.length).toBeLessThanOrEqual(4 * 7);
});

test('a browser without the API draws its real samples alone', async ({ page }) => {
  await openPenPage(page);
  const steps = line(200).map((s) => (s.t === 'move' ? { ...s, noApi: true } : s));
  const [ink] = await run(page, [...steps, { t: 'read' }, lift(160, 200)]);
  expect(ink).not.toBeNull();
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(1);
  const errors = await page.evaluate(() => {
    const w = window as unknown as { svrzLogs?: () => { lvl: string; evt: string }[] };
    return (w.svrzLogs ? w.svrzLogs() : []).filter((e) => e.lvl === 'error' && e.evt === 'js.error');
  });
  expect(errors).toEqual([]);
});

test('the page line counts what the browser offered and what was drawn, for the pen only', async ({ page }) => {
  await openPenPage(page);
  // Two offered on every pen move, the second always out of reach.
  const pen: Step[] = [{ t: 'down', x: 100, y: 200 }];
  for (let i = 1; i <= 4; i += 1) pen.push({ t: 'move', x: 100 + 10 * i, y: 200, predicted: [[100 + 10 * i + 5, 200], [100 + 10 * i + 200, 200]] });
  const mouse = { kind: 'mouse' as const, id: 30 };
  await run(page, [...pen, lift(140, 200), { t: 'read' }, ...line(300, { pointer: mouse, predicted: (tip) => [[tip + 5, 300]] }), lift(160, 300, mouse)]);
  await expect.poll(async () => (await storedInk(page))[0]?.page.strokes.length, SYNC).toBe(2);
  await sheet(page).getByRole('button', { name: /^(Schliessen|Close)$/ }).click();
  await expect(sheet(page)).toHaveCount(0);
  const lines = await page.evaluate(() => {
    const w = window as unknown as { svrzLogs?: () => { evt: string; data?: Record<string, unknown> }[] };
    return (w.svrzLogs ? w.svrzLogs() : []).filter((e) => e.evt === 'ink.page');
  });
  expect(lines).toHaveLength(1);
  expect(lines[0].data).toMatchObject({ pen: 1, mouse: 1, predictedPerMove: 2, predictedDrawnPerMove: 1 });
});

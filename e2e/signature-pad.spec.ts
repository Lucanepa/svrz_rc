import { test, expect, type ElementHandle, type Locator, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, signatureDialog } from './support/app';

/**
 * The signature dialog on an iPad (Jennifer, 23.10.2026: "as soon as your hand
 * touches outside the signature field, it deletes the writing and closes the
 * field" — with the Pencil and with a finger, over and over).
 *
 * The dialog closes only on "Save signature" or an explicit discard; the
 * backdrop does nothing. The pad follows one pointer at a time and the Pencil
 * first: a palm on the pad draws nothing and does not cut the pen's stroke, a
 * finger tap on a button while the Pencil writes is ignored. Synthetic pointer
 * events cannot reproduce iPadOS's own palm handling, so a check on a real
 * iPad stays part of the release.
 */

const PEN = { pointerType: 'pen', pointerId: 7, pressure: 0.3, isPrimary: true };
const rcSig = (page: Page) => page.getByAltText(/^(Referee Coach signature|Unterschrift Referee Coach)$/);
const refereeSig = (page: Page) => page.getByAltText(/^(Referee signature|Unterschrift Schiedsrichter)$/);
const pad = (page: Page) => signatureDialog(page).locator('canvas');
const saveButton = (page: Page) => signatureDialog(page).getByRole('button', { name: /^(Save signature|Unterschrift speichern)$/ });
const confirmBox = (page: Page) => page.getByTestId('confirm-dialog');

async function openSign(page: Page, who: 'referee' | 'rc') {
  await page.getByRole('button', { name: /^(Sign|Unterschreiben|Sign again|Neu unterschreiben)$/ }).nth(who === 'referee' ? 0 : 1).click();
  await expect(pad(page)).toBeVisible();
}

/** Opaque pixels on the whole pad. */
async function inkCount(page: Page): Promise<number> {
  return pad(page).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n += 1;
    return n;
  });
}

/** Any ink within a few CSS px of a point given as fractions of the pad. */
async function inkAt(page: Page, fx: number, fy: number, r = 5): Promise<boolean> {
  return pad(page).evaluate((c: HTMLCanvasElement, [x, y, rr]) => {
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const k = c.width / c.getBoundingClientRect().width;
    const cx = Math.round(c.width * x); const cy = Math.round(c.height * y); const d = Math.round(rr * k);
    const { data } = ctx.getImageData(Math.max(0, cx - d), Math.max(0, cy - d), d * 2, d * 2);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  }, [fx, fy, r] as const);
}

/** One synthetic pointer event at a pad fraction; up and cancel go to window,
 *  where the pad listens for them. */
async function ptr(page: Page, type: string, init: Record<string, unknown>, fx: number, fy: number) {
  const box = (await pad(page).boundingBox())!;
  const ev = { bubbles: true, cancelable: true, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, ...init, clientX: box.x + box.width * fx, clientY: box.y + box.height * fy };
  if (type === 'pointerup' || type === 'pointercancel') {
    await page.evaluate(([t, b]) => { window.dispatchEvent(new PointerEvent(t as string, b as PointerEventInit)); }, [type, ev] as const);
  } else {
    await pad(page).dispatchEvent(type, ev);
  }
}

async function stroke(page: Page, init: Record<string, unknown>, points: [number, number][], lift = true) {
  await ptr(page, 'pointerdown', init, ...points[0]);
  for (const p of points.slice(1)) await ptr(page, 'pointermove', init, ...p);
  if (lift) await ptr(page, 'pointerup', init, ...points[points.length - 1]);
}

/** One step of a burst: a pointer event on the pad (up and cancel go to
 *  window), an event on a named element, or a pause. */
type Step =
  | { pad: string; init: Record<string, unknown>; at: [number, number] }
  | { el: string; type: string; init?: Record<string, unknown> }
  | { wait: number };

const padSteps = (init: Record<string, unknown>, points: [number, number][], lift = true): Step[] => [
  { pad: 'pointerdown', init, at: points[0] },
  ...points.slice(1).map((at): Step => ({ pad: 'pointermove', init, at })),
  ...(lift ? [{ pad: 'pointerup', init, at: points[points.length - 1] } as Step] : []),
];

/**
 * Runs the steps inside the page, back to back. The pad's time windows (500 ms
 * after the pen, 1000 ms for the palm purge) are then measured against what
 * the steps say, not against Playwright round trips, which under a loaded
 * runner took longer than a second (the purge test failed that way).
 */
async function burst(page: Page, steps: Step[], els: Record<string, Locator> = {}) {
  const handles: Record<string, ElementHandle> = {};
  for (const [key, locator] of Object.entries(els)) handles[key] = (await locator.elementHandle())!;
  const canvas = (await pad(page).elementHandle())!;
  await page.evaluate(async ({ canvas, steps, handles }) => {
    const r = (canvas as Element).getBoundingClientRect();
    for (const s of steps) {
      if ('wait' in s) { await new Promise((done) => setTimeout(done, s.wait)); continue; }
      if ('pad' in s) {
        const up = s.pad === 'pointerup' || s.pad === 'pointercancel';
        const ev = new PointerEvent(s.pad, { bubbles: true, cancelable: true, buttons: up ? 0 : 1, ...s.init, clientX: r.left + r.width * s.at[0], clientY: r.top + r.height * s.at[1] });
        (up ? window : canvas as Element).dispatchEvent(ev);
        continue;
      }
      const el = handles[s.el] as Element;
      const b = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, ...s.init, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 };
      el.dispatchEvent(s.type === 'click' ? new MouseEvent('click', init) : new PointerEvent(s.type, init));
    }
  }, { canvas, steps, handles });
}

const line = (y: number, from = 0.1, to = 0.9, n = 10): [number, number][] =>
  Array.from({ length: n + 1 }, (_, i) => [from + ((to - from) * i) / n, y] as [number, number]);

async function mouseStroke(page: Page, fromX = 0.1, toX = 0.9, y = 0.5) {
  const box = (await pad(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * fromX, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * toX, box.y + box.height * (y - 0.15), { steps: 10 });
  await page.mouse.up();
}

/** Width and height from a PNG data URL's IHDR. */
function pngSize(dataUrl: string): { width: number; height: number } {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await stubSignedInApp(page);
});
test.afterEach(() => {
  // Synthetic pointers have no capture; the pad must not throw for them.
  expect(pageErrors).toEqual([]);
});

test.describe('closing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await openFeedbackForm(page);
    await openSign(page, 'rc');
  });

  test('the dialog has a name, and a click on the backdrop leaves it open with its ink', async ({ page }) => {
    await expect(page.getByRole('dialog', { name: /^(Referee Coach signature|Unterschrift Referee Coach)$/ })).toBeVisible();
    await mouseStroke(page);
    const before = await inkCount(page);
    expect(before).toBeGreaterThan(0);
    await page.mouse.click(5, 5);
    const panel = (await signatureDialog(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    if (panel.y + panel.height + 12 < viewport.height) await page.mouse.click(viewport.width / 2, panel.y + panel.height + 8);
    await expect(signatureDialog(page)).toBeVisible();
    expect(await inkCount(page)).toBe(before);
  });

  test('× with ink asks first: "Keep signing" keeps the ink, "Discard" closes and the pad starts empty', async ({ page }) => {
    await mouseStroke(page);
    const before = await inkCount(page);
    await signatureDialog(page).getByRole('button', { name: /^(Close|Schliessen)$/ }).click();
    await expect(confirmBox(page)).toBeVisible();
    await expect(page.getByTestId('confirm-title')).toHaveText(/^(Discard the signature\?|Unterschrift verwerfen\?)$/);
    await page.getByTestId('confirm-cancel').click();
    await expect(confirmBox(page)).toHaveCount(0);
    await expect(signatureDialog(page)).toBeVisible();
    expect(await inkCount(page)).toBe(before);

    await signatureDialog(page).getByRole('button', { name: /^(Close|Schliessen)$/ }).click();
    await expect(page.getByTestId('confirm-accept')).toHaveText(/^(Discard|Verwerfen)$/);
    await page.getByTestId('confirm-accept').click();
    await expect(signatureDialog(page)).toHaveCount(0);
    await expect(rcSig(page)).toHaveCount(0);

    await openSign(page, 'rc');
    expect(await inkCount(page)).toBe(0);
    await expect(saveButton(page)).toBeDisabled();
  });

  test('Cancel with ink asks too, and Discard closes', async ({ page }) => {
    await mouseStroke(page);
    await signatureDialog(page).getByRole('button', { name: /^(Cancel|Abbrechen)$/ }).click();
    await expect(page.getByTestId('confirm-cancel')).toHaveText(/^(Keep signing|Weiter unterschreiben)$/);
    await page.getByTestId('confirm-accept').click();
    await expect(signatureDialog(page)).toHaveCount(0);
  });

  test('Escape with ink asks; a second Escape answers "keep signing"', async ({ page }) => {
    await mouseStroke(page);
    const before = await inkCount(page);
    await page.keyboard.press('Escape');
    await expect(confirmBox(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirmBox(page)).toHaveCount(0);
    await expect(signatureDialog(page)).toBeVisible();
    expect(await inkCount(page)).toBe(before);
  });

  test('an empty pad closes at once, with ×, Cancel or Escape', async ({ page }) => {
    await signatureDialog(page).getByRole('button', { name: /^(Close|Schliessen)$/ }).click();
    await expect(signatureDialog(page)).toHaveCount(0);
    await expect(confirmBox(page)).toHaveCount(0);
    await openSign(page, 'rc');
    await signatureDialog(page).getByRole('button', { name: /^(Cancel|Abbrechen)$/ }).click();
    await expect(signatureDialog(page)).toHaveCount(0);
    await openSign(page, 'rc');
    await page.keyboard.press('Escape');
    await expect(signatureDialog(page)).toHaveCount(0);
    await expect(confirmBox(page)).toHaveCount(0);
  });
});

test.describe('a touch on the backdrop', () => {
  test.use({ hasTouch: true });
  test('a tap beside the panel, where the hand rests, leaves the dialog and its ink alone', async ({ page }) => {
    await page.goto('/');
    await openFeedbackForm(page);
    await openSign(page, 'rc');
    await mouseStroke(page);
    const before = await inkCount(page);
    // Away from the panel by more than a fingertip: Chromium moves a fat tap
    // onto the nearest clickable element within its radius.
    await page.touchscreen.tap(4, 4);
    const panel = (await signatureDialog(page).boundingBox())!;
    const viewport = page.viewportSize()!;
    if (panel.y + panel.height + 40 < viewport.height) await page.touchscreen.tap(viewport.width / 2, panel.y + panel.height + 30);
    await page.waitForTimeout(300);
    await expect(signatureDialog(page)).toBeVisible();
    expect(await inkCount(page)).toBe(before);
  });

  test('a deliberate finger tap on Save, once the pen has rested, saves', async ({ page }) => {
    await page.goto('/');
    await openFeedbackForm(page);
    await openSign(page, 'rc');
    await stroke(page, PEN, line(0.4));
    await page.waitForTimeout(600);
    const box = (await saveButton(page).boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(signatureDialog(page)).toHaveCount(0);
    await expect(rcSig(page)).toBeVisible();
  });
});

test.describe('the pen and the palm', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await openFeedbackForm(page);
    await openSign(page, 'rc');
  });

  test('a palm landing mid-stroke draws no line into the pen stroke, and its lift does not end it', async ({ page }) => {
    await stroke(page, PEN, line(0.2, 0.1, 0.3, 4), false);
    // The heel of the hand lands bottom right, wide as a palm.
    const palm = { pointerType: 'touch', pointerId: 20, isPrimary: false, width: 120, height: 120 };
    await ptr(page, 'pointerdown', palm, 0.9, 0.9);
    await ptr(page, 'pointermove', PEN, 0.35, 0.2);
    await ptr(page, 'pointerup', palm, 0.9, 0.9);
    for (const p of line(0.2, 0.4, 0.9, 5)) await ptr(page, 'pointermove', PEN, ...p);
    await ptr(page, 'pointerup', PEN, 0.9, 0.2);
    // Nothing on the line from the palm to the pen, nothing under the palm…
    expect(await inkAt(page, 0.625, 0.55)).toBe(false);
    expect(await inkAt(page, 0.9, 0.9)).toBe(false);
    // …and the pen's stroke went on to the end.
    expect(await inkAt(page, 0.2, 0.2)).toBe(true);
    expect(await inkAt(page, 0.8, 0.2)).toBe(true);
  });

  test('a pointerup from another pointer anywhere on screen does not end the pen stroke', async ({ page }) => {
    await stroke(page, PEN, line(0.3, 0.1, 0.4, 4), false);
    await page.evaluate(() => { window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, pointerType: 'touch', bubbles: true })); });
    for (const p of line(0.3, 0.45, 0.9, 5)) await ptr(page, 'pointermove', PEN, ...p);
    await ptr(page, 'pointerup', PEN, 0.9, 0.3);
    expect(await inkAt(page, 0.8, 0.3)).toBe(true);
  });

  test('the hand that came down before the pen leaves no ink: neither a finished touch stroke nor one still on the glass', async ({ page }) => {
    const touch = { pointerType: 'touch', pointerId: 30, isPrimary: true, width: 30, height: 30 };
    await burst(page, [
      // A touch stroke that finished just before the first pen-down…
      ...padSteps(touch, line(0.8, 0.1, 0.5, 4)),
      // …and one still on the glass when the pen lands.
      ...padSteps({ ...touch, pointerId: 31 }, line(0.6, 0.1, 0.5, 4), false),
      ...padSteps(PEN, line(0.2)),
      { pad: 'pointerup', init: { ...touch, pointerId: 31 }, at: [0.5, 0.6] },
    ]);
    expect(await inkAt(page, 0.3, 0.8)).toBe(false);
    expect(await inkAt(page, 0.3, 0.6)).toBe(false);
    expect(await inkAt(page, 0.5, 0.2)).toBe(true);
    await expect(signatureDialog(page).getByText(/^(Pen detected – only the pen writes\.|Stift erkannt – nur der Stift schreibt\.)$/)).toBeVisible();
    // Undo takes back the pen stroke, not the palm's ink back.
    await signatureDialog(page).getByRole('button', { name: /^(Undo|Rückgängig)$/ }).click();
    expect(await inkCount(page)).toBe(0);
  });

  test('after the pen, a finger draws only with "Finger too"', async ({ page }) => {
    await stroke(page, PEN, line(0.2));
    await page.waitForTimeout(600);
    const finger = { pointerType: 'touch', pointerId: 40, isPrimary: true, width: 30, height: 30 };
    await stroke(page, finger, line(0.7));
    expect(await inkAt(page, 0.5, 0.7)).toBe(false);
    const toggle = signatureDialog(page).getByRole('button', { name: /^(Finger too|Auch mit Finger)$/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(600);
    await stroke(page, { ...finger, pointerId: 41 }, line(0.7));
    expect(await inkAt(page, 0.5, 0.7)).toBe(true);
  });

  test('a cancelled pen stroke keeps its ink, and the hovering pen afterwards draws nothing', async ({ page }) => {
    await stroke(page, PEN, line(0.5, 0.1, 0.4, 4), false);
    await ptr(page, 'pointercancel', PEN, 0.4, 0.5);
    // Hover (buttons 0), as an M2 iPad Pro reports the Pencil above the glass.
    for (const p of line(0.3, 0.6, 0.9, 4)) await ptr(page, 'pointermove', { ...PEN, buttons: 0, pressure: 0 }, ...p);
    await page.waitForTimeout(100);
    expect(await inkAt(page, 0.25, 0.5)).toBe(true);
    expect(await inkAt(page, 0.75, 0.3)).toBe(false);
    expect(await inkAt(page, 0.5, 0.4)).toBe(false);
  });

  // The touches below land while a pen stroke is still down, so the pad is
  // busy however long the runner takes between steps; waits only ever make a
  // pause longer than it has to be.
  test('a finger tap on Save while the pen writes is the palm and is ignored; a pen tap saves', async ({ page }) => {
    const save = saveButton(page);
    await stroke(page, PEN, line(0.4));
    await expect(save).toBeEnabled();
    await burst(page, [
      ...padSteps({ ...PEN, pointerId: 8 }, line(0.6), false),
      { el: 'save', type: 'pointerdown', init: { pointerType: 'touch', pointerId: 50, isPrimary: false } },
      { el: 'save', type: 'pointerup', init: { pointerType: 'touch', pointerId: 50, isPrimary: false } },
      { el: 'save', type: 'click' },
      { pad: 'pointerup', init: { ...PEN, pointerId: 8 }, at: [0.9, 0.6] },
    ], { save });
    await expect(signatureDialog(page)).toBeVisible();
    await expect(rcSig(page)).toHaveCount(0);
    await burst(page, [
      { el: 'save', type: 'pointerdown', init: { pointerType: 'pen', pointerId: 7, isPrimary: true } },
      { el: 'save', type: 'click' },
    ], { save });
    await expect(signatureDialog(page)).toHaveCount(0);
    await expect(rcSig(page)).toBeVisible();
  });
});

test('a finger signs alone in a fresh dialog, right after the coach used the pen', async ({ page }) => {
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  await stroke(page, PEN, line(0.4));
  await saveButton(page).click();
  await expect(rcSig(page)).toBeVisible();

  await page.waitForTimeout(600);
  await openSign(page, 'referee');
  await expect(saveButton(page)).toBeDisabled();
  await stroke(page, { pointerType: 'touch', pointerId: 60, isPrimary: true, width: 40, height: 40 }, line(0.5, 0.1, 0.9, 12));
  expect(await inkAt(page, 0.5, 0.5)).toBe(true);
  await saveButton(page).click();
  await expect(refereeSig(page)).toBeVisible();
});

test('the saved image is the ink cropped, a PNG small enough for every limit, and the log gets counts only', async ({ page }) => {
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  const canvasWidth = await pad(page).evaluate((c: HTMLCanvasElement) => c.width);
  // Across the middle 40 % of the pad.
  await stroke(page, PEN, [[0.3, 0.5], [0.4, 0.45], [0.5, 0.55], [0.6, 0.45], [0.7, 0.5]]);
  await saveButton(page).click();
  const src = (await rcSig(page).getAttribute('src'))!;
  expect(src).toMatch(/^data:image\/png;base64,/);
  expect(src.length).toBeLessThan(240_000);
  const { width, height } = pngSize(src);
  expect(width).toBeLessThanOrEqual(1400);
  expect(width).toBeLessThan(canvasWidth);
  expect(width).toBeLessThan(0.75 * 1200);   // the full pad's width at the same scale
  expect(height).toBeGreaterThanOrEqual(0.4 * 400 * 1.2 - 1);
  expect(height).toBeLessThan(width);

  const saved = await page.evaluate(() => {
    const w = window as unknown as { svrzLogs?: () => { evt: string; data?: Record<string, unknown> }[] };
    return (w.svrzLogs ? w.svrzLogs() : []).filter((e) => e.evt === 'sig.saved');
  });
  expect(saved).toHaveLength(1);
  expect(saved[0].data).toMatchObject({ target: 'rc', pen: 1, touch: 0, mouse: 0, penLock: true, fingerToo: false, cancels: 0 });
  expect(JSON.stringify(saved[0])).not.toMatch(/data:image|clientX|pts/);
});

test('Back while signing closes the dialog; the same form signed again has the ink back, the other one not', async ({ page }) => {
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  await mouseStroke(page);
  const before = await inkCount(page);
  await page.evaluate(() => history.back());
  await expect(signatureDialog(page)).toHaveCount(0);
  await page.evaluate(() => history.forward());
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();

  await openSign(page, 'referee');
  expect(await inkCount(page)).toBe(0);
  await signatureDialog(page).getByRole('button', { name: /^(Close|Schliessen)$/ }).click();
  await expect(signatureDialog(page)).toHaveCount(0);

  await openSign(page, 'rc');
  await expect.poll(() => inkCount(page)).toBe(before);
  await expect(saveButton(page)).toBeEnabled();
  await saveButton(page).click();
  await expect(rcSig(page)).toBeVisible();
});

test('Back while the discard question is open takes the question along, keeps the ink and leaves the page scrollable', async ({ page }) => {
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  await mouseStroke(page);
  const before = await inkCount(page);
  await signatureDialog(page).getByRole('button', { name: /^(Close|Schliessen)$/ }).click();
  await expect(confirmBox(page)).toBeVisible();
  await page.evaluate(() => history.back());
  await expect(signatureDialog(page)).toHaveCount(0);
  await expect(confirmBox(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [document.documentElement.style.overflow, document.body.style.overflow])).toEqual(['', '']);

  await page.evaluate(() => history.forward());
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
  await openSign(page, 'rc');
  await expect.poll(() => inkCount(page)).toBe(before);
});

test('the pad is there at once while the phone hand-off is still starting, and its arrival keeps the ink', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/signature/start', async (route) => { await gate; await route.fulfill({ json: { slug: 'sig-test' } }); });
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  await expect(signatureDialog(page).getByText(/Waiting for signature|Warte auf Unterschrift/)).toHaveCount(0);
  await mouseStroke(page);
  const before = await inkCount(page);
  release();
  await expect(signatureDialog(page).getByText(/Waiting for signature|Warte auf Unterschrift/)).toBeVisible();
  expect(await inkCount(page)).toBe(before);
  await saveButton(page).click();
  await expect(rcSig(page)).toBeVisible();
});

test('offline, the dialog does not wait for the phone hand-off: the pad shows at once and signing works', async ({ page }) => {
  const started: string[] = [];
  await page.route('**/api/signature/start', (r) => { started.push(r.request().method()); return r.fulfill({ json: { slug: 'sig-test' } }); });
  await page.goto('/');
  await openFeedbackForm(page);
  // The app's own offline signal, without taking the network away: a request
  // it still tried would reach the route above and be counted.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await openSign(page, 'rc');
  await expect(signatureDialog(page).getByText(/offline/)).toBeVisible();
  expect(started).toEqual([]);
  await mouseStroke(page);
  await saveButton(page).click();
  await expect(rcSig(page)).toBeVisible();
});

test('a late answer from an earlier open does not take over the dialog that is open now', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/signature/start', async (route) => {
    calls += 1;
    if (calls === 1) { await new Promise((r) => setTimeout(r, 1500)); await route.fulfill({ json: { slug: 'stale' } }); return; }
    await route.fulfill({ json: { slug: 'fresh' } });
  });
  const polled: string[] = [];
  await page.route(/\/api\/signature\/(stale|fresh)$/, (route) => {
    polled.push(route.request().url().split('/').pop()!);
    return route.fulfill({ json: { context: '', signer: '', signed: false, data: '' } });
  });
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  await signatureDialog(page).getByRole('button', { name: /^(Close|Schliessen)$/ }).click();
  await openSign(page, 'rc');
  await expect.poll(() => polled.length, { timeout: 8000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1000);
  expect(new Set(polled)).toEqual(new Set(['fresh']));
});

test('a signature made on the phone closes the dialog, says so, and drops the half-drawn one here', async ({ page }) => {
  const PHONE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let signed = false;
  await page.route('**/api/signature/sig-test', (route) => route.fulfill({
    json: { context: '', signer: '', signed, data: signed ? PHONE : '' },
  }));
  await page.goto('/');
  await openFeedbackForm(page);
  await openSign(page, 'rc');
  await mouseStroke(page);
  signed = true;
  await expect(signatureDialog(page)).toHaveCount(0, { timeout: 8000 });
  await expect(rcSig(page)).toHaveAttribute('src', PHONE);
  await expect(page.getByText(/^(Signature taken from the phone\.|Unterschrift vom Handy übernommen\.)$/)).toBeVisible();
  signed = false;
  await openSign(page, 'rc');
  expect(await inkCount(page)).toBe(0);
});

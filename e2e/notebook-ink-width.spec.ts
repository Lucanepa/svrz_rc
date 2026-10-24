import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * How wide a Pencil line draws (Jennifer, 23.10.2026: "other software gives
 * me a clear line with the iPad pen"). Measured, not computed: a horizontal
 * stroke is drawn and one column of the page canvas is read across it, its
 * alpha summed — the line's width in CSS px, antialiasing included.
 *
 * On an iPad in portrait the sheet opens a page at fit-width, and normal
 * handwriting (Safari reports a Pencil's pressure at about 0.1–0.35) must be
 * a clear line there. Shown whole, in landscape, the page is under 300 px
 * wide, and no line may vanish to a hairline.
 *
 * The floor that keeps that line is in page units, from the stage's
 * whole-page scale, and recomputed only when the stage changes size (every
 * cached outline depends on it). So at fit-width in landscape, where the
 * whole page is smallest, the floor shows: light handwriting draws at about
 * 3.2 px instead of 2.2–2.9. That is pinned below, as accepted, until a
 * product decision says otherwise.
 */

test.use({ deviceScaleFactor: 2 });

const launcher = (page: Page) => page.getByRole('button', { name: /^(Notizblock öffnen|Open the notebook)$/ });
const sheet = (page: Page) => page.getByRole('dialog', { name: /^(Notizblock|Notebook)$/ });
const stage = (page: Page) => sheet(page).getByTestId('ink-stage');
const paper = (page: Page) => sheet(page).getByTestId('ink-page');

async function openPenPage(page: Page, viewport: { width: number; height: number }, whole: boolean): Promise<void> {
  await page.setViewportSize(viewport);
  await stubSignedInApp(page);
  await page.goto('/');
  await launcher(page).click();
  await sheet(page).getByTestId('pad-new-ink').click();
  await expect(paper(page)).toBeVisible();
  if (whole) {
    await sheet(page).getByRole('button', { name: /(Ganze Seite|Whole page)$/ }).click();
    await expect(sheet(page).getByRole('button', { name: /^(Verkleinern|Zoom out)$/ })).toBeDisabled();
  } else {
    await expect(stage(page)).toHaveAttribute('data-zoom', '1.00');
  }
}

/** A straight stroke across the middle of the page at `fy` of the STAGE's
 *  height, every event at the same pressure (pen) or fast (mouse). */
async function stroke(page: Page, kind: 'pen' | 'mouse', fy: number, pressure: number, id: number): Promise<void> {
  await page.evaluate(([k, y, p, pid]) => {
    const st = document.querySelector('[data-testid="ink-stage"]')!;
    const pa = st.querySelector('[data-testid="ink-page"]')!.getBoundingClientRect();
    const r = st.getBoundingClientRect();
    const left = Math.max(r.left, pa.left); const right = Math.min(r.right, pa.right);
    const target = st.querySelector('canvas')!;
    const at = (f: number) => ({ clientX: left + (right - left) * f, clientY: r.top + r.height * y });
    const base = { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: k, pointerId: pid, pressure: k === 'pen' ? p : 0.5 };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...at(0.15) }));
    for (let i = 1; i <= 24; i += 1) target.dispatchEvent(new PointerEvent('pointermove', { ...base, ...at(0.15 + (0.7 * i) / 24) }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...base, buttons: 0, pressure: 0, ...at(0.85) }));
  }, [kind, fy, pressure, id] as const);
}

/** The line's width in CSS px where it crosses the middle of the page. */
async function widthAt(page: Page, fy: number): Promise<number> {
  return stage(page).locator('canvas').first().evaluate((c: HTMLCanvasElement, y: number) => {
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const st = c.parentElement!.getBoundingClientRect();
    const pa = c.parentElement!.querySelector('[data-testid="ink-page"]')!.getBoundingClientRect();
    const k = c.width / st.width;
    const x = Math.round(((Math.max(st.left, pa.left) + Math.min(st.right, pa.right)) / 2 - st.left) * k);
    const yc = Math.round(st.height * y * k);
    const { data } = ctx.getImageData(x, yc - 40, 1, 81);
    let alpha = 0;
    for (let i = 3; i < data.length; i += 4) alpha += data[i] / 255;
    return alpha / k;
  }, fy);
}

test('an iPad in portrait, at fit-width: light handwriting is a clear line, a firm press a bolder one', async ({ page }) => {
  await openPenPage(page, { width: 820, height: 1180 }, false);
  const rows: [number, number][] = [[0.15, 0.1], [0.3, 0.2], [0.45, 0.3], [0.6, 0.5], [0.75, 1]];
  for (const [i, [fy, p]] of rows.entries()) await stroke(page, 'pen', fy, p, 10 + i);
  const widths = new Map<number, number>();
  for (const [fy, p] of rows) widths.set(p, await widthAt(page, fy));
  const seen = JSON.stringify(Object.fromEntries([...widths].map(([p, w]) => [p, +w.toFixed(2)])));
  expect(widths.get(0.2)!, seen).toBeGreaterThanOrEqual(2.2);
  expect(widths.get(0.5)!, seen).toBeGreaterThan(2.6);
  expect(widths.get(0.5)!, seen).toBeLessThan(3.6);
  // Pressure still shows: light, normal and firm are not one width.
  expect(widths.get(0.1)!, seen).toBeLessThan(widths.get(0.5)!);
  expect(widths.get(0.5)!, seen).toBeLessThan(widths.get(1)!);
});

test('an iPad in landscape, at fit-width: the same scale as portrait, light lines raised by the whole-page floor', async ({ page }) => {
  await openPenPage(page, { width: 1180, height: 820 }, false);
  const rows: [number, number][] = [[0.15, 0.1], [0.35, 0.2], [0.55, 0.5], [0.75, 1]];
  for (const [i, [fy, p]] of rows.entries()) await stroke(page, 'pen', fy, p, 10 + i);
  await stroke(page, 'mouse', 0.9, 0, 1);
  const widths = new Map<number, number>();
  for (const [fy, p] of rows) widths.set(p, await widthAt(page, fy));
  const mouse = await widthAt(page, 0.9);
  const seen = `${JSON.stringify(Object.fromEntries([...widths].map(([p, w]) => [p, +w.toFixed(2)])))} mouse ${mouse.toFixed(2)}`;
  // Measured when accepted: 3.13 / 3.25 / 3.5 / 4.25, the mouse 3.25.
  for (const w of [...widths.values(), mouse]) expect(w, seen).toBeGreaterThanOrEqual(2.9);
  expect(widths.get(0.1)!, seen).toBeLessThan(3.5);
  expect(widths.get(0.5)!, seen).toBeLessThan(3.9);
  // The firm end is untouched by the floor: pressure still shows there.
  expect(widths.get(0.1)!, seen).toBeLessThan(widths.get(1)!);
  expect(widths.get(0.5)!, seen).toBeLessThan(widths.get(1)!);
});

test('an iPad in landscape, the whole page on screen: no line thinner than about 1.2 px', async ({ page }) => {
  await openPenPage(page, { width: 1180, height: 820 }, true);
  const rows: [number, 'pen' | 'mouse', number][] = [[0.2, 'pen', 0.02], [0.4, 'pen', 0.1], [0.6, 'mouse', 0], [0.8, 'pen', 0.3]];
  for (const [i, [fy, kind, p]] of rows.entries()) await stroke(page, kind, fy, p, kind === 'mouse' ? 1 : 10 + i);
  const widths: number[] = [];
  for (const [fy] of rows) widths.push(await widthAt(page, fy));
  const seen = JSON.stringify(widths.map((w) => +w.toFixed(2)));
  for (const w of widths) expect(w, seen).toBeGreaterThanOrEqual(1.15);
});

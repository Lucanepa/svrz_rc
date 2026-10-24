import { test, expect, type Page } from '@playwright/test';
import { EDGE_PROBE_ROUTE } from './support/app';

/**
 * The page a referee signs on when the coach shows the QR code or sends the
 * link (#/sign/<slug>). It uses the same pad as the coach's dialog, so the
 * same Pencil and palm rules apply; its data URL goes through the server's
 * 256 kB JSON parser, and a failed send must not cost the strokes.
 */

const SLUG = 'pageTest1';
const pad = (page: Page) => page.locator('canvas');
const confirmButton = (page: Page) => page.getByRole('button', { name: /Bestätigen \/ Confirm/ });

async function inkCount(page: Page): Promise<number> {
  return pad(page).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n += 1;
    return n;
  });
}

async function mouseStroke(page: Page, y = 0.5) {
  const box = (await pad(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * (y - 0.2), { steps: 10 });
  await page.mouse.up();
}

async function penStroke(page: Page) {
  const box = (await pad(page).boundingBox())!;
  const at = (fx: number, fy: number) => ({ clientX: box.x + box.width * fx, clientY: box.y + box.height * fy });
  const base = { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: 'pen', pointerId: 7, pressure: 0.25 };
  await pad(page).dispatchEvent('pointerdown', { ...base, ...at(0.1, 0.6) });
  for (let i = 1; i <= 12; i++) await pad(page).dispatchEvent('pointermove', { ...base, ...at(0.1 + 0.07 * i, 0.6 - 0.25 * Math.sin(i / 2)) });
  await page.evaluate((b) => { window.dispatchEvent(new PointerEvent('pointerup', b)); }, { ...base, buttons: 0, ...at(0.94, 0.5) });
}

async function touchStroke(page: Page, y: number, pointerId: number) {
  const box = (await pad(page).boundingBox())!;
  const at = (fx: number) => ({ clientX: box.x + box.width * fx, clientY: box.y + box.height * y });
  const base = { bubbles: true, cancelable: true, isPrimary: true, buttons: 1, pointerType: 'touch', pointerId, width: 30, height: 30 };
  await pad(page).dispatchEvent('pointerdown', { ...base, ...at(0.1) });
  for (let i = 1; i <= 8; i++) await pad(page).dispatchEvent('pointermove', { ...base, ...at(0.1 + 0.1 * i) });
  await page.evaluate((b) => { window.dispatchEvent(new PointerEvent('pointerup', b)); }, { ...base, buttons: 0, ...at(0.9) });
}

/** Routes the page's two signature calls; POSTs answer with `status()`. */
async function stubSession(page: Page, status: () => number = () => 200) {
  const posted: { data: string; signer: string }[] = [];
  await page.route('**/api/**', (r) => r.fulfill({ json: [] }));
  await page.route(EDGE_PROBE_ROUTE, (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: 'ok\n' }));
  await page.route(`**/api/signature/${SLUG}`, async (route) => {
    if (route.request().method() === 'POST') {
      const code = status();
      if (code === 200) posted.push(route.request().postDataJSON());
      await route.fulfill(code === 200 ? { json: { ok: true } } : { status: code, json: { error: 'nope' } });
      return;
    }
    await route.fulfill({ json: { context: 'Volley Wiedikon – VBC Test · 2L · 1. SR Anna Muster', signer: 'Anna Muster', signed: false, data: '' } });
  });
  return posted;
}

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
});
test.afterEach(() => { expect(pageErrors).toEqual([]); });

test('a referee signs with a finger or a mouse, can undo and clear, and Confirm sends a PNG', async ({ page }) => {
  const posted = await stubSession(page);
  await page.goto(`/#/sign/${SLUG}`);
  await expect(pad(page)).toBeVisible();
  await expect(page.getByPlaceholder('Name')).toHaveValue('Anna Muster');
  await expect(confirmButton(page)).toBeDisabled();

  // The pad keeps its distance from the Name field (Scribble claims Pencil
  // strokes near an editable element) and has the 5:2 shape of the coach's.
  const input = (await page.getByPlaceholder('Name').boundingBox())!;
  const box = (await pad(page).boundingBox())!;
  expect(box.y - (input.y + input.height)).toBeGreaterThanOrEqual(16);
  expect(box.width / box.height).toBeGreaterThan(2.4);
  expect(box.width / box.height).toBeLessThan(2.6);

  await mouseStroke(page, 0.4);
  const one = await inkCount(page);
  await mouseStroke(page, 0.8);
  expect(await inkCount(page)).toBeGreaterThan(one);
  await page.getByRole('button', { name: /Rückgängig \/ Undo/ }).click();
  expect(await inkCount(page)).toBe(one);
  await page.getByRole('button', { name: /Löschen \/ Clear/ }).click();
  expect(await inkCount(page)).toBe(0);
  await expect(confirmButton(page)).toBeDisabled();
  // Undo right after Clear brings the strokes back.
  await page.getByRole('button', { name: /Rückgängig \/ Undo/ }).click();
  expect(await inkCount(page)).toBe(one);

  await confirmButton(page).click();
  await expect(page.getByText('Unterschrift gespeichert.')).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0].signer).toBe('Anna Muster');
  expect(posted[0].data).toMatch(/^data:image\/png;base64,/);
  expect(posted[0].data.length).toBeLessThan(240_000);
});

test('a Pencil signature is sent like any other', async ({ page }) => {
  const posted = await stubSession(page);
  await page.goto(`/#/sign/${SLUG}`);
  await expect(pad(page)).toBeVisible();
  await penStroke(page);
  expect(await inkCount(page)).toBeGreaterThan(0);
  await confirmButton(page).click();
  await expect(page.getByText('Unterschrift gespeichert.')).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0].data).toMatch(/^data:image\/png;base64,/);
});

test('a send that fails keeps the strokes, and Confirm again sends them', async ({ page }) => {
  let code = 500;
  const posted = await stubSession(page, () => code);
  await page.goto(`/#/sign/${SLUG}`);
  await expect(pad(page)).toBeVisible();
  await mouseStroke(page);
  const before = await inkCount(page);
  await confirmButton(page).click();
  await expect(page.getByText(/Could not save — please confirm again\./)).toBeVisible();
  expect(await inkCount(page)).toBe(before);
  await expect(confirmButton(page)).toBeEnabled();

  code = 200;
  await confirmButton(page).click();
  await expect(page.getByText('Unterschrift gespeichert.')).toBeVisible();
  expect(posted).toHaveLength(1);
});

// A pen on the referee's device (an S Pen, a Pencil) locks the pad to the pen,
// as in the coach's dialog. Before, nothing said so and nothing undid it: a
// finger stroke after any pen contact was refused in silence (24.10.2026).
test('after a pen, the page says only the pen draws, and "Finger too" above the pad lets a finger sign', async ({ page }) => {
  await stubSession(page);
  await page.goto(`/#/sign/${SLUG}`);
  await expect(pad(page)).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Auch mit Finger / Finger too' });
  await expect(toggle).toHaveCount(0);
  const before = (await pad(page).boundingBox())!;
  await penStroke(page);
  await expect(page.getByText(/Stift erkannt — nur der Stift zeichnet\.\s*Pen detected — only the pen draws\./)).toBeVisible();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveAttribute('title', 'Finger zeichnet auch / Finger draws too');
  // In the row above the pad, and the pad did not move when it appeared.
  const box = (await pad(page).boundingBox())!;
  expect(Math.abs(box.y - before.y)).toBeLessThan(0.5);
  expect((await toggle.boundingBox())!.y + (await toggle.boundingBox())!.height).toBeLessThanOrEqual(box.y);
  await expect(confirmButton(page)).toBeInViewport();
  expect(await confirmButton(page).evaluate((b) => [...b.querySelectorAll('span')].every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);

  await page.waitForTimeout(600);
  const pen = await inkCount(page);
  await touchStroke(page, 0.85, 40);
  expect(await inkCount(page)).toBe(pen);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(600);
  await touchStroke(page, 0.85, 41);
  expect(await inkCount(page)).toBeGreaterThan(pen);
});

test.describe('on a 360 px phone', () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test('with the finger switch in the row, Confirm keeps its whole label and nothing scrolls sideways', async ({ page }) => {
    await stubSession(page);
    await page.goto(`/#/sign/${SLUG}`);
    await expect(pad(page)).toBeVisible();
    await penStroke(page);
    await expect(page.getByRole('button', { name: 'Auch mit Finger / Finger too' })).toBeVisible();
    expect(await confirmButton(page).evaluate((b) => [...b.querySelectorAll('span')].every((el) => el.scrollWidth <= el.clientWidth))).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});

import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, openOptions, fillWholeForm, signOpenPad } from './support/app';

/**
 * The coach's own signature (Luca, 23.10.2026).
 *
 * Once a coach has signed a filed report, the server keeps that signature and
 * the next form starts with it in the coach's box — unless the coach turned
 * that off under Optionen. It stands in, it is not written into the form: a
 * coach who signs anew covers it, one who takes it off a report sees the box
 * empty again. And the signature dialog closes the moment the ink is on the
 * form, whatever the network is doing (22.10.2026: a minute in a gym, tapped
 * again and again).
 */

// A 1×1 PNG: what the server hands back is a data URL like any pad's.
const KEPT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const rcSig = (page: Page) => page.getByAltText(/^(Referee Coach signature|Unterschrift Referee Coach)$/);
const remembered = (page: Page) => page.getByText(/^(Remembered signature|Gemerkte Unterschrift)$/);
const removeButtons = (page: Page) => page.getByRole('button', { name: /^(Remove|Entfernen)$/ });

async function keptOnServer(page: Page, kept: { enabled: boolean; data: string }) {
  const puts: unknown[] = [];
  await page.route('**/api/rc/signature', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as { enabled: boolean };
      puts.push(body);
      kept = { enabled: body.enabled, data: body.enabled ? kept.data : '' };
    }
    await route.fulfill({ json: kept });
  });
  return puts;
}

async function captureSend(page: Page): Promise<Record<string, unknown>[]> {
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/feedback/submit', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: 'fb-1', emailSent: true } });
  });
  await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
    json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
  }));
  return posted;
}

test.slow();

test('a remembered signature stands in the coach\'s box and goes out with the report', async ({ page }) => {
  await stubSignedInApp(page);
  await keptOnServer(page, { enabled: true, data: KEPT });
  const posted = await captureSend(page);
  await page.goto('/');
  await openFeedbackForm(page);

  await expect(rcSig(page)).toHaveAttribute('src', KEPT);
  await expect(remembered(page)).toBeVisible();

  // Fill everything, then take the coach's fresh ink off again: the
  // remembered one is what is left, and it is enough to send.
  await fillWholeForm(page);
  await expect(remembered(page)).toHaveCount(0);
  await removeButtons(page).nth(1).click();
  await expect(rcSig(page)).toHaveAttribute('src', KEPT);

  await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
  await page.getByRole('button', { name: /^(Speichern|Save)$/ }).last().click();
  await expect.poll(() => posted.length, { timeout: 15000 }).toBe(1);
  expect((posted[0].formData as { rcSignature: string }).rcSignature).toBe(KEPT);
});

test('taken off a report it stays off, and the report asks for the coach\'s signature', async ({ page }) => {
  await stubSignedInApp(page);
  await keptOnServer(page, { enabled: true, data: KEPT });
  await page.goto('/');
  await openFeedbackForm(page);
  await expect(remembered(page)).toBeVisible();

  await removeButtons(page).last().click();
  await expect(rcSig(page)).toHaveCount(0);
  await expect(remembered(page)).toHaveCount(0);

  await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
  await expect(page.getByText(/Referee Coach|Referee-Coach/).filter({ hasText: /signature|Unterschrift/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Speichern|Save)$/ })).toHaveCount(0);
});

test('Optionen turns it off: the server is told, and the next form starts empty', async ({ page }) => {
  await stubSignedInApp(page);
  const puts = await keptOnServer(page, { enabled: true, data: KEPT });
  await page.goto('/');

  await openOptions(page);
  const option = page.getByTestId('option-keep-signature');
  await expect(option).toHaveAttribute('aria-pressed', 'true');
  await option.click();
  await page.getByRole('button', { name: /^(Stop remembering|Nicht mehr merken)$/ }).click();
  await expect(option).toHaveAttribute('aria-pressed', 'false');
  expect(puts).toEqual([{ enabled: false }]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /^(Options|Optionen)$/ })).toHaveCount(0);

  await openFeedbackForm(page);
  await expect(rcSig(page)).toHaveCount(0);
});

test('the signature dialog closes at once, however long the server takes', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/signature/start', (r) => r.fulfill({ json: { slug: 'slow-gym' } }));
  const relayed: string[] = [];
  await page.route('**/api/signature/slow-gym', async (route) => {
    if (route.request().method() === 'POST') { relayed.push('post'); return; }   // never answered
    await route.fulfill({ json: { context: '', signer: '', signed: false, data: '' } });
  });
  await page.goto('/');
  await openFeedbackForm(page);

  await page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }).nth(1).click();
  await signOpenPad(page);
  await expect(page.getByRole('button', { name: /Save signature|Unterschrift speichern/ })).toHaveCount(0, { timeout: 1500 });
  await expect(rcSig(page)).toBeVisible();
  // The copy for a phone that scanned the QR still goes, in the background.
  await expect.poll(() => relayed.length).toBe(1);
});

test('both signature lines sit at one height, the refusal beside the referee\'s label', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium', 'side by side only where there is room');
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);

  const cells = page.locator('[data-missing], .border-x.border-b > div').filter({ has: page.getByRole('button', { name: /^(Sign|Unterschreiben)$/ }) });
  await expect(cells).toHaveCount(2);
  const line = async (i: number) => (await cells.nth(i).locator('.border-b.border-stone-400').boundingBox())!;
  const [referee, coach] = [await line(0), await line(1)];
  expect(Math.abs(referee.y + referee.height - (coach.y + coach.height))).toBeLessThan(1);

  const refuse = (await page.getByRole('button', { name: /^(Referee refuses to sign|SR verweigert Unterschrift)$/ }).boundingBox())!;
  const label = (await cells.nth(0).getByRole('heading').boundingBox())!;
  // On the label's row, at the right — above the line, not under it.
  expect(refuse.y + refuse.height).toBeLessThanOrEqual(referee.y);
  expect(refuse.x).toBeGreaterThan(label.x + label.width);
});

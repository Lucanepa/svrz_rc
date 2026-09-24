import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, fillWholeForm } from './support/app';

/**
 * The referee's PDF is in the language they read — asked at the top of the
 * form, German unless changed — whatever language the coach works in. The
 * stored report stays German: it is what the Statistik and the forms folder
 * read.
 */

const langGroup = (page: Page) => page.getByRole('group', { name: /Sprache des PDF|Language of the referee/ });
/** The words on the PDF, as a reader extracts them. */
async function pdfText(b64: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(Buffer.from(b64, 'base64')) }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    out.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return out.join('\n');
}

async function sendAndCapture(page: Page): Promise<Record<string, unknown>> {
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/feedback/submit', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: 'fb-1', emailSent: true } });
  });
  await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
    json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
  }));
  await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
  await page.getByRole('button', { name: /^(Speichern|Save)$/ }).last().click();
  await expect.poll(() => posted.length, { timeout: 15000 }).toBe(1);
  return posted[0];
}

// Each test fills the whole form, builds the PDF and sends it: more than the
// default 30 s on a CI runner, like the other full-send specs.
test.slow();

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await openFeedbackForm(page);
});

test('German by default', async ({ page }) => {
  await expect(langGroup(page).getByRole('button', { name: 'DE' })).toHaveAttribute('aria-pressed', 'true');
  await fillWholeForm(page);
  const body = await sendAndCapture(page);
  expect(await pdfText(String(body.pdfBase64))).toContain('SR-ZIEL');
});

test('English when chosen — the PDF only; the stored report stays German', async ({ page }) => {
  await langGroup(page).getByRole('button', { name: 'EN' }).click();
  await expect(langGroup(page).getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
  await fillWholeForm(page);
  const body = await sendAndCapture(page);
  const pdf = await pdfText(String(body.pdfBase64));
  expect(pdf).toContain('REFEREE GOAL');
  expect(pdf).not.toContain('SR-ZIEL');
  expect((body.formData as { lang: string }).lang).toBe('DE');
});

test('the ambition ticks are independent and go out with the report', async ({ page }) => {
  const promo = page.getByRole('button', { name: /^(Will befördert werden|Wants to be promoted)$/ });
  const cand = page.getByRole('button', { name: /^(Kandidat:in nächste Saison|Next year's candidates)$/ });
  await promo.click();
  await cand.click();
  await expect(promo).toHaveAttribute('aria-pressed', 'true');
  await expect(cand).toHaveAttribute('aria-pressed', 'true');
  await cand.click();
  await expect(cand).toHaveAttribute('aria-pressed', 'false');

  await fillWholeForm(page);
  const body = await sendAndCapture(page);
  const results = (body.formData as { results: Record<string, string> }).results;
  expect(results.wantsPromotion).toBe('Y');
  expect(results.wantsCandidate || '').toBe('');
});

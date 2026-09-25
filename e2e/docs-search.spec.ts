import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * "Nützliche Infos & Dokumente" on Home: every section folds and starts closed
 * on a new device, so the page does not end in a long scroll of cards. A
 * section opened stays open on this device. The search box looks through
 * titles and notes in both languages and opens whatever matches.
 */

const docsSearch = (page: import('@playwright/test').Page) => page.getByRole('searchbox', { name: /Dokumente durchsuchen|Search documents/ });

test('sections start closed, open on a tap, and stay open after a reload', async ({ page }) => {
  await stubSignedInApp(page, { keepDocsDefault: true });
  await page.goto('/');
  const rules = page.getByRole('button', { name: /^(Regeln|Rules)\s*\d+$/ });
  await expect(rules).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: /Offizielle Volleyball-Regeln|Official volleyball rules/ })).toHaveCount(0);

  await rules.click();
  await expect(rules).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /Offizielle Volleyball-Regeln|Official volleyball rules/ })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('button', { name: /Offizielle Volleyball-Regeln|Official volleyball rules/ })).toBeVisible();
});

test('the search finds a document in a closed section, in either language', async ({ page }) => {
  await stubSignedInApp(page, { keepDocsDefault: true });
  await page.goto('/');
  // The German title, whatever language the app is in.
  await docsSearch(page).fill('Gebührenordnung');
  await expect(page.getByRole('link', { name: /Gebührenordnung|fee/i }).or(page.getByRole('button', { name: /Gebührenordnung|fee/i })).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Offizielle Volleyball-Regeln|Official volleyball rules/ })).toHaveCount(0);

  await docsSearch(page).fill('zzzz-nothing');
  // Nothing in a title, and — once the text search is through — nothing inside either.
  await expect(page.getByText(/In keinem Dokument gefunden|Not found in any document/)).toBeVisible({ timeout: 30_000 });

  await docsSearch(page).fill('');
  await expect(page.getByRole('button', { name: /^(Regeln|Rules)\s*\d+$/ })).toHaveAttribute('aria-expanded', 'false');
});

/** Puts one of our own PDFs on the device, as "Alle offline speichern" would. */
async function storeDoc(page: import('@playwright/test').Page, path: string) {
  await page.evaluate(async (p) => {
    const res = await fetch(p);
    const cache = await caches.open('svrz-docs-v1');
    await cache.put(p, new Response(await res.arrayBuffer(), { headers: { 'Content-Type': 'application/pdf' } }));
  }, path);
}

test('the search looks inside the documents on this device, and a hit opens the reader there', async ({ page }) => {
  await stubSignedInApp(page, { keepDocsDefault: true });
  await page.goto('/');
  await storeDoc(page, '/docs/Leitfaden-SR-Technik.pdf');
  // "Netzoberkante" is in the guide's text, nowhere in a title or note.
  await docsSearch(page).fill('Netzoberkante');
  const results = page.getByTestId('doc-text-results');
  await expect(results.getByText(/Leitfaden SR-Technik|Refereeing technique guide/)).toBeVisible({ timeout: 20_000 });
  await expect(results.locator('mark').first()).toHaveText(/Netzoberkante/i);
  // The rest were not stored, so they were searched by title only — and it says so.
  await expect(results.getByText(/nur im Titel|by title only/)).toBeVisible({ timeout: 30_000 });

  await results.getByRole('button', { name: /^(S\.|p\.) \d+/ }).first().click();
  await expect(page.locator('#pdf-search')).toHaveValue('Netzoberkante');
});

test('"Dokumente beilegen" has the same search, inside the text too', async ({ page }) => {
  await stubSignedInApp(page);
  await page.goto('/');
  await storeDoc(page, '/docs/Leitfaden-SR-Technik.pdf');
  await page.goto('/form/2345678/1sr');
  const box = page.getByTestId('attach-docs');
  await box.getByRole('button', { name: /Dokumente auswählen|Choose documents/ }).click();
  const search = box.getByRole('searchbox', { name: /Beilagen durchsuchen|Search enclosures/ });
  await search.fill('Netzoberkante');
  await expect(box.getByText(/Leitfaden SR-Technik|Refereeing technique guide/)).toBeVisible({ timeout: 20_000 });
  await expect(box.locator('mark').first()).toHaveText(/Netzoberkante/i);
  // A title search narrows the list too.
  await search.fill('Gebührenordnung');
  await expect(box.getByText(/Gebührenordnung \(GBO\)|Fee schedule \(GBO\)/)).toBeVisible();
  await expect(box.getByText(/Leitfaden SR-Technik|Refereeing technique guide/)).toHaveCount(0);
});

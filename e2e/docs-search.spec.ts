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
  await expect(page.getByText(/Nichts gefunden|Nothing found/)).toBeVisible();

  await docsSearch(page).fill('');
  await expect(page.getByRole('button', { name: /^(Regeln|Rules)\s*\d+$/ })).toHaveAttribute('aria-expanded', 'false');
});

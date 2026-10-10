import { test, expect } from '@playwright/test';
import { USEFUL_DOCS } from '../src/lib/usefulDocs';
import { INFOS_AUDIENCE_OF } from '../src/lib/infosAudience';

/**
 * The public /infos page, sorted by who a document is for, most useful first
 * (Luca, 2026-10-09): new referees, regional referees, then everyone incl.
 * the national level, with the usual topics inside each.
 */

const PUBLIC = USEFUL_DOCS.filter((d) => d.kind !== 'form' && d.kind !== 'video');

test.describe('the table', () => {
  test('every public document says who it is for', () => {
    // A new document has to be placed, not dropped at the bottom by default.
    expect(PUBLIC.filter((d) => !INFOS_AUDIENCE_OF[d.id]).map((d) => d.id)).toEqual([]);
  });

  test('no entry names a document that is not on the page', () => {
    const ids = new Set(PUBLIC.map((d) => d.id));
    expect(Object.keys(INFOS_AUDIENCE_OF).filter((id) => !ids.has(id))).toEqual([]);
  });
});

test.describe('the page', () => {
  test('new referees first, then regional, then national', async ({ page }) => {
    await page.goto('/infos/de');
    await expect(page.getByRole('heading', { level: 2 })).toHaveText([
      'Neu als Schiedsrichter:in',
      'Regionale Schiedsrichter:innen',
      'Alle Schiedsrichter:innen · nationale Stufe',
    ]);
    await expect(page.locator('[data-audience="new"]')).toContainText('Kurzzusammenfassung für SR');
    await expect(page.locator('[data-audience="regional"]')).toContainText('Reglement der Unparteiischen');
    await expect(page.locator('[data-audience="all"]')).toContainText('LAS-Bestimmungen');
    // The national material is not in the newcomers' section.
    await expect(page.locator('[data-audience="new"]')).not.toContainText('LAS-Bestimmungen');
  });

  test('a search keeps the sections, and drops the ones with nothing left', async ({ page }) => {
    await page.goto('/infos/en');
    await page.getByRole('searchbox').fill('LAS');
    await expect(page.locator('[data-audience="all"]')).toContainText('LAS');
    await expect(page.locator('[data-audience="new"]')).toHaveCount(0);
  });

  test('a topic folds inside its own section only', async ({ page }) => {
    await page.goto('/infos/de');
    const contactsNew = page.locator('[data-audience="new"]').getByRole('button', { name: /^Kontakte/ });
    const contactsRegional = page.locator('[data-audience="regional"]').getByRole('button', { name: /^Kontakte/ });
    await contactsNew.click();
    await expect(contactsNew).toHaveAttribute('aria-expanded', 'false');
    await expect(contactsRegional).toHaveAttribute('aria-expanded', 'true');
  });
});

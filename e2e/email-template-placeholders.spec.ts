import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubSignedInApp } from './support/app';

// Placeholders, three ways in: a chip click, typing `{{` and picking from the
// list, or typing the braces out. In the field they read as pills showing the
// bare name — the braces are still in the text (the overlay must trace the
// textarea character for character) but painted transparent. An English
// console offers English names; both sets render.

const DE = { subject: 'Betreff', heading: '', intro: 'Hallo {{vorname}}', outro: 'Grüsse' };
const B = { ...DE, headingEn: '', introEn: 'Hello {{firstName}}', outroEn: 'Regards' };
const PH_DE = ['vorname', 'name', 'coach', 'coachVorname', 'datum'];
const PH_EN = ['firstName', 'name', 'coach', 'coachFirstName', 'date'];

async function openEmails(page: Page, lang: 'DE' | 'EN') {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/email-templates', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({
      json: {
        feedback: B, reminder: B, survey: DE,
        defaults: { feedback: B, reminder: B, survey: DE },
        reminder_enabled: false,
        placeholders: { feedback: PH_DE, reminder: PH_DE, survey: PH_DE },
        placeholdersEn: { feedback: PH_EN, reminder: PH_EN, survey: PH_EN },
        accepted: { feedback: [...PH_DE, ...PH_EN], reminder: [...PH_DE, ...PH_EN], survey: [...PH_DE, ...PH_EN] },
      },
    });
  });
  await page.goto('/admin/emails');
  if (lang === 'EN') await page.getByRole('button', { name: 'DE', exact: true }).click();
  await page.locator('textarea.tpl-field').first().waitFor();
}

/** The body field of the reminder editor, German half. */
const body = (page: Page) => page.locator('textarea[data-tpl-kind="reminder"][data-tpl-field="intro"]');

test('chips follow the console language and show bare names', async ({ page }) => {
  await openEmails(page, 'DE');
  await expect(page.getByRole('button', { name: 'vorname', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'firstName', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'DE', exact: true }).click();
  await expect(page.getByRole('button', { name: 'firstName', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'vorname', exact: true })).toHaveCount(0);
});

test('a chip click writes the placeholder where the caret was', async ({ page }) => {
  await openEmails(page, 'DE');
  const field = body(page);
  await field.click();
  await field.fill('Hallo , schön');
  await field.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  // The reminder card's own chip row — the feedback card has the same names.
  await page.getByTestId('tpl-editor-reminder').getByRole('button', { name: 'coach', exact: true }).click();
  await expect(field).toHaveValue('Hallo {{coach}}, schön');
  // Caret lands after what was inserted, so typing carries on from there.
  expect(await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(15);
});

test('typing {{ opens the list, typing narrows it, Enter completes it', async ({ page }) => {
  await openEmails(page, 'DE');
  const field = body(page);
  await field.click();
  await field.fill('');
  await field.pressSequentially('Liebe/r {{');
  const list = page.getByTestId('tpl-suggest');
  await expect(list).toBeVisible();
  await expect(list.getByRole('option')).toHaveCount(PH_DE.length);
  await field.pressSequentially('coachV');
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option').first()).toContainText('coachVorname');
  await field.press('Enter');
  await expect(field).toHaveValue('Liebe/r {{coachVorname}}');
  await expect(list).toHaveCount(0);
  // Escape closes it without touching the text.
  await field.pressSequentially(' {{');
  await expect(list).toBeVisible();
  await field.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(field).toHaveValue('Liebe/r {{coachVorname}} {{');
});

test('the overlay shows the name as a pill, the braces kept invisible for the width', async ({ page }) => {
  await openEmails(page, 'DE');
  const field = body(page);
  await field.fill('Hallo {{vorname}}');
  const pill = page.locator('div.tpl-field [data-placeholder="vorname"]').first();
  await expect(pill.locator('span.invisible')).toHaveText('{{vorname}}'); // still in the DOM, for the width…
  expect(await pill.locator('span.invisible').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden'); // …but not painted
  await expect(pill.locator('span.absolute')).toHaveText('vorname');
  const bg = await pill.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  // The pill is exactly as wide as the text it stands for: the caret must not drift.
  const w = await pill.evaluate((el) => ({ pill: el.getBoundingClientRect().width, text: el.querySelector('span.invisible')!.getBoundingClientRect().width }));
  expect(Math.abs(w.pill - w.text)).toBeLessThanOrEqual(1);
});

test('a pill reads in the console language whatever name the text holds', async ({ page }) => {
  await openEmails(page, 'DE');
  const field = body(page);
  await field.fill('Hallo {{vorname}} und {{date}}');
  const label = (name: string) => page.locator(`div.tpl-field [data-placeholder="${name}"] span.absolute`).first();
  await expect(label('vorname')).toHaveText('vorname');
  await expect(label('date')).toHaveText('datum');       // an English name, shown to a German admin as its twin
  await page.getByRole('button', { name: 'DE', exact: true }).click();
  await expect(label('vorname')).toHaveText('firstName'); // and the other way round
  await expect(label('date')).toHaveText('date');
  await expect(field).toHaveValue('Hallo {{vorname}} und {{date}}'); // the text itself is never rewritten
});

// The server's side of the English set.
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'server', 'index.ts'), 'utf8');

test('the server offers an English name for every German one, and renders both', () => {
  expect(SRC).toContain("const EMAIL_PLACEHOLDERS_MATCH_EN = ['firstName', 'name', 'coach', 'coachFirstName', 'date', 'time', 'home', 'away', 'league', 'venue', 'matchNo', 'role'];");
  expect(SRC).toMatch(/placeholdersEn: \{\s*feedback: EMAIL_PLACEHOLDERS_MATCH_EN,/);
  for (const k of ['firstName', 'coachFirstName', 'home', 'away', 'venue']) expect(SRC, k).toMatch(new RegExp(`\\b${k}: `));
  // The shipped English texts use the English names.
  expect(SRC).toContain('Dear {{firstName}},');
  expect(SRC).toContain('appearance as {{role}}');
});

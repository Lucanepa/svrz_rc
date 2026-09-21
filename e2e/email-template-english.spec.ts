import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubSignedInApp } from './support/app';

// Every coachee mail carries an English half under the German. Until now that
// half was the shipped text and nothing else: the editor showed only the German
// fields, and the save endpoint dropped the English ones on the floor — so the
// moment somebody reworded the German, the English under it went blank, with no
// way to write a new one. Now the two bilingual mails are edited in both halves.

const DE = { subject: 'Betreff', heading: 'Titel', intro: 'Hallo {{vorname}}', outro: 'Grüsse' };
const BILINGUAL = { ...DE, headingEn: 'Title', introEn: 'Hello {{vorname}}', outroEn: 'Regards' };
const SURVEY = { subject: 'Rückmeldung', heading: 'Rückmeldung', intro: 'Eine Rückmeldung ist eingegangen.', outro: '' };

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/email-templates', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({
      json: {
        feedback: BILINGUAL, reminder: BILINGUAL, survey: SURVEY,
        defaults: { feedback: BILINGUAL, reminder: BILINGUAL, survey: SURVEY },
        reminder_enabled: false,
        placeholders: { feedback: ['vorname'], reminder: ['vorname'], survey: ['vorname'] },
        accepted: { feedback: ['vorname'], reminder: ['vorname'], survey: ['vorname'] },
      },
    });
  });
});

test('the two coachee mails offer an English half; the commission mail does not', async ({ page }) => {
  await page.goto('/admin/emails');
  await expect(page.getByTestId('tpl-english-reminder')).toBeVisible();
  await expect(page.getByTestId('tpl-english-feedback')).toBeVisible();
  await expect(page.getByTestId('tpl-english-survey')).toHaveCount(0);
  // Prefilled with what the mail sends today, so editing starts from the real text.
  await expect(page.getByTestId('tpl-english-reminder').locator('textarea.tpl-field').nth(1)).toHaveValue('Hello {{vorname}}');
});

test('an edited English body travels with the save', async ({ page }) => {
  let sent: Record<string, { introEn?: string; intro?: string }> | null = null;
  await page.route('**/api/admin/email-templates', async (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    sent = r.request().postDataJSON();
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto('/admin/emails');
  const body = page.getByTestId('tpl-english-reminder').locator('textarea.tpl-field').nth(1);
  await body.fill('Hi {{vorname}}, see you 45 minutes before the game.');
  await page.getByRole('button', { name: /^(Speichern|Save)$/ }).click();
  await expect(page.getByText(/Gespeichert|Saved/)).toBeVisible();
  expect(sent!.reminder.introEn).toBe('Hi {{vorname}}, see you 45 minutes before the game.');
  // The German beside it is untouched, and the other mail's English rides along unchanged.
  expect(sent!.reminder.intro).toBe('Hallo {{vorname}}');
  expect(sent!.feedback.introEn).toBe('Hello {{vorname}}');
});

test('an unknown placeholder in the English half is flagged like one in the German', async ({ page }) => {
  await page.goto('/admin/emails');
  await page.getByTestId('tpl-english-feedback').locator('textarea.tpl-field').nth(1).fill('Hello {{nobody}}');
  await expect(page.getByText(/bleiben im Versand leer/).first()).toBeVisible();
});

// The server side of the same promise, read from the source (rendering a mail
// needs PocketBase + SMTP): the save keeps the English fields, and a stored
// English differing from the shipped one is a customisation, never "shipped".
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'server', 'index.ts'), 'utf8');

test('the save endpoint stores the English fields it is sent', () => {
  for (const k of ['headingEn', 'introEn', 'outroEn', 'subjectEn', 'noteEn']) {
    expect(SRC, k).toMatch(new RegExp(`if \\(typeof t\\.${k} === 'string'\\) clean\\.${k} = `));
  }
});

test('the shipped-copy rule compares a stored English half — and note, which no record predates either', () => {
  expect(SRC).toContain("(['headingEn', 'introEn', 'outroEn', 'subjectEn', 'note', 'noteEn'] as const).every((k) => typeof stored[k] !== 'string' || norm(stored[k]) === norm(shipped[k]))");
});

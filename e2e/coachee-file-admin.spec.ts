import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// Admin → E-Mails → Coaching-Dossier: the switch that rolls the coachee file
// out (it gates the PIN mail) must ask first, and the PIN lookup shows a PIN
// without sending anything.

const TEMPLATE = { subject: 'S', heading: '', intro: 'I', outro: 'O' };

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/email-templates', (r) => r.fulfill({
    json: {
      feedback: TEMPLATE, reminder: TEMPLATE, survey: TEMPLATE,
      defaults: { feedback: TEMPLATE, reminder: TEMPLATE, survey: TEMPLATE },
      reminder_enabled: false, placeholders: { feedback: [], reminder: [], survey: [] },
    },
  }));
});

test('the switch is off, says so, and asks before rolling out', async ({ page }) => {
  const puts: unknown[] = [];
  await page.route('**/api/admin/coachee-file', async (r) => {
    if (r.request().method() === 'PUT') { puts.push(r.request().postDataJSON()); await r.fulfill({ json: { enabled: true } }); return; }
    await r.fulfill({ json: { enabled: false, pinCount: 1, url: 'https://svrz-rc.openvolley.app/dossier' } });
  });
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  await expect(card.getByText('Nicht ausgerollt')).toBeVisible();
  const box = card.getByRole('checkbox');
  await expect(box).not.toBeChecked();

  // Cancelled: nothing saved, still off.
  await box.click();
  await page.getByRole('dialog').getByRole('button', { name: /Abbrechen/ }).click();
  await expect(box).not.toBeChecked();
  expect(puts).toEqual([]);

  // Confirmed: saved on.
  await box.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Ausrollen' }).click();
  await expect(box).toBeChecked();
  expect(puts).toEqual([{ enabled: true }]);
});

test('a PIN is looked up by SV-Nr.', async ({ page }) => {
  await page.route('**/api/admin/coachee-file', (r) => r.fulfill({ json: { enabled: false, pinCount: 0, url: '' } }));
  let body: unknown = null;
  await page.route('**/api/admin/coachee-file/pin', async (r) => {
    body = r.request().postDataJSON();
    await r.fulfill({ json: { sv: '12345', pin: '482913', name: 'Hans Muster', reports: 3, createdAt: '' } });
  });
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  await card.getByLabel('SV-Nr.').fill('12345');
  await card.getByRole('button', { name: 'PIN anzeigen' }).click();
  await expect(card.getByText('482913')).toBeVisible();
  await expect(card.getByText('3 Berichte mit dieser SV-Nr.')).toBeVisible();
  expect(body).toEqual({ sv: '12345', reset: false });
});

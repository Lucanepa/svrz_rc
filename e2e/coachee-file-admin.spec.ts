import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// Admin → E-Mails → Coaching-Dossier: everyone with a file and their PIN, to
// hand out by hand. Nothing here can turn on a mail to coachees (Luca,
// 2026-10-05) — the switch is drawn but locked until SVRZ / RC approve.

const TEMPLATE = { subject: 'S', heading: '', intro: 'I', outro: 'O' };
const PEOPLE = [
  { sv: '12345', name: 'Hans Muster', reports: 2, lastDate: '2026-03-14', pin: '482913', pinCreatedAt: '' },
  { sv: '55555', name: 'Petra Beispiel', reports: 1, lastDate: '2026-01-10', pin: '', pinCreatedAt: '' },
];

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/email-templates', (r) => r.fulfill({
    json: {
      feedback: TEMPLATE, reminder: TEMPLATE, survey: TEMPLATE,
      defaults: { feedback: TEMPLATE, reminder: TEMPLATE, survey: TEMPLATE },
      reminder_enabled: false, placeholders: { feedback: [], reminder: [], survey: [] },
    },
  }));
  await page.route('**/api/admin/coachee-file', (r) => r.fulfill({
    json: { enabled: false, pinCount: 1, url: 'https://svrz-rc.openvolley.app/dossier' },
  }));
});

test('lists the people with their PINs; the mail switch is locked pending approval', async ({ page }) => {
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  await expect(card.getByText('Keine E-Mails an Coachees')).toBeVisible();
  // Drawn, off, and impossible to turn on: SVRZ / RC approval comes first.
  const toggle = card.getByRole('checkbox', { name: 'PIN per E-Mail an Coachees senden' });
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await expect(card.getByText('Gesperrt — muss zuerst von SVRZ / RC genehmigt werden.')).toBeVisible();
  await toggle.click({ force: true });
  await expect(toggle).not.toBeChecked();
  const rows = card.getByTestId('coachee-file-person');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Hans Muster');
  await expect(rows.nth(0)).toContainText('482913');
  await expect(rows.nth(1)).toContainText('kein PIN');
  // Search narrows by name or number.
  await card.getByLabel('Name oder SV-Nr.…').fill('5555');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Petra Beispiel');
});

test('mints the missing PINs, then shows them', async ({ page }) => {
  let minted = false;
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({
    json: { people: minted ? PEOPLE.map((p) => ({ ...p, pin: p.pin || '582913' })) : PEOPLE },
  }));
  await page.route('**/api/admin/coachee-file/pins/backfill', async (r) => { minted = true; await r.fulfill({ json: { created: 1 } }); });
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  await card.getByRole('button', { name: 'Fehlende PINs erzeugen (1)' }).click();
  await expect(card.getByTestId('coachee-file-person').nth(1)).toContainText('582913');
  await expect(card.getByRole('button', { name: 'Fehlende PINs erzeugen (0)' })).toBeDisabled();
});

test('copies a ready-to-send text with link, SV-Nr. and PIN', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'clipboard permissions');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.goto('/admin/emails');
  await page.getByTestId('coachee-file-person').first().getByRole('button', { name: 'Text kopieren' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('Hallo Hans');
  expect(text).toContain('https://svrz-rc.openvolley.app/dossier');
  expect(text).toContain('SV-Nr.: 12345');
  expect(text).toContain('PIN: 482913');
});

test('a new PIN asks first', async ({ page }) => {
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  const bodies: unknown[] = [];
  await page.route('**/api/admin/coachee-file/pin', async (r) => {
    bodies.push(r.request().postDataJSON());
    await r.fulfill({ json: { sv: '12345', pin: '692913', name: 'Hans Muster', reports: 2, createdAt: '' } });
  });
  await page.goto('/admin/emails');
  await page.getByTestId('coachee-file-person').first().getByRole('button', { name: 'Neuer PIN' }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Abbrechen/ }).click();
  expect(bodies).toEqual([]);
  await page.getByTestId('coachee-file-person').first().getByRole('button', { name: 'Neuer PIN' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Neuer PIN' }).click();
  await expect.poll(() => bodies).toEqual([{ sv: '12345', reset: true }]);
});

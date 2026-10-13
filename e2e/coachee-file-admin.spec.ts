import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// Admin → E-Mails → Coaching-Dossier: everyone with a file and their PIN, to
// hand out by hand, and the PIN mail's switch — locked from 2026-10-05 until
// Luca unlocked it on 2026-10-13: off by default, and it asks before it turns on.

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

test('lists the people with their PINs; the PIN mail is off', async ({ page }) => {
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  await expect(card.getByText('Keine E-Mails an Coachees')).toBeVisible();
  const toggle = card.getByRole('checkbox', { name: 'PIN per E-Mail an Coachees senden' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(card.getByText(/^Aus — es wird nichts an Coachees versendet/)).toBeVisible();
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

test('the PIN mail turns on only after confirming, and off without asking', async ({ page }) => {
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  const state = { enabled: false, puts: [] as unknown[] };
  await page.route('**/api/admin/coachee-file', async (r) => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON() as { enabled: boolean };
      state.puts.push(body);
      state.enabled = body.enabled;
    }
    await r.fulfill({ json: { enabled: state.enabled, pinCount: 1, url: 'https://svrz-rc.openvolley.app/dossier' } });
  });
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  const toggle = card.getByRole('checkbox', { name: 'PIN per E-Mail an Coachees senden' });

  // Cancelled: nothing is saved, the switch stays off.
  await toggle.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('PIN-Mail an Coachees einschalten?');
  await expect(dialog).toContainText('Für die bisherigen Berichte wird nichts versendet.');
  await dialog.getByRole('button', { name: /Abbrechen/ }).click();
  await expect(toggle).not.toBeChecked();
  expect(state.puts).toEqual([]);

  await toggle.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Einschalten' }).click();
  await expect.poll(() => state.puts).toEqual([{ enabled: true }]);
  await expect(toggle).toBeChecked();
  await expect(card.getByText('PIN-Mail an', { exact: true })).toBeVisible();
  await expect(card.getByText(/^An — mit jedem neu versendeten Bericht/)).toBeVisible();

  // Off is the safe side: no question.
  await toggle.click();
  await expect.poll(() => state.puts).toEqual([{ enabled: true }, { enabled: false }]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(toggle).not.toBeChecked();
  await expect(card.getByText('Keine E-Mails an Coachees')).toBeVisible();
});

test('a failed save leaves the switch as the server has it', async ({ page }) => {
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  await page.route('**/api/admin/coachee-file', (r) => (r.request().method() === 'PUT'
    ? r.fulfill({ status: 500, json: { error: 'Datenbank nicht erreichbar' } })
    : r.fulfill({ json: { enabled: false, pinCount: 1, url: 'https://svrz-rc.openvolley.app/dossier' } })));
  await page.goto('/admin/emails');
  const card = page.getByTestId('coachee-file-admin');
  const toggle = card.getByRole('checkbox', { name: 'PIN per E-Mail an Coachees senden' });
  await toggle.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Einschalten' }).click();
  await expect(card.getByText('Datenbank nicht erreichbar')).toBeVisible();
  await expect(toggle).not.toBeChecked();
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

// Admin → Coachees: each row with an SV-Nr. carries its PIN (Luca,
// 2026-10-12) — the same map as above, so a PIN is handed out from the list
// it is looked up in. A row without one offers to create it; nothing is sent.
test('the coachees list shows each PIN and creates a missing one', async ({ page, context, browserName }) => {
  const status = { needsObservation: true, count: 0 };
  const coachee = (id: string, first: string, last: string, sv: string) => ({
    id, full_name: `${first} ${last}`, first_name: first, last_name: last, email: `${id}@example.ch`, season: 2026, referee_id: sv, observation_status: status,
  });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [
    coachee('c1', 'Hans', 'Muster', '12345'),
    // Typed with a leading zero and a space: keyed like the server keys it.
    coachee('c2', 'Petra', 'Beispiel', '055 555'),
    coachee('c3', 'Nils', 'Ohnenummer', ''),
  ] }));
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: { people: PEOPLE } }));
  const bodies: unknown[] = [];
  await page.route('**/api/admin/coachee-file/pin', async (r) => {
    bodies.push(r.request().postDataJSON());
    await r.fulfill({ json: { sv: '55555', pin: '582913', name: 'Petra Beispiel', reports: 1, createdAt: '' } });
  });
  await page.goto('/admin');
  const row = (id: string) => page.locator(`[data-coachee-row="${id}"]`);
  await expect(row('c1').getByTestId('coachee-pin')).toContainText('PIN482913');
  await expect(row('c2').getByTestId('coachee-pin')).toContainText('kein PIN');
  // No number, no PIN line: the row already says "ohne SV-Nr." in amber.
  await expect(row('c3')).toContainText('ohne SV-Nr.');
  await expect(row('c3').getByTestId('coachee-pin')).toHaveCount(0);

  await row('c2').getByRole('button', { name: 'PIN erstellen' }).click();
  await expect(row('c2').getByTestId('coachee-pin')).toContainText('582913');
  expect(bodies).toEqual([{ sv: '55555', reset: false }]);

  if (browserName !== 'chromium') return; // clipboard permissions
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // The icon beside the PIN copies the PIN alone — the ready-to-send text is
  // Admin → E-Mails' "Text kopieren" (Luca, 2026-10-13).
  await row('c1').getByRole('button', { name: 'PIN kopieren' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('482913');
  // The SV-Nr. has its own copy icon, and copies the bare number: "055 555"
  // as typed, 55555 as VolleyManager knows it (Luca, 2026-10-13).
  await row('c2').getByRole('button', { name: 'SV-Nr. kopieren' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('55555');
});

test('without the PIN roster the coachees list draws no PIN line', async ({ page }) => {
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [{
    id: 'c1', full_name: 'Hans Muster', first_name: 'Hans', last_name: 'Muster', email: 'h@example.ch', season: 2026,
    referee_id: '12345', observation_status: { needsObservation: true, count: 0 },
  }] }));
  // What the suite-wide stub answers every unknown route with: not a roster.
  await page.route('**/api/admin/coachee-file/pins', (r) => r.fulfill({ json: [] }));
  await page.goto('/admin');
  await expect(page.locator('[data-coachee-row="c1"]')).toContainText('SV-Nr. 12345');
  await expect(page.getByTestId('coachee-pin')).toHaveCount(0);
});

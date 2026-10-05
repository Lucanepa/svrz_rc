import { test, expect, type Page } from '@playwright/test';

// The coachee file page (/dossier) against a stubbed API: the door, the list,
// a report opened, and the ways a session ends.

const FILE = {
  refereeId: '12345',
  name: 'Hans Muster',
  expiresAt: Date.now() + 30 * 60_000,
  entries: [
    { id: 'fb2', date: '2026-03-14', role: '2. SR', matchNo: '312456', league: '3L ♂', homeTeam: 'VBC A', awayTeam: 'VBC B', rc: 'Anna Coach', goals: 'Pfiff klarer\nBlickkontakt', hasFile: true, isTest: false },
    { id: 'fb1', date: '2025-11-02', role: '1. SR', matchNo: '300001', league: '2L ♀', homeTeam: 'VBC C', awayTeam: 'VBC D', rc: 'Max Muster', goals: '', hasFile: false, isTest: false },
  ],
};

async function stubLogin(page: Page, opts: { status?: number; retryAfterMs?: number } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  await page.route('**/api/coachee-file/login', async (r) => {
    calls.push(r.request().postDataJSON());
    if (opts.status && opts.status !== 200) {
      await r.fulfill({ status: opts.status, json: { error: 'nope', retryAfterMs: opts.retryAfterMs ?? 0 } });
      return;
    }
    await r.fulfill({ json: { token: 'tok.sig', expiresAt: Date.now() + 30 * 60_000 } });
  });
  return calls;
}

test.describe('the coachee file page', () => {
  test('signs in with SV-Nr. and PIN, then lists the reports newest first', async ({ page }) => {
    const calls = await stubLogin(page);
    let header = '';
    await page.route('**/api/coachee-file', async (r) => {
      header = r.request().headers()['x-coachee-file'] || '';
      await r.fulfill({ json: FILE });
    });
    await page.goto('/dossier');
    await page.getByRole('group', { name: 'Sprache / Language' }).getByRole('button', { name: 'DE' }).click();

    await expect(page.getByRole('heading', { name: 'Mein Coaching-Dossier' })).toBeVisible();
    await page.getByLabel('SV-Nr.').fill('12 345');
    await page.getByLabel('PIN (6 Ziffern)').fill('482913');
    await page.getByRole('button', { name: 'Anmelden' }).click();

    await expect(page.getByTestId('coachee-file')).toBeVisible();
    expect(calls).toEqual([{ sv: '12 345', pin: '482913' }]);
    expect(header).toBe('tok.sig');
    await expect(page.getByText('Hans Muster')).toBeVisible();
    await expect(page.getByText('SV-Nr. 12345 · 2 Berichte')).toBeVisible();
    const rows = page.getByTestId('coachee-file-entry');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('14.03.2026');
    await expect(rows.nth(0)).toContainText('Ziele für nächste Spiele');
    await expect(rows.nth(0)).toContainText('Blickkontakt');
    await expect(rows.nth(1)).toContainText('02.11.2025');
    await expect(rows.nth(1)).toContainText('Keine Datei gespeichert');
    // The session is kept for this tab only, never beyond it.
    const stored = await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('|'));
    expect(stored).not.toContain('tok.sig');
  });

  test('a report opens as a download of the stored PDF', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: FILE }));
    await page.route('**/api/coachee-file/forms/fb2/file', (r) => r.fulfill({
      body: '%PDF-1.4 test', contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'inline; filename="2026-03-14_Hans-Muster_2SR_312456.pdf"' },
    }));
    await page.goto('/dossier');
    await page.getByLabel(/SV/).fill('12345');
    await page.getByLabel(/PIN/).fill('482913');
    await page.getByRole('button', { name: /Anmelden|Sign in/ }).click();
    const download = page.waitForEvent('download');
    await page.getByTestId('coachee-file-entry').first().getByRole('button').click();
    expect((await download).suggestedFilename()).toBe('2026-03-14_Hans-Muster_2SR_312456.pdf');
  });

  test('a wrong PIN and a lockout each say so', async ({ page }) => {
    await stubLogin(page, { status: 401 });
    await page.goto('/dossier');
    await page.getByRole('group', { name: 'Sprache / Language' }).getByRole('button', { name: 'EN' }).click();
    await page.getByLabel('SV no.').fill('12345');
    await page.getByLabel('PIN (6 digits)').fill('000001');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('SV no. or PIN is not correct.');

    await page.unroute('**/api/coachee-file/login');
    await stubLogin(page, { status: 429, retryAfterMs: 4 * 60_000 + 1 });
    await page.getByLabel('PIN (6 digits)').fill('000002');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Too many attempts. Please try again in 5 minutes.');
  });

  test('a session the server no longer honours goes back to the door', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
    await page.goto('/dossier');
    await page.getByRole('group', { name: 'Sprache / Language' }).getByRole('button', { name: 'DE' }).click();
    await page.getByLabel('SV-Nr.').fill('12345');
    await page.getByLabel('PIN (6 Ziffern)').fill('482913');
    await page.getByRole('button', { name: 'Anmelden' }).click();
    await expect(page.getByRole('alert')).toHaveText('Deine Sitzung ist abgelaufen. Bitte erneut anmelden.');
    await expect(page.getByTestId('coachee-file-login')).toBeVisible();
  });

  test('signing out forgets the session, also across a reload', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: FILE }));
    await page.goto('/dossier');
    await page.getByLabel(/SV/).fill('12345');
    await page.getByLabel(/PIN/).fill('482913');
    await page.getByRole('button', { name: /Anmelden|Sign in/ }).click();
    await expect(page.getByTestId('coachee-file')).toBeVisible();
    // A reload inside the session keeps it (sessionStorage) …
    await page.reload();
    await expect(page.getByTestId('coachee-file')).toBeVisible();
    // … signing out does not.
    await page.getByRole('button', { name: /Abmelden|Sign out/ }).click();
    await expect(page.getByTestId('coachee-file-login')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('coachee-file-login')).toBeVisible();
  });
});

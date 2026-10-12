import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// The coachee file page (/dossier) against a stubbed API: the door, the list,
// a report read in the page, opened in a tab or saved, the statistics, and
// the ways a session ends.

const FILE = {
  refereeId: '12345',
  name: 'Hans Muster',
  expiresAt: Date.now() + 30 * 60_000,
  entries: [
    { id: 'fb2', date: '2026-03-14', role: '2. SR', matchNo: '312456', league: '3L ♂', homeTeam: 'VBC A', awayTeam: 'VBC B', rc: 'Anna Coach', goals: 'Pfiff klarer\nBlickkontakt', hasFile: true, isTest: false },
    { id: 'fb1', date: '2025-11-02', role: '1. SR', matchNo: '300001', league: '2L ♀', homeTeam: 'VBC C', awayTeam: 'VBC D', rc: 'Max Muster', goals: '', hasFile: false, isTest: false },
  ],
};

/** A real one-page PDF, so the in-page reader has something to draw. */
const R = (id: string, section: number, score: number) => ({ id, section, score });
const firstRef = (tech1: number) => [R('1sr-prep-1', 0, 11), R('1sr-prep-2', 0, 8), R('1sr-tech-1', 1, tech1), R('1sr-tech-2', 1, 8)];
const row = (id: string, date: string, season: number, role: string, rc: string, ratings: ReturnType<typeof R>[], isTest = false) => ({
  id, date, season, role, rc, ratings, isTest, matchNo: '', league: '3L ♂', homeTeam: 'VBC A', awayTeam: 'VBC B', goals: '', hasFile: true,
});
const STATS_FILE = {
  refereeId: '12345',
  name: 'Hans Muster',
  expiresAt: Date.now() + 30 * 60_000,
  entries: [
    row('s5', '2026-10-04', 2026, '1. SR', 'Anna Coach', firstRef(14)),
    row('t', '2026-09-20', 2026, '1. SR', 'Test Coach', [R('1sr-prep-1', 0, 2)], true),
    row('s4', '2026-03-14', 2025, '1. SR', 'Max Muster', firstRef(11)),
    row('s3', '2025-11-02', 2025, '1. SR', 'Anna Coach', firstRef(11)),
    row('s2', '2025-03-01', 2024, '1. SR', 'Ben Beispiel', [R('1sr-prep-1', 0, 8), R('1sr-prep-2', 0, 5), R('1sr-tech-1', 1, 8), R('1sr-tech-2', 1, 5)]),
    row('s1', '2024-10-12', 2024, '2. SR', 'Ben Beispiel', [R('2sr-prep-1', 0, 8)]),
  ],
};

async function onePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText('Coaching-Bericht', { x: 50, y: 780, size: 18, font });
  return Buffer.from(await doc.save());
}

async function signIn(page: Page, lang: 'DE' | 'EN' = 'DE') {
  await page.goto('/dossier');
  await page.getByRole('group', { name: 'Sprache / Language' }).getByRole('button', { name: lang }).click();
  await page.locator('input[name=sv]').fill('12345');
  await page.locator('input[name=pin]').fill('482913');
  await page.getByRole('button', { name: lang === 'DE' ? 'Anmelden' : 'Sign in' }).click();
}

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
      header = (await r.request().headerValue('x-coachee-file')) || '';
      await r.fulfill({ json: FILE });
    });
    await page.goto('/dossier');
    await page.getByRole('group', { name: 'Sprache / Language' }).getByRole('button', { name: 'DE' }).click();

    await expect(page.getByRole('heading', { name: 'Mein Coaching-Dossier' })).toBeVisible();
    await page.getByLabel('SV-Nr.').fill('12 345');
    await page.getByLabel('PIN (6 Ziffern)').fill('482913');
    await page.getByRole('button', { name: 'Anmelden' }).click();

    // The container shows as soon as the session exists; the list follows.
    await expect(page.getByText('Hans Muster')).toBeVisible();
    expect(calls).toEqual([{ sv: '12 345', pin: '482913' }]);
    expect(header).toBe('tok.sig');
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

  test('the PIN can be shown while typing, and hidden again', async ({ page }) => {
    await page.goto('/dossier');
    await page.getByRole('group', { name: 'Sprache / Language' }).getByRole('button', { name: 'DE' }).click();
    const pin = page.getByLabel('PIN (6 Ziffern)');
    await pin.fill('482913');
    await expect(pin).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'PIN anzeigen' }).click();
    await expect(pin).toHaveAttribute('type', 'text');
    await expect(pin).toHaveValue('482913');
    await page.getByRole('button', { name: 'PIN verbergen' }).click();
    await expect(pin).toHaveAttribute('type', 'password');
  });

  test('a report downloads from its row', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: FILE }));
    await page.route('**/api/coachee-file/forms/fb2/file', (r) => r.fulfill({
      body: '%PDF-1.4 test', contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'inline; filename="2026-03-14_Hans-Muster_2SR_312456.pdf"' },
    }));
    await signIn(page);
    const download = page.waitForEvent('download');
    await page.getByTestId('coachee-file-entry').first().getByRole('button', { name: 'Bericht herunterladen' }).click();
    expect((await download).suggestedFilename()).toBe('2026-03-14_Hans-Muster_2SR_312456.pdf');
  });

  test('a report opens in the page, and from there in a new tab or as a download', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: FILE }));
    const pdf = await onePagePdf();
    let fetched = 0;
    await page.route('**/api/coachee-file/forms/fb2/file', (r) => {
      fetched += 1;
      return r.fulfill({
        body: pdf, contentType: 'application/pdf',
        headers: { 'Content-Disposition': 'inline; filename="2026-03-14_Hans-Muster_2SR_312456.pdf"' },
      });
    });
    await signIn(page);
    await page.getByTestId('coachee-file-entry').first().getByRole('button', { name: 'Bericht ansehen' }).click();

    const reader = page.getByRole('dialog', { name: 'Bericht 14.03.2026 · 2. SR' });
    await expect(reader).toBeVisible();
    await expect(reader.locator('canvas').first()).toBeVisible({ timeout: 20_000 });

    // A headless browser has no PDF viewer to show the new tab with, so what
    // is checked is what the page asks for: a new tab on the document itself.
    await page.evaluate(() => {
      const w = window as unknown as { __opened: unknown[][]; open: (...a: unknown[]) => null };
      w.__opened = [];
      w.open = (...a: unknown[]) => { w.__opened.push(a); return null; };
    });
    await reader.getByRole('button', { name: 'In neuem Tab öffnen' }).click();
    const opened = await page.evaluate(async () => {
      const [url, target] = (window as unknown as { __opened: string[][] }).__opened[0];
      const blob = await (await fetch(url)).blob();
      return { url, target, type: blob.type, size: blob.size };
    });
    expect(opened).toMatchObject({ target: '_blank', type: 'application/pdf', size: pdf.length });
    expect(opened.url).toMatch(/^blob:/);

    const download = page.waitForEvent('download');
    await reader.getByRole('button', { name: 'Bericht herunterladen' }).click();
    expect((await download).suggestedFilename()).toBe('2026-03-14_Hans-Muster_2SR_312456.pdf');

    await reader.getByRole('button', { name: 'Schliessen' }).click();
    await expect(reader).toBeHidden();
    // Viewed, saved, viewed again: one download of the document per session.
    await page.getByTestId('coachee-file-entry').first().getByRole('button', { name: 'Bericht ansehen' }).click();
    await expect(reader).toBeVisible();
    expect(fetched).toBe(1);
    // Nothing of it is kept in Cache Storage, where the next person at this
    // computer could find it.
    const cached = await page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const req of await (await caches.open(name)).keys()) urls.push(req.url);
      return urls.filter((u) => u.includes('coachee-file') || u.includes('dossier'));
    });
    expect(cached).toEqual([]);
  });

  test('a document the reader cannot draw still offers the download', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: FILE }));
    await page.route('**/api/coachee-file/forms/fb2/file', (r) => r.fulfill({
      body: '%PDF-1.4 broken', contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'inline; filename="bericht.pdf"' },
    }));
    await signIn(page);
    await page.getByTestId('coachee-file-entry').first().getByRole('button', { name: 'Bericht ansehen' }).click();
    const reader = page.getByRole('dialog', { name: 'Bericht 14.03.2026 · 2. SR' });
    await expect(reader.getByText('Das Dokument liess sich nicht laden.')).toBeVisible({ timeout: 20_000 });
    const download = page.waitForEvent('download');
    await reader.getByRole('button', { name: 'Bericht herunterladen' }).last().click();
    expect((await download).suggestedFilename()).toBe('bericht.pdf');
  });

  test('the statistics: totals, seasons compared, per criterion — test games left out', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: STATS_FILE }));
    await signIn(page);
    await page.getByRole('tab', { name: 'Statistik' }).click();

    const stats = page.getByTestId('coachee-stats');
    const tiles = stats.getByTestId('coachee-stats-tiles');
    // Five reports — the Testspiel is not one of them.
    await expect(tiles).toContainText('Berichte5');
    await expect(tiles).toContainText('1. SR 4 · 2. SR 1');
    await expect(tiles).toContainText('Ø NoteC');
    await expect(tiles).toContainText('Noten erhalten17');
    await expect(tiles).toContainText('Referee Coaches3');

    // Every season, newest first, and the latest against the one before.
    const seasons = stats.getByTestId('coachee-stats-seasons-block');
    await expect(seasons.getByTestId('coachee-stats-season-2026')).toContainText('B');
    await expect(seasons.getByTestId('coachee-stats-season-2025')).toContainText('B');
    await expect(seasons.getByTestId('coachee-stats-season-2024')).toContainText('C');
    await expect(seasons.getByTestId('coachee-stats-season-line')).toHaveText('Deine Ø Note 2026/27 ist besser als 2025/26.');

    // Strengths against the referee's own average as 1st referee.
    await expect(stats.getByTestId('coachee-stats-strong').locator('li').first()).toContainText('Pfiff (Lautstärke');
    await expect(stats.getByTestId('coachee-stats-weak')).toContainText('Kontrollen: Netz');
    await expect(stats.getByTestId('coachee-stats-criteria')).toContainText('Pünktlichkeit, korrekte Kleidung, vollständige Ausrüstung');
    await expect(stats.getByTestId('coachee-stats-ghost-legend')).toHaveCount(0);

    // One season, compared with the seasons before it.
    await stats.getByTestId('coachee-stats-seasons').getByRole('button', { name: '2025/26' }).click();
    await expect(tiles).toContainText('Berichte2');
    await expect(tiles).toContainText('▲ besser als 2024/25');
    await expect(tiles).toContainText('aus 2 Berichten');
    await expect(stats.getByTestId('coachee-stats-ghost-legend').first()).toBeVisible();
    await expect(stats.getByTestId('coachee-stats-sections').locator('[data-ghost]')).toHaveCount(2);

    // The 2nd referee's form has its own criteria.
    await stats.getByTestId('coachee-stats-seasons').getByRole('button', { name: 'Alle Saisons' }).click();
    await stats.getByTestId('coachee-stats-roles').getByRole('button', { name: '2. SR' }).click();
    await expect(stats.getByTestId('coachee-stats-criterion')).toHaveCount(1);
    await expect(stats.getByTestId('coachee-stats-method')).toContainText('ausser Testspielen');
  });

  test('statistics without a single grade say so', async ({ page }) => {
    await stubLogin(page);
    await page.route('**/api/coachee-file', (r) => r.fulfill({ json: FILE }));
    await signIn(page, 'EN');
    await page.getByRole('tab', { name: 'Statistics' }).click();
    await expect(page.getByTestId('coachee-stats-empty')).toHaveText('As soon as a report with grades is filed, your numbers show here.');
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
    await page.locator('input[name=sv]').fill('12345');
    await page.locator('input[name=pin]').fill('482913');
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

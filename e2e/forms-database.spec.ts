import { test, expect, type Page } from '@playwright/test';
import { COACHEE, RC, stubSignedInApp } from './support/app';

// Admin → Formulare: every filed form, one folder per referee across seasons,
// each openable as the PDF that was sent, the folder as a ZIP. And the coach's
// side of the same document: the Feedback-Verlauf hands back the sent PDF.
// The sorting rules have their own spec (forms-rules.spec.ts); this is the page.

const INDEX = {
  referees: [
    {
      key: 'sv:4711', name: 'Hans Muster', refereeId: '4711', seasons: [2026, 2025],
      forms: [
        { id: 'fb3', date: '2026-11-20', season: 2026, role: '2. SR', matchNo: '1000', league: '2L', homeTeam: 'C', awayTeam: 'D', rc: 'Cora Coach', submittedAt: '2026-11-21T10:00:00Z', file: 'pdf', filename: '2026-11-20_Hans-Muster_2SR_1000.pdf' },
        { id: 'fb2', date: '2026-10-03', season: 2026, role: '1. SR', matchNo: '999', league: '3L', homeTeam: 'A', awayTeam: 'B', rc: 'Beat Coach', submittedAt: '2026-10-04T10:00:00Z', file: 'image', filename: '2026-10-03_Hans-Muster_1SR_999.jpg' },
        { id: 'fb1', date: '2026-03-14', season: 2025, role: '1. SR', matchNo: '2345678', league: '3L', homeTeam: 'A', awayTeam: 'B', rc: 'Anna Coach', submittedAt: '2026-03-15T10:00:00Z', file: '', filename: '2026-03-14_Hans-Muster_1SR_2345678.pdf' },
      ],
    },
    {
      key: 'name:beispiel petra', name: 'Petra Beispiel', refereeId: '', seasons: [2026],
      forms: [
        { id: 'fb4', date: '2026-10-10', season: 2026, role: '1. SR', matchNo: '55', league: '4L', homeTeam: 'E', awayTeam: 'F', rc: 'Anna Coach', submittedAt: '2026-10-11T10:00:00Z', file: 'pdf', filename: '2026-10-10_Petra-Beispiel_1SR_55.pdf' },
      ],
    },
  ],
};

async function stubForms(page: Page) {
  const asked: string[] = [];
  await page.route('**/api/forms/index', (r) => { asked.push('index'); r.fulfill({ json: INDEX }); });
  await page.route('**/api/forms/archive*', (r) => {
    asked.push(new URL(r.request().url()).search);
    r.fulfill({
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="formulare-Hans-Muster.zip"',
        'X-Archive-Count': '2',
      },
      body: Buffer.from('PK'),
    });
  });
  return asked;
}

test('the chair has the forms database in her rail, and it loads once she opens it', async ({ page }) => {
  await stubSignedInApp(page, { admin: true, surveyReader: true });
  const asked = await stubForms(page);

  await page.goto('/admin/survey');
  const rail = page.getByRole('navigation').first();
  await expect(rail.getByRole('button', { name: 'Formulare' })).toBeVisible();
  // Not fetched behind another tab.
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);

  await rail.getByRole('button', { name: 'Formulare' }).click();
  await expect(page).toHaveURL(/\/admin\/forms$/);
  const body = page.getByTestId('forms-body');
  await expect(body).toBeVisible();
  await expect.poll(() => asked).toEqual(['index']);

  // One folder per person, with the count and the seasons.
  const folders = page.getByTestId('forms-folder');
  await expect(folders).toHaveCount(2);
  await expect(folders.nth(0)).toContainText('Hans Muster');
  await expect(folders.nth(0)).toContainText('3 Formulare');
  await expect(folders.nth(0)).toContainText('2026/27, 2025/26');
  await expect(folders.nth(0)).toContainText('SV-Nr. 4711');
  await expect(folders.nth(1)).toContainText('Petra Beispiel');
  await expect(folders.nth(1)).toContainText('1 Formular');
  await expect(body).toContainText('2 Schiedsrichter:innen · 4 Formulare');

  // The season ZIP kept its place under the folders.
  await expect(body.locator('..')).toContainText('Saison-Archiv');
});

test('a folder opens to its forms; each opens the sent document, the folder downloads as a ZIP', async ({ page }) => {
  await stubSignedInApp(page, { admin: true, surveyReader: true });
  const asked = await stubForms(page);
  await page.goto('/admin/forms');
  const hans = page.getByTestId('forms-folder').nth(0);
  await hans.getByRole('button', { name: /Hans Muster/ }).click();
  const open = hans.getByTestId('forms-folder-open');
  await expect(open).toBeVisible();

  const rows = open.getByTestId('forms-entry');
  await expect(rows).toHaveCount(3);
  // Newest first, with date, role, game and coach.
  await expect(rows.nth(0)).toContainText('20.11.2026');
  await expect(rows.nth(0)).toContainText('2. SR');
  await expect(rows.nth(0)).toContainText('2L · #1000 · C – D');
  await expect(rows.nth(0)).toContainText('Cora Coach');
  // The document is a link to the file route, opened in its own tab.
  const link = rows.nth(0).getByTestId('forms-open');
  await expect(link).toHaveText(/Öffnen/);
  await expect(link).toHaveAttribute('href', /\/api\/feedback\/fb3\/file$/);
  await expect(link).toHaveAttribute('target', '_blank');
  // A scanned paper form says so.
  await expect(rows.nth(1).getByTestId('forms-open')).toHaveText(/Scan/);
  await expect(rows.nth(1).getByTestId('forms-open')).toHaveAttribute('href', /\/api\/feedback\/fb2\/file$/);
  // A record without its file shows the gap rather than a dead link.
  await expect(rows.nth(2)).toContainText('keine Datei');
  await expect(rows.nth(2).getByTestId('forms-open')).toHaveCount(0);

  // The whole folder as a ZIP, keyed by the person.
  const download = page.waitForEvent('download');
  await open.getByTestId('forms-zip').click();
  expect((await download).suggestedFilename()).toBe('formulare-Hans-Muster.zip');
  expect(asked.at(-1)).toBe('?referee=sv%3A4711');
  await expect(open).toContainText('2 Formulare heruntergeladen.');

  // Opening the other folder closes this one — one folder at a time.
  const petra = page.getByTestId('forms-folder').nth(1);
  await petra.getByRole('button', { name: /Petra Beispiel/ }).click();
  await expect(petra.getByTestId('forms-folder-open')).toBeVisible();
  await expect(hans.getByTestId('forms-folder-open')).toHaveCount(0);
});

test('the search finds a person by name — accent-blind — or by SV-Nr.', async ({ page }) => {
  await stubSignedInApp(page, { admin: true, surveyReader: true });
  await stubForms(page);
  await page.goto('/admin/forms');
  const search = page.getByTestId('forms-search');
  await expect(page.getByTestId('forms-folder')).toHaveCount(2);

  await search.fill('müster');
  await expect(page.getByTestId('forms-folder')).toHaveCount(1);
  await expect(page.getByTestId('forms-folder')).toContainText('Hans Muster');

  await search.fill('4711');
  await expect(page.getByTestId('forms-folder')).toHaveCount(1);

  await search.fill('nobody');
  await expect(page.getByTestId('forms-folder')).toHaveCount(0);
  await expect(page.getByTestId('forms-body')).toContainText('Niemand passt zur Suche.');

  await search.fill('');
  await expect(page.getByTestId('forms-folder')).toHaveCount(2);
});

test('the admin has the same tab: the filed forms are the commission\'s records, not one password\'s', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const asked = await stubForms(page);
  await page.goto('/admin/forms');
  await expect(page).toHaveURL(/\/admin\/forms$/);
  await expect(page.getByTestId('forms-body')).toBeVisible();
  await expect.poll(() => asked).toEqual(['index']);
  await expect(page.getByTestId('forms-folder')).toHaveCount(2);
  // The chair's own tabs stay hers.
  const rail = page.getByRole('navigation').first();
  await expect(rail.getByRole('button', { name: 'Formulare' })).toBeVisible();
  await expect(rail.getByRole('button', { name: 'RC-Notizen' })).toHaveCount(0);
});

test('the old /admin/archive bookmark lands on the forms database', async ({ page }) => {
  await stubSignedInApp(page, { admin: true, surveyReader: true });
  await stubForms(page);
  await page.goto('/admin/archive');
  await expect(page.getByTestId('forms-body')).toBeVisible();
});

test('a coach gets the sent PDF back from the Feedback-Verlauf, without redrawing it', async ({ page }) => {
  await stubSignedInApp(page, { signedInAs: RC.name });
  const record = (id: string, role: string, date: string) => ({
    id, role_assessed: role, rc_name: RC.name, submitted_at: `${date}T10:00:00Z`,
    feedback_json: {
      role, lang: 'DE',
      meta: { spielNr: '1', liga: '3L', datum: date, ort: 'X', mannschaften: 'A vs B', ergebnis: '3:0', srName: 'Ref One', srNiveau: 'N3', rc: RC.name, gruppe: 'B' },
      sections: [], results: { motivation: 'up', einstufung: 'check', bemerkungen: 'ok', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
      signature: '', rcSignature: '',
    },
    expand: { game: { id: `g-${id}`, match_no: '1', league: '3L', match_date: date, location: 'X', home_team: 'A', away_team: 'B', first_referee: 'Ref One', second_referee: '' } },
  });
  // Two records, so the picker shows instead of opening the only one.
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [record('fb1', '1. SR', '2026-03-14'), record('fb2', '2. SR', '2026-02-01')] }));
  const served: string[] = [];
  await page.route('**/api/feedback/*/file', (r) => {
    served.push(new URL(r.request().url()).pathname);
    r.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="2026-03-14_Ref-One_1SR_1.pdf"' },
      body: Buffer.from('%PDF-1.4 stub'),
    });
  });

  await page.goto(`/feedbacks/${COACHEE.id}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/Feedback-Verlauf|Feedback History/);
  const buttons = dialog.getByTestId('history-sent-pdf');
  await expect(buttons).toHaveCount(2);

  // Fetched from the server with the session, saved under the server's name.
  const download = page.waitForEvent('download');
  await buttons.nth(0).click();
  expect((await download).suggestedFilename()).toBe('2026-03-14_Ref-One_1SR_1.pdf');
  expect(served).toEqual(['/api/feedback/fb1/file']);
  // The picker stays open — the coach may want the other one too.
  await expect(dialog).toBeVisible();

  // Opening the record offers the same document beside the redrawn PDF.
  await dialog.getByRole('button', { name: /A vs B/ }).nth(1).click();
  const sent = page.getByTestId('sent-pdf');
  await expect(sent).toBeVisible();
  const second = page.waitForEvent('download');
  await sent.click();
  await second;
  expect(served).toEqual(['/api/feedback/fb1/file', '/api/feedback/fb2/file']);
});

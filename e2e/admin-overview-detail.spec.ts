import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// Admin → Übersicht showed each coach as four numbers, and the chair read a
// "1" under Ausstehend and asked what it meant and where to find the game.
// Each row now opens on a chevron into the three lists behind its counters —
// the same detail the coach sees on their own Home — with a line under
// Ausstehend saying that these are the games still to be done.

const OVERVIEW = [
  { id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 0 },
  { id: 'rc2', fullName: 'Thanh Ut Nguyen', done: 0, outstanding: 1, planned: 2 },
];

const game = (gameId: string, gameDate: string, teams: string, refereeName: string, matchNo: string) =>
  ({ gameId, gameDate, league: '3L ♂', matchNo, teams, location: 'Sporthalle Utogrund', refereeName, refereeRole: '1. SR' });

/** Two coachees, one shared planned game between them — so the detail must
 *  fold what the summary hands over twice back into one row. */
const SUMMARY = [
  {
    coacheeName: 'Nina Adler', coacheeId: 'c1', doneFeedbacks: [],
    outstandingGames: [game('g-out', '2026-09-05T18:00:00Z', 'VBC Altdorf vs TV Gast', 'Nina Adler', '2500011')],
    plannedGames: [game('g-plan', '2026-10-24T18:00:00Z', 'VBC Neuheim vs TV Gast', 'Nina Adler', '2500012')],
  },
  {
    coacheeName: 'Tim Berger', coacheeId: 'c2', doneFeedbacks: [],
    outstandingGames: [],
    plannedGames: [
      { ...game('g-plan', '2026-10-24T18:00:00Z', 'VBC Neuheim vs TV Gast', 'Tim Berger', '2500012'), refereeRole: '2. SR' },
      game('g-plan-2', '2026-11-07T18:00:00Z', 'VBC Zweitheim vs TV Gast', 'Tim Berger', '2500013'),
    ],
  },
];

test('a coach\'s row opens into the games behind the counters', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  // A regex, because the request carries the season now (?season=2026, the
  // stub's default) and a glob cannot say "with a query". The console used to
  // ask without one, and the server read that as every season ever synced.
  await page.route(/\/api\/rc-overview\?season=2026$/, (r) => r.fulfill({ json: OVERVIEW }));
  const asked: string[] = [];
  await page.route('**/api/rc-overview/*/coachees*', (r) => {
    const u = new URL(r.request().url());
    asked.push(decodeURIComponent(u.pathname) + u.search);
    r.fulfill({ json: SUMMARY });
  });

  await page.goto('/admin/overview');
  const row = page.getByRole('row', { name: /Thanh Ut Nguyen/ });
  await expect(row).toBeVisible();
  // Closed by default: the table is the table. (GameRow prints the two teams
  // on their own lines, so the home team is what to look for.)
  await expect(page.getByText('VBC Altdorf')).toHaveCount(0);

  // The name is the button — a chevron column of its own pushed the table
  // sideways on a phone.
  const toggle = row.getByRole('button', { name: 'Thanh Ut Nguyen' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  // Asked with the coach's roster id beside the name: two coaches can fold
  // to one string, and the detail under a row must be that row's coach. The
  // name stays in the path, where an API one version behind the client (the
  // API is copied by hand, Pages ships on push) still reads it.
  expect(asked.some((p) => p.includes('/Thanh Ut Nguyen/') && p.includes('season=2026') && p.includes('rcId=rc2'))).toBe(true);
  expect(asked.some((p) => p.includes('/rc2/'))).toBe(false);

  // The outstanding game, under a heading that says what "outstanding" means.
  await expect(page.getByText('VBC Altdorf')).toBeVisible();
  await expect(page.getByText(/noch zu erledigen|still to be done/)).toBeVisible();
  // The shared planned game once, naming both coachees; the other one too.
  // (Nina is on the outstanding game as well, hence two of her chips.)
  await expect(page.getByText('VBC Neuheim')).toHaveCount(1);
  await expect(page.getByText('Nina Adler · 1. SR')).toHaveCount(2);
  await expect(page.getByText('Tim Berger · 2. SR')).toHaveCount(1);
  await expect(page.getByText('VBC Zweitheim')).toBeVisible();

  // And it closes again.
  await toggle.click();
  await expect(page.getByText('VBC Altdorf')).toHaveCount(0);
});

// The season's expenses, once paid out, get a mark — set from the opened row,
// shown as a tick beside the Paid count, written into the CSV. It changes no
// number: Vergütet stays the claim, this is the fact that it was settled.
test('a coach\'s expenses can be marked paid, and the mark can be taken back', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route(/\/api\/rc-overview\?season=2026$/, (r) => r.fulfill({ json: [
    ...OVERVIEW,
    { id: 'rc3', fullName: 'Paula Paid', done: 3, outstanding: 0, planned: 0, paidAt: '2026-09-01T10:00:00Z', paidBy: 'admin@example.ch' },
  ] }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
  const puts: { rcId: string; body: unknown }[] = [];
  await page.route('**/api/admin/rc-paid/*', async (r) => {
    const body = r.request().postDataJSON() as { season: number; paid: boolean };
    puts.push({ rcId: new URL(r.request().url()).pathname.split('/').pop() || '', body });
    await r.fulfill({ json: { ok: true, paidAt: body.paid ? '2026-09-14T08:00:00Z' : null, paidBy: body.paid ? 'admin@example.ch' : '' } });
  });

  await page.goto('/admin/overview');
  // A row already paid carries the tick; an unpaid one does not.
  const paula = page.getByRole('row', { name: /Paula Paid/ });
  await expect(paula.getByLabel(/Bezahlt am|Paid on/)).toBeVisible();
  const row = page.getByRole('row', { name: /Thanh Ut Nguyen/ });
  await expect(row.getByLabel(/Bezahlt am|Paid on/)).toHaveCount(0);

  await row.getByRole('button', { name: 'Thanh Ut Nguyen' }).click();
  await page.getByRole('button', { name: /Als bezahlt markieren|Mark as paid/ }).click();
  await expect(page.getByText(/(Bezahlt am|Paid on) .*14\.09\.2026/)).toBeVisible();
  await expect(row.getByLabel(/Bezahlt am|Paid on/)).toBeVisible();
  expect(puts).toEqual([{ rcId: 'rc2', body: { season: 2026, paid: true } }]);

  await page.getByRole('button', { name: /Bezahlt-Markierung entfernen|Remove the paid mark/ }).click();
  await expect(row.getByLabel(/Bezahlt am|Paid on/)).toHaveCount(0);
  expect(puts[1]).toEqual({ rcId: 'rc2', body: { season: 2026, paid: false } });
});

// The Spesenabrechnung and the RC-Sitzung line, from the opened row.
test('the opened row hands out the coach\'s expense sheet and records the RC-Sitzung', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/settings', (r) => r.fulfill({ json: {
    default_season: 2026, test_mode: false, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10,
    expense_rates: { visit: 60, meeting: 60, meetingDate: '2027-04-13' },
  } }));
  await page.route(/\/api\/rc-overview\?season=2026$/, (r) => r.fulfill({ json: OVERVIEW }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({ json: [] }));
  const sheets: string[] = [];
  await page.route('**/api/admin/rc-expenses/*', async (r) => {
    sheets.push(new URL(r.request().url()).pathname + new URL(r.request().url()).search);
    await r.fulfill({ status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Spesen_2026-27_Nguyen_Thanh_Ut.pdf"' }, body: '%PDF-1.4\n%%EOF' });
  });
  const meetings: unknown[] = [];
  await page.route('**/api/admin/rc-meeting/*', async (r) => {
    meetings.push(r.request().postDataJSON());
    await r.fulfill({ json: { ok: true, attended: (r.request().postDataJSON() as { attended: boolean }).attended } });
  });

  await page.goto('/admin/overview');
  await page.getByRole('button', { name: 'Thanh Ut Nguyen' }).click();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Spesenabrechnung \(PDF\)|Expense sheet \(PDF\)/ }).click();
  expect((await download).suggestedFilename()).toBe('Spesen_2026-27_Nguyen_Thanh_Ut.pdf');
  expect(sheets).toEqual(['/api/admin/rc-expenses/rc2?season=2026']);

  // The meeting line names the date from the settings and records attendance for the season.
  const meeting = page.getByLabel(/RC-Sitzung vom 13\.04\.2027 besucht|Attended the RC meeting of 13\.04\.2027/);
  await expect(meeting).not.toBeChecked();
  await meeting.check();
  await expect(meeting).toBeChecked();
  expect(meetings).toEqual([{ season: 2026, attended: true }]);
});

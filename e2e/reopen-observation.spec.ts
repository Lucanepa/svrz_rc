import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stubSignedInApp, RC, COACHEE } from './support/app';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = readFileSync(join(ROOT, 'server', 'index.ts'), 'utf8');

/**
 * A filed report is not a mistake that has to stand.
 *
 * Until now a report was final the moment it was mailed: the form went
 * read-only, the Tips & Tricks box beside it did not (it could be rewritten to
 * nobody, since tips travel only in the mail that already went), and a coach
 * who had filed the wrong thing had no way back. "Beobachtung erneut öffnen"
 * turns the record into a form again; sending REPLACES that record — same id,
 * same place in the archive, same private note — and mails it again.
 */

/** A one-pixel PNG: enough to be a signature as far as the form is concerned. */
const INK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function record(id: string, matchNo: string, teams: [string, string]) {
  return {
    id,
    role_assessed: '1. SR',
    rc_name: RC.name,
    rc_id: RC.id,
    submitted_at: '2026-03-14T20:00:00Z',
    feedback_json: {
      role: '1. SR', lang: 'EN',
      meta: {
        spielNr: matchNo, liga: '3L', datum: '14.03.2026', ort: 'Halle',
        mannschaften: teams.join(' vs '), ergebnis: '3:0 | 25:11, 25:18, 26:24', srName: COACHEE.full_name,
        srNiveau: 'N3', rc: RC.name, gruppe: 'B',
      },
      sections: [],
      results: { motivation: 'up', einstufung: 'check', bemerkungen: 'Solide', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
      // Both pads carry ink: this is a report that was filed, and the send
      // gate refuses one that is not signed.
      signature: INK, rcSignature: INK,
    },
    expand: {
      game: {
        id: `g-${matchNo}`, match_no: matchNo, league: '3L', match_date: '2026-03-14 19:30:00.000Z',
        location: 'Halle', home_team: teams[0], away_team: teams[1],
        first_referee: COACHEE.full_name, second_referee: '',
      },
    },
  };
}

const FILED = record('fb-filed', '2345678', ['VBC Filed', 'TV Filed']);

async function openFiledRecord(page: Page) {
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [FILED] }));
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 1, outstanding: 0, planned: 0 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: COACHEE.id, coacheeName: COACHEE.full_name,
      doneFeedbacks: [{
        feedbackId: FILED.id, gameId: FILED.expand.game.id, matchNo: FILED.expand.game.match_no,
        gameDate: FILED.expand.game.match_date, league: '3L', teams: 'VBC Filed vs TV Filed',
        role: '1. SR', submittedAt: FILED.submitted_at, result: '3:0',
        hasPresidentNote: true, needsPresidentNote: true,
      }],
      outstandingGames: [], plannedGames: [],
    }],
  }));
  await page.goto('/home');
  await page.getByRole('button', { name: /VBC Filed/ }).click();
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
}

/** Every criterion at C, in whichever of the two layouts is on screen — the
 *  same two the form itself renders (fillWholeForm does this for a new one). */
async function rateEverything(page: Page) {
  const cells = page.locator('td.rating-cell');
  if (await cells.count() > 0 && await cells.first().isVisible()) {
    const rows = page.locator('tr', { has: page.locator('td.rating-cell') });
    for (let r = 0; r < await rows.count(); r++) {
      const row = rows.nth(r).locator('td.rating-cell');
      if (await row.count() === 5) await row.nth(2).click();
    }
    return;
  }
  const cs = page.locator('button', { hasText: /^C$/ });
  for (let i = 0; i < await cs.count(); i++) await cs.nth(i).click();
}

const tipsBox = (page: Page) => page.getByPlaceholder(/Enter tips and tricks|Tipps und Tricks/);

test('a filed report is read-only, tips and all', async ({ page }) => {
  await openFiledRecord(page);
  // The box says the tips are only ever sent by mail — so on a report already
  // mailed, an edit here reaches nobody. It no longer invites one.
  await expect(tipsBox(page)).toBeDisabled();
  await expect(page.getByTestId('reopen-observation')).toBeVisible();
});

test('reopening makes it a form again, and sending replaces the record it came from', async ({ page }) => {
  await openFiledRecord(page);

  await page.getByTestId('reopen-observation').click();
  // Honest about what the send will do.
  await expect(page.getByText(/ersetzt|replaces the filed report/)).toBeVisible();
  await expect(tipsBox(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: /Erneut senden|Send again/ })).toBeVisible();

  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/feedback/submit', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: FILED.id, emailSent: true } });
  });
  await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
    json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
  }));

  // A coach reopens a report to change it, and the record it came from was a
  // filed one: its ratings are on the form again and every one of them is
  // still required.
  await rateEverything(page);

  await page.getByRole('button', { name: /Erneut senden|Send again/ }).click();
  await page.getByRole('button', { name: /^(Speichern|Save)$/ }).last().click();

  await expect.poll(() => posted.length, { timeout: 15000 }).toBe(1);
  // The whole point: the server is told WHICH report this corrects, so it
  // updates that one instead of refusing a second report for a closed role.
  expect(posted[0].replaceId).toBe(FILED.id);
  expect(posted[0].role).toBe('1. SR');
});

// ---------------------------------------------------------------------------
// The server's half, pinned from its source: the route needs PocketBase and
// SMTP, and neither exists here. What matters is that ONE request shape gets
// past the duplicate guards, and that it cannot touch another coach's report.
// ---------------------------------------------------------------------------

test.describe('Replacing a filed report on the server (source)', () => {
  const start = SERVER.indexOf("app.post('/api/feedback/submit'");
  const submit = SERVER.slice(start, SERVER.indexOf('\n});\n', start));

  test('the record is checked against this game, this role and this coach', () => {
    expect(submit).toContain("String(replacing.game) !== String(game.id) || asText(replacing.role_assessed) !== String(role)");
    expect(submit).toContain('rcRefMatches(replacing.rc_id, replacing.rc_name, rcAuth)');
    // And the checks stand before anything is written.
    expect(submit.indexOf('rcRefMatches(replacing.rc_id')).toBeLessThan(submit.indexOf('const created = await withCollection'));
  });

  test('only a reopened report passes the three duplicate guards', () => {
    expect(submit).toContain('if (!replacing && closedRoles.includes(String(role)))');
    expect(submit).toContain('const replayed = replacing ? \'\' : await findSubmissionByKey');
    expect(submit).toContain('const recentDuplicate = replacing ? \'\' : await findRecentSubmission');
  });

  test('it updates that record rather than filing a second one', () => {
    expect(submit).toContain('replacing ? collection.update<AnyRecord>(replacing.id, record) : collection.create<AnyRecord>(record)');
    // One visit stays one visit: the coachee's old entry goes, and the
    // observation that counts toward the season target is rewritten.
    expect(submit).toContain("asText((e as AnyRecord).referee_coaches_id) !== String(replacing.id)");
    expect(submit).toContain('collection.update(existingObservation.id, observationPayload)');
    // And a failure never deletes a report that existed before the request.
    expect(submit).toContain('if (rollbackClean && !replacing)');
  });
});

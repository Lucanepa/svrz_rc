import { test, expect, type Page } from '@playwright/test';
import { COACHEE, GAME, RC, stubSignedInApp, openFeedbackForm } from './support/app';

// A second observation starts from what the previous one asked the referee to
// work on: the goals of every earlier observation of this person — whichever
// coach wrote them, whichever season — sit above the criteria of a fresh form.
// Only the goals: the rest of a colleague's assessment stays theirs.

const PRIOR = {
  observed: 2,
  prior: [
    { id: 'fb9', date: '2026-03-14', role: '1. SR', rc: 'Beat Brunner', goals: 'Näher am <b>Netz</b> stehen.\nSanktionen früher.' },
    { id: 'fb8', date: '2025-11-02', role: '2. SR', rc: RC.name, goals: 'Handzeichen deutlicher.' },
  ],
};

async function stub(page: Page, prior: unknown | null) {
  await stubSignedInApp(page);
  const asked: string[] = [];
  await page.route('**/api/coachees/*/prior-goals', (r) => {
    asked.push(new URL(r.request().url()).pathname);
    if (prior === null) { r.fulfill({ status: 500, json: { error: 'nope' } }); return; }
    r.fulfill({ json: prior });
  });
  await page.goto('/');
  return asked;
}

test('a fresh observation shows the last goals set for this referee, older ones on request', async ({ page }) => {
  const asked = await stub(page, PRIOR);
  await openFeedbackForm(page);

  await expect.poll(() => asked).toEqual([`/api/coachees/${COACHEE.id}/prior-goals`]);
  const panel = page.getByTestId('prior-goals');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/Aus der letzten Beobachtung|From the last observation/);
  // The newest first, with who set it and when.
  const shown = panel.getByTestId('prior-goal');
  await expect(shown).toHaveCount(1);
  await expect(shown.first()).toContainText('14.03.2026 · 1. SR · RC Beat Brunner');
  // Formatting is rendered as elements, never as raw markup; lines stay lines.
  await expect(shown.first().locator('b')).toHaveText('Netz');
  await expect(shown.first()).not.toContainText('<b>');
  await expect(shown.first()).toContainText('Sanktionen früher.');

  // The rest fold out.
  const older = panel.getByTestId('prior-goals-older');
  await expect(older).toHaveText(/1 (frühere Beobachtung|earlier observation)$/);
  await older.click();
  await expect(shown).toHaveCount(2);
  await expect(shown.nth(1)).toContainText('02.11.2025 · 2. SR · RC ' + RC.name);
  await expect(shown.nth(1)).toContainText('Handzeichen deutlicher.');
});

test('observed before with nothing set says so instead of showing nothing', async ({ page }) => {
  await stub(page, { observed: 1, prior: [] });
  await openFeedbackForm(page);
  const panel = page.getByTestId('prior-goals');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/1 frühere Beobachtung — keine Ziele notiert|1 earlier observation — no goals noted/);
  await expect(panel.getByTestId('prior-goal')).toHaveCount(0);
});

test('never observed: no panel', async ({ page }) => {
  await stub(page, { observed: 0, prior: [] });
  await openFeedbackForm(page);
  await expect(page.getByRole('heading', { name: /Tips & Tricks|Tipps & Tricks/ })).toBeVisible();
  await expect(page.getByTestId('prior-goals')).toHaveCount(0);
});

test('a failed lookup leaves the form alone', async ({ page }) => {
  await stub(page, null);
  await openFeedbackForm(page);
  await expect(page.getByTestId('prior-goals')).toHaveCount(0);
  // The form itself is untouched by the failure.
  await expect(page.locator(`input[value="${GAME.matchNo}"]`).first()).toBeVisible();
});

test('a reopened filed record is its own document — no panel, no lookup', async ({ page }) => {
  const asked = await stub(page, PRIOR);
  const record = {
    id: 'fb1', role_assessed: '1. SR', rc_name: RC.name, submitted_at: '2026-03-15T10:00:00Z',
    feedback_json: {
      role: '1. SR', lang: 'DE',
      meta: { spielNr: '1', liga: '3L', datum: '14.03.2026', ort: 'X', mannschaften: 'A vs B', ergebnis: '3:0', srName: COACHEE.full_name, srNiveau: 'N3', rc: RC.name, gruppe: 'B' },
      sections: [], results: { motivation: 'up', einstufung: 'check', bemerkungen: 'ok', goals: 'Eigene Ziele.', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
      signature: '', rcSignature: '',
    },
    expand: { game: { id: 'g1', match_no: '1', league: '3L', match_date: '2026-03-14', location: 'X', home_team: 'A', away_team: 'B', first_referee: COACHEE.full_name, second_referee: '' } },
  };
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [record] }));
  await page.goto(`/feedbacks/${COACHEE.id}/${record.id}`);
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(page.getByTestId('prior-goals')).toHaveCount(0);
  expect(asked).toEqual([]);
});

// The Feedback button on a coachee: the coach's own reports open in full; a
// colleague's is listed with its goals and nothing else — no form, no PDF.
const OWN = {
  id: 'fb-own', role_assessed: '1. SR', rc_name: RC.name, submitted_at: '2026-03-15T10:00:00Z',
  feedback_json: {
    role: '1. SR', lang: 'DE',
    meta: { spielNr: '1', liga: '3L', datum: '14.03.2026', ort: 'X', mannschaften: 'A vs B', ergebnis: '3:0', srName: COACHEE.full_name, srNiveau: 'N3', rc: RC.name, gruppe: 'B' },
    sections: [], results: { motivation: 'up', einstufung: 'check', bemerkungen: 'ok', goals: 'Eigene Ziele.', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
    signature: '', rcSignature: '',
  },
  expand: { game: { id: 'g-own', match_no: '1', league: '3L', match_date: '2026-03-14', location: 'X', home_team: 'A', away_team: 'B', first_referee: COACHEE.full_name, second_referee: '' } },
};
const THEIRS = {
  id: 'fb-theirs', role_assessed: '2. SR', rc_name: 'Beat Brunner', submitted_at: '2025-11-03T10:00:00Z',
  redacted: true, goals: 'Handzeichen <b>deutlicher</b>.',
  expand: { game: { id: 'g-theirs', match_no: '77', league: '2L', match_date: '2025-11-02', home_team: 'C', away_team: 'D', first_referee: '', second_referee: COACHEE.full_name } },
};

test("the Feedback-Verlauf lists a colleague's observation with its goals only; the coach's own opens in full", async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [OWN, THEIRS] }));
  await page.goto(`/feedbacks/${COACHEE.id}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(/Feedback-Verlauf|Feedback History/);

  // The colleague's entry: goals rendered, no button to open, no PDF.
  const theirs = dialog.getByTestId('history-redacted');
  await expect(theirs).toHaveCount(1);
  // Named by the match number, the way every game on screen is.
  await expect(theirs).toContainText('#77 · C vs D');
  await expect(theirs).toContainText('Beat Brunner');
  await expect(theirs).toContainText(/nur die Ziele|only the goals/);
  await expect(theirs.locator('b')).toHaveText('deutlicher');
  await expect(theirs.getByRole('button')).toHaveCount(0);
  await expect(theirs.getByTestId('history-sent-pdf')).toHaveCount(0);

  // The own one keeps its PDF and opens the record.
  await expect(dialog.getByTestId('history-sent-pdf')).toHaveCount(1);
  await dialog.getByRole('button', { name: /A vs B/ }).click();
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(page.locator('input[value="1"]').first()).toBeVisible();
});

test("a single colleague's observation shows the list, never the form", async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [THEIRS] }));
  await page.goto(`/feedbacks/${COACHEE.id}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('history-redacted')).toHaveCount(1);
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toHaveCount(0);

  // A link straight to it lands on the list too.
  await page.goto(`/feedbacks/${COACHEE.id}/${THEIRS.id}`);
  await expect(page.getByRole('dialog').getByTestId('history-redacted')).toHaveCount(1);
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toHaveCount(0);
});

// Since 19.11.2026 (the chair: "for a 2nd visit the last RC's information
// should be visible, the full form", also from the season before): the panel
// shows the whole last report, and a colleague's report opens read-only.
const REPORTS = {
  observed: 2,
  prior: [{ id: 'fb9', date: '2026-04-02', role: '1. SR', rc: 'Beat Brunner', goals: 'Näher am Netz.' }],
  reports: [
    {
      id: 'fb9', date: '2026-04-02', role: '1. SR', rc: 'Beat Brunner',
      motivation: 'up', einstufung: 'check', spielniveau: 'normal', srZiel: '2L', secondBesuch: 'Y', secondBesuchRole: '1SR',
      wantsPromotion: true, wantsCandidate: false,
      highlights: 'Sehr <b>ruhig</b>.', improvements: 'Ballkontrolle zögerlich.', goals: 'Näher am Netz.', bemerkungen: 'Gutes Gespräch.',
    },
    {
      id: 'fb8', date: '2025-11-02', role: '2. SR', rc: RC.name,
      motivation: 'check', einstufung: 'check', spielniveau: 'leicht', srZiel: '', secondBesuch: 'N', secondBesuchRole: '',
      wantsPromotion: false, wantsCandidate: false, highlights: '', improvements: '', goals: '', bemerkungen: 'Erster Besuch.',
    },
    {
      // Outside the full-form rule: the goals alone, and said so.
      id: 'fb7', date: '2023-10-01', role: '1. SR', rc: 'Beat Brunner', full: false,
      motivation: '', einstufung: '', spielniveau: '', srZiel: '', secondBesuch: '', secondBesuchRole: '',
      wantsPromotion: false, wantsCandidate: false, highlights: '', improvements: '', goals: 'Pfiff früher.', bemerkungen: '',
    },
  ],
};

test('a fresh observation shows the whole last report, across seasons, older ones on request', async ({ page }) => {
  await stub(page, REPORTS);
  await openFeedbackForm(page);
  const panel = page.getByTestId('prior-goals');
  const shown = panel.getByTestId('prior-report');
  await expect(shown).toHaveCount(1);
  await expect(shown.first()).toContainText('02.04.2026 · 1. SR · RC Beat Brunner');
  await expect(shown.first()).toContainText(/Motivation: Hoch|Motivation: High/);
  await expect(shown.first()).toContainText(/Einstufung: Gleich|Outlook: Same level/);
  await expect(shown.first()).toContainText(/SR-Ziel: 2L|Referee goal: 2L|2L/);
  await expect(shown.first()).toContainText('Ballkontrolle zögerlich.');
  await expect(shown.first()).toContainText('Gutes Gespräch.');
  await expect(shown.first().locator('b')).toHaveText('ruhig');
  await panel.getByTestId('prior-goals-older').click();
  await expect(shown).toHaveCount(3);
  await expect(shown.nth(1)).toContainText('Erster Besuch.');
  await expect(shown.nth(1).getByTestId('prior-goals-only')).toHaveCount(0);
  await expect(shown.nth(2)).toContainText('Pfiff früher.');
  await expect(shown.nth(2).getByTestId('prior-goals-only')).toBeVisible();
  await expect(shown.nth(2)).not.toContainText(/Motivation/);
});

const COLLEAGUE = {
  ...OWN, id: 'fb-col', rc_name: 'Beat Brunner', rc_id: 'rc-other', submitted_at: '2025-11-03T10:00:00Z', colleague: true,
  feedback_json: { ...OWN.feedback_json, results: { ...OWN.feedback_json.results, bemerkungen: 'Bericht der Kollegin.' } },
  expand: { game: { id: 'g-col', match_no: '77', league: '2L', match_date: '2025-11-02', location: 'Y', home_team: 'C', away_team: 'D', first_referee: COACHEE.full_name, second_referee: '' } },
};

test("a colleague's full report opens read-only: no PDF, no note to the chair", async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [OWN, COLLEAGUE] }));
  await page.goto(`/feedbacks/${COACHEE.id}`);
  const dialog = page.getByRole('dialog');
  const theirs = dialog.getByTestId('history-colleague');
  await expect(theirs).toContainText('#77 · C vs D');
  await expect(theirs).toContainText(/Bericht von Beat Brunner — nur lesen|Report by Beat Brunner — read only/);
  // The PDF stays the author's: one button, the own report's.
  await expect(dialog.getByTestId('history-sent-pdf')).toHaveCount(1);
  await theirs.click();
  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(page.getByText('Bericht der Kollegin.').first()).toBeVisible();
  await expect(page.getByText(/Vertrauliche Notiz an die RC-Vorsitzende|Private note to the RC president/)).toHaveCount(0);
  await expect(page.getByTestId('sent-pdf')).toHaveCount(0);
});

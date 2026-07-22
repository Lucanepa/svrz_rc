import { test, expect } from '@playwright/test';

/**
 * The private note a coach leaves for the RC chair on an observation they have
 * already filed. What matters here is who gets offered the box and what happens
 * when it cannot be read — the note is a promise about who sees what, and a
 * box that silently saves over an unreadable note breaks it quietly.
 */

const RC = { id: 'rc1', name: 'Anna Muster' };

const RECORD = {
  id: 'fb1',
  role_assessed: '1. SR',
  rc_name: RC.name,
  submitted_at: '2026-03-15T10:00:00Z',
  feedback_json: {
    role: '1. SR', lang: 'DE',
    meta: {
      spielNr: '1', liga: '3L', datum: '14.03.2026', ort: 'X',
      mannschaften: 'A vs B', ergebnis: '3:0', srName: 'Ref One',
      srNiveau: 'N3', rc: RC.name, gruppe: 'B',
    },
    sections: [],
    results: { motivation: 'up', einstufung: 'check', bemerkungen: 'ok', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
    signature: '', rcSignature: '',
  },
  expand: {
    game: {
      id: 'g1', match_no: '1', league: '3L', match_date: '2026-03-14', location: 'X',
      home_team: 'A', away_team: 'B', first_referee: 'Ref One', second_referee: '',
    },
  },
};

type NoteRoute = { note?: string; status?: number };

async function stub(
  page: import('@playwright/test').Page,
  opts: { signedInAs: string; note?: NoteRoute; onPut?: (body: unknown) => void } ,
) {
  await page.route('**/api/**', (r) => r.fulfill({ json: [] }));
  await page.route('**/api/auth/me', (r) => r.fulfill({
    json: { rc: { id: 'rc1', name: opts.signedInAs }, admin: null, surveyReader: false },
  }));
  await page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, groups: [], coachee_targets: {}, rc_mandates: {}, default_goal: 10 },
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [{ id: 'c1', full_name: 'Ref One', email: 'r@e.ch', referee_level: 'N3' }] }));
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [RECORD] }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({ json: [{ id: 'rc1', fullName: opts.signedInAs, done: 1, outstanding: 0, planned: 0 }] }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({
    json: [{
      coacheeName: 'Ref One', coacheeId: 'c1',
      doneFeedbacks: [{ gameDate: '2026-03-14', league: '3L', teams: 'A vs B', role: '1. SR', submittedAt: '2026-03-15T10:00:00Z' }],
      outstandingGames: [], plannedGames: [],
    }],
  }));
  await page.route('**/api/feedback/*/president-note', async (r) => {
    if (r.request().method() === 'PUT') {
      opts.onPut?.(JSON.parse(r.request().postData() || '{}'));
      await r.fulfill({ json: { ok: true } });
      return;
    }
    const cfg = opts.note ?? {};
    if (cfg.status && cfg.status >= 400) {
      await r.fulfill({ status: cfg.status, json: { error: 'Forbidden' } });
      return;
    }
    await r.fulfill({ json: { note: cfg.note ?? '' } });
  });
}

const noteBox = (page: import('@playwright/test').Page) =>
  page.getByPlaceholder(/RC-Vorsitzende wissen sollte|RC president should know/);

/** Home → completed observations → reopen the filed one. */
async function openFiledObservation(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /Ref One/ }).first().click();
}

test('the coach who filed it can read back and save the note', async ({ page }) => {
  const puts: unknown[] = [];
  await stub(page, { signedInAs: RC.name, note: { note: 'earlier note' }, onPut: (b) => puts.push(b) });
  await openFiledObservation(page);

  await expect(noteBox(page)).toBeVisible();
  await expect(noteBox(page)).toHaveValue('earlier note');

  await noteBox(page).fill('escalate please');
  await page.getByRole('button', { name: /Notiz speichern|Save note/ }).click();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ note: 'escalate please' });
});

test('another coach is not offered the box at all', async ({ page }) => {
  // Any RC may open a colleague's filed feedback; only its author may annotate
  // it, so the box must not appear rather than appear and fail on save.
  await stub(page, { signedInAs: 'Bea Beispiel', note: { status: 403 } });
  await openFiledObservation(page);

  await expect(page.getByText(/bereits beobachtet|already been observed/)).toBeVisible();
  await expect(noteBox(page)).toHaveCount(0);
});

test('a note that cannot be read is never silently overwritten', async ({ page }) => {
  const puts: unknown[] = [];
  await stub(page, { signedInAs: RC.name, note: { status: 500 }, onPut: (b) => puts.push(b) });
  await openFiledObservation(page);

  // The box stays shut and says why: enabling it empty would let a save wipe a
  // note that exists and merely could not be fetched.
  await expect(noteBox(page)).toBeDisabled();
  await expect(page.getByRole('button', { name: /Notiz speichern|Save note/ })).toBeDisabled();
  expect(puts).toHaveLength(0);
});

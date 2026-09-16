import { test, expect, type Page } from '@playwright/test';
import { RC, COACHEE, GAME, stubSignedInApp } from './support/app';

/**
 * The app's language belongs to the coach, not to the document on screen.
 *
 * `formData.lang` is the language of the WHOLE app, and two things used to
 * write into it: opening a filed observation (its feedback_json is always
 * German — every report is filed in German whatever the coach worked in) and
 * resuming a draft (which carries the language it was written in). Either one
 * flipped an English UI to German and left it there until the next reload —
 * reported as "the app randomly switches to German" on 16.09.2026.
 */

/** A report filed in German, with real sections so the wording has to be
 *  translated, not merely defaulted. */
const RECORD = {
  id: 'fb1',
  role_assessed: '1. SR',
  rc_name: RC.name,
  rc_id: RC.id,
  submitted_at: '2026-03-15T10:00:00Z',
  feedback_json: {
    role: '1. SR', lang: 'DE',
    meta: {
      spielNr: GAME.matchNo, liga: '3L', datum: '14.03.2026', ort: 'X',
      mannschaften: 'A vs B', ergebnis: '3:0', srName: COACHEE.full_name,
      srNiveau: 'N3', rc: RC.name, gruppe: 'B',
    },
    sections: [{
      title: 'Spielvorbereitung / Formalitäten',
      items: [
        { id: '1sr-prep-1', label: 'Pünktlichkeit, korrekte Kleidung, vollständige Ausrüstung', rating: 'D' },
        { id: '1sr-prep-2', label: 'Kontrollen: Netz, Ausweise, Matchbälle, Dress, Matchblatt', rating: 'C' },
      ],
    }],
    results: { motivation: 'up', einstufung: 'check', bemerkungen: 'ok', srZiel: '2L', spielniveau: 'normal', secondBesuch: 'N' },
    signature: '', rcSignature: '',
  },
  expand: {
    game: {
      id: GAME.id, match_no: GAME.matchNo, league: GAME.league, match_date: GAME.date, location: GAME.location,
      home_team: GAME.homeTeam, away_team: GAME.awayTeam, first_referee: COACHEE.full_name, second_referee: '',
    },
  },
};

/** The device's language choice, made at the gate and remembered since. */
async function preferEnglish(page: Page): Promise<void> {
  await page.addInitScript(() => { try { localStorage.setItem('svrz_lang', 'EN'); } catch { /* private mode */ } });
}

/** The app writes its language onto <html lang>, which — unlike the toggle
 *  button, hidden behind the phone toolbar — is there at every viewport. */
const appLang = (page: Page) => page.locator('html');
const backButton = (page: Page) => page.getByRole('button', { name: /^(Back|Zurück)$/ });

/** The first criterion, worded in English and still rated D. The desktop grid
 *  and the phone cards render it differently; the selected rating wears the
 *  same colour class on both. */
async function expectCriterionD(page: Page): Promise<void> {
  await expect(page.getByText('Punctuality, correct clothing, complete equipment').filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText('Pünktlichkeit, korrekte Kleidung, vollständige Ausrüstung')).toHaveCount(0);
  await expect(page.locator('.bg-orange-500', { hasText: /^D$/ }).filter({ visible: true }).first()).toBeVisible();
}

test('opening a filed observation keeps the app in English and translates the criteria', async ({ page }) => {
  await preferEnglish(page);
  await stubSignedInApp(page);
  await page.route('**/api/coachees/*/feedbacks', (r) => r.fulfill({ json: [RECORD] }));
  await page.route('**/api/rc-overview*', (r) => r.fulfill({ json: [{ id: RC.id, fullName: RC.name, done: 1, outstanding: 0, planned: 0 }] }));
  await page.route('**/api/rc-overview/*/coachees*', (r) => r.fulfill({
    json: [{
      coacheeName: COACHEE.full_name, coacheeId: COACHEE.id,
      doneFeedbacks: [{ gameDate: GAME.date, league: GAME.league, teams: `${GAME.homeTeam} vs ${GAME.awayTeam}`, role: '1. SR', submittedAt: '2026-03-15T10:00:00Z' }],
      outstandingGames: [], plannedGames: [],
    }],
  }));
  await page.route('**/api/feedback/*/president-note', (r) => r.fulfill({ json: { note: '' } }));

  await page.goto('/');
  await expect(appLang(page)).toHaveAttribute('lang', 'en');
  // Home → completed observations → the filed one.
  await page.getByRole('button', { name: new RegExp(COACHEE.full_name) }).first().click();

  // The German document is on screen — in English. Its ratings are intact.
  await expect(backButton(page)).toHaveText(/Back/);
  await expect(appLang(page)).toHaveAttribute('lang', 'en');
  await expectCriterionD(page);

  // And the app stays English after leaving it — this was the part that made
  // the switch look random: the flip outlived the record that caused it.
  // Dispatched rather than clicked: the record view's URL sync replaces and
  // pushes history entries in quick succession, and the click's own wait for
  // "the navigation this started" never sees that same-document dance settle.
  await backButton(page).dispatchEvent('click');
  await expect(page.getByRole('button', { name: /^Games$/ })).toBeVisible();
  await expect(appLang(page)).toHaveAttribute('lang', 'en');
});

test('resuming a draft written in German keeps the app in English', async ({ page }) => {
  await preferEnglish(page);
  await stubSignedInApp(page);
  // A draft as src/lib/formDraft.ts stores it (database, store and version
  // must match, or the app never sees it — see e2e/form-draft.spec.ts).
  await page.addInitScript((row) => {
    const open = indexedDB.open('svrz-drafts', 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('form-drafts')) {
        open.result.createObjectStore('form-drafts', { keyPath: 'id' });
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('form-drafts', 'readwrite');
      tx.objectStore('form-drafts').put(row);
      tx.oncomplete = () => db.close();
    };
  }, {
    id: `${RC.id}|${GAME.id}|1. SR`,
    schema: 1, ownerId: RC.id, gameId: GAME.id, role: '1. SR',
    updatedAt: Date.now(), status: 'editing', submissionKey: '',
    label: `${GAME.homeTeam} vs ${GAME.awayTeam}`, matchNo: GAME.matchNo,
    observationTarget: '1SR', resultUnlocked: false,
    coacheeId: COACHEE.id, coacheeName: COACHEE.full_name, coacheeLevel: COACHEE.referee_level,
    lang: 'DE',
    meta: {}, ratings: { '1sr-prep-1': 'D' }, results: {},
    signature: '', rcSignature: '', tipsAndTricks: 'auf Deutsch begonnen',
  });

  await page.goto('/');
  await expect(appLang(page)).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: /^(Resume|Weiterarbeiten)$/ }).click();

  await expect(backButton(page)).toHaveText(/Back/);
  await expect(appLang(page)).toHaveAttribute('lang', 'en');
  await expectCriterionD(page);
});

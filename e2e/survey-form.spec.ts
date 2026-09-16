import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';
import { DEFAULT_SURVEY_CONFIG, type SurveyConfig } from '../src/lib/survey';

// The post-visit questionnaire is admin-editable: the questions live in
// app_settings, travel with the survey session, and the page renders whatever
// arrived. The shipped list in src/lib/survey.ts is only the fallback.

const CUSTOM: SurveyConfig = {
  eyebrow: { DE: 'Rückmeldung zum Besuch', EN: 'Feedback on the visit' },
  intro: { DE: 'Zwei Fragen, mehr nicht.', EN: 'Two questions, no more.' },
  questions: [
    { id: 'punctual', kind: 'choice', scale: 'yesno', DE: 'War der Coach da?', EN: 'Was the coach there?' },
    { id: 'was_neu', kind: 'text', DE: 'Was war neu für dich?', EN: 'What was new to you?' },
  ],
};

function stubSurveySession(page: import('@playwright/test').Page, form: SurveyConfig | undefined) {
  return page.route('**/api/survey/*', (r) => r.fulfill({
    json: {
      referee: 'Anna Beispiel', date: '14.09.2026', matchNo: '312456',
      rc: 'Max Muster', submitted: false, ...(form ? { form } : {}),
    },
  }));
}

test.describe('the survey page', () => {
  test('asks the questions the server configured, not the shipped ones', async ({ page }) => {
    await stubSurveySession(page, CUSTOM);
    await page.goto('/#/survey/tok123');

    await expect(page.getByText('Rückmeldung zum Besuch')).toBeVisible();
    await expect(page.getByText('Zwei Fragen, mehr nicht.')).toBeVisible();
    await expect(page.getByText('War der Coach da?')).toBeVisible();
    await expect(page.getByText('Was war neu für dich?')).toBeVisible();
    // The default set is gone entirely — not merely appended to.
    await expect(page.getByText('Was hast du vermisst?')).toHaveCount(0);
    // A choice question still renders its scale; a text one a box.
    await expect(page.getByRole('radio')).toHaveCount(2);
    await expect(page.locator('textarea')).toHaveCount(1);
  });

  test('the configured questions are what gets submitted', async ({ page }) => {
    await stubSurveySession(page, CUSTOM);
    let body: Record<string, unknown> | null = null;
    await page.route('**/api/survey/*', async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      body = r.request().postDataJSON();
      await r.fulfill({ json: { ok: true } });
    });

    await page.goto('/#/survey/tok123');
    await page.getByRole('radio').first().check();
    await page.locator('textarea').fill('Die Blockschatten-Erklärung.');
    await page.getByRole('button', { name: /Absenden|Submit/ }).click();

    // Both languages, German first: the form no longer asks the referee to pick
    // one, so the thank-you says it twice.
    await expect(page.getByText('Danke für deine Rückmeldung!')).toBeVisible();
    await expect(page.getByText('Thank you for your feedback!')).toBeVisible();
    expect(body).toBeTruthy();
    // Answers are keyed by the question's stable id, which is what makes a
    // reworded question keep its history.
    expect((body as { answers: Record<string, string> }).answers).toEqual({
      punctual: 'yes', was_neu: 'Die Blockschatten-Erklärung.',
    });
  });

  test('a server that sends no form still leaves the referee a form', async ({ page }) => {
    await stubSurveySession(page, undefined);
    await page.goto('/#/survey/tok123');
    await expect(page.getByText(DEFAULT_SURVEY_CONFIG.questions[0].DE)).toBeVisible();
  });
});

test.describe('the questionnaire editor', () => {
  test.beforeEach(async ({ page }) => {
    await stubSignedInApp(page, { admin: true });
    await page.route('**/api/auth/me', (r) => r.fulfill({
      json: { rc: null, admin: { email: 'admin@example.ch' }, surveyReader: false, adminShortcut: true },
    }));
  });

  test('a new question is saved with an id minted from its wording', async ({ page }) => {
    let saved: SurveyConfig | null = null;
    await page.route('**/api/admin/survey-config', async (r) => {
      if (r.request().method() === 'PUT') {
        saved = r.request().postDataJSON();
        return r.fulfill({ json: { ok: true } });
      }
      await r.fulfill({ json: { config: CUSTOM, defaults: DEFAULT_SURVEY_CONFIG } });
    });

    await page.goto('/admin/form');
    await expect(page.getByLabel(/Frage \(Deutsch\)|Question \(German\)/).first()).toHaveValue('War der Coach da?');

    await page.getByRole('button', { name: /Frage hinzufügen|Add question/ }).click();
    const german = page.getByLabel(/Frage \(Deutsch\)|Question \(German\)/);
    await german.last().fill('Wie war die Nachbesprechung?');
    await page.getByRole('button', { name: /^(Speichern|Save)$/ }).click();
    await expect(page.getByText(/Gespeichert|Saved/)).toBeVisible();

    expect(saved).toBeTruthy();
    const questions = (saved as SurveyConfig).questions;
    expect(questions).toHaveLength(3);
    // Minted from the German text, so the stored key reads like the question.
    expect(questions[2].id).toBe('wie_war_die_nachbesprechung');
    // An existing question's id is never re-derived — that would orphan its
    // answers the first time somebody fixes a typo.
    expect(questions[0].id).toBe('punctual');
  });

  test('reordering moves the question, not its id', async ({ page }) => {
    let saved: SurveyConfig | null = null;
    await page.route('**/api/admin/survey-config', async (r) => {
      if (r.request().method() === 'PUT') {
        saved = r.request().postDataJSON();
        return r.fulfill({ json: { ok: true } });
      }
      await r.fulfill({ json: { config: CUSTOM, defaults: DEFAULT_SURVEY_CONFIG } });
    });

    await page.goto('/admin/form');
    await page.getByRole('button', { name: /Nach unten|Move down/ }).first().click();
    await page.getByRole('button', { name: /^(Speichern|Save)$/ }).click();
    await expect(page.getByText(/Gespeichert|Saved/)).toBeVisible();

    expect((saved as SurveyConfig).questions.map((q) => q.id)).toEqual(['was_neu', 'punctual']);
  });
});

test.describe('the answer travels with the name', () => {
  test('the page offers no anonymous option and says who reads the answers', async ({ page }) => {
    await stubSurveySession(page, undefined);
    let posted: Record<string, unknown> | null = null;
    await page.route('**/api/survey/*', async (r) => {
      if (r.request().method() !== 'POST') { await r.fallback(); return; }
      posted = JSON.parse(r.request().postData() || '{}');
      await r.fulfill({ json: { ok: true } });
    });
    await page.goto('/#/survey/tok123');
    await expect(page.getByText('Anna Beispiel')).toBeVisible();
    // The box is gone — it blanked the name while match, date and RC stayed,
    // which identified the referee anyway — and the page says plainly where
    // the answers go instead.
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByText(/Anonym absenden|Submit anonymously/)).toHaveCount(0);
    await expect(page.getByText(/gehen mit Name und Spiel an die RC-Vorsitzende/)).toBeVisible();
    await page.getByRole('button', { name: /Absenden/ }).click();
    await expect(page.getByText(/Danke für deine Rückmeldung/)).toBeVisible();
    expect(posted).not.toBeNull();
    expect(posted).not.toHaveProperty('anonymous');
  });
});

test.describe('the other-referee question', () => {
  const COOPERATION = /Zusammenarbeit mit dem \/ der anderen Schiedsrichter:in/;
  const session = (twoReferees: boolean | undefined) => ({
    referee: 'Anna Beispiel', date: '14.09.2026', matchNo: '312456', rc: 'Max Muster', submitted: false,
    ...(twoReferees === undefined ? {} : { twoReferees }),
  });

  test('is not asked when the match had one referee', async ({ page }) => {
    await page.route('**/api/survey/*', (r) => r.fulfill({ json: session(false) }));
    await page.goto('/#/survey/tok123');
    await expect(page.getByText(/Ist der RC pünktlich/)).toBeVisible();
    await expect(page.getByText(COOPERATION)).toHaveCount(0);
    // The questions around it are untouched.
    await expect(page.getByText(/Was du uns schon immer sagen wolltest/)).toBeVisible();
  });

  test('is asked with two referees, and when the server cannot say', async ({ page }) => {
    await page.route('**/api/survey/*', (r) => r.fulfill({ json: session(true) }));
    await page.goto('/#/survey/tok123');
    await expect(page.getByText(COOPERATION)).toBeVisible();
    // An older server sends no flag at all: never suppress on a guess.
    await page.route('**/api/survey/*', (r) => r.fulfill({ json: session(undefined) }));
    await page.goto('/#/survey/tok456');
    await expect(page.getByText(COOPERATION)).toBeVisible();
  });

  test('a stored form inherits the flag for the shipped question, and an untick sticks', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
      // Resolved by the browser against the dev server; the string keeps the
      // specifier out of TypeScript's module resolution.
      const load = (path: string): Promise<Record<string, never>> => import(path);
      const m = await load('/src/lib/survey.ts') as unknown as typeof import('../src/lib/survey');
      const saved = (q: Record<string, unknown>) => m.normalizeSurveyConfig({ questions: [q] } as never).questions[0];
      return {
        // Saved before the flag existed: no key, so the shipped default applies.
        inherited: saved({ id: 'cooperation', kind: 'choice', scale: 'rating15', DE: 'Zusammenarbeit?', EN: 'Cooperation?' }).twoRefereesOnly,
        // The commission unticked it: stored as an explicit false, which survives the next normalise.
        unticked: saved({ id: 'cooperation', kind: 'choice', scale: 'rating15', DE: 'Zusammenarbeit?', EN: 'Cooperation?', twoRefereesOnly: false }).twoRefereesOnly,
        // Any other question can be ticked …
        ticked: saved({ id: 'lines', kind: 'choice', scale: 'yesno', DE: 'Linienrichter?', EN: 'Line judges?', twoRefereesOnly: true }).twoRefereesOnly,
        // … and is plain when it was not.
        plain: saved({ id: 'lines', kind: 'choice', scale: 'yesno', DE: 'Linienrichter?', EN: 'Line judges?' }).twoRefereesOnly,
      };
    });
    expect(out).toEqual({ inherited: true, unticked: false, ticked: true, plain: undefined });
  });
});

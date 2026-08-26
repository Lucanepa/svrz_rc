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

    await expect(page.getByText(/Danke für deine Rückmeldung|Thank you/)).toBeVisible();
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

    await page.goto('/#/admin/form');
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

    await page.goto('/#/admin/form');
    await page.getByRole('button', { name: /Nach unten|Move down/ }).first().click();
    await page.getByRole('button', { name: /^(Speichern|Save)$/ }).click();
    await expect(page.getByText(/Gespeichert|Saved/)).toBeVisible();

    expect((saved as SurveyConfig).questions.map((q) => q.id)).toEqual(['was_neu', 'punctual']);
  });
});

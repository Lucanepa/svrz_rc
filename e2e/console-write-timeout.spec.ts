import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

/**
 * A console edit that gets no answer has to end, and say so.
 *
 * 01.10.2026, 20:42–20:46: the chair's PUT of a coachee hung eleven times,
 * from 923 ms to 179 s, and none of them ever reached the server. A plain
 * fetch has no end of its own, so the row sat "saving" with no message, and
 * the Niveau change she made was probably never stored. The console's own row
 * edits now give up after 20 s (CONSOLE_WRITE_TIMEOUT_MS in
 * src/lib/pocketbase.ts) and say "not saved" under the button.
 *
 * The browser's clock is Playwright's here, so the 20 s pass in an instant.
 */

const WRITE_TIMEOUT_MS = 20_000;
const NO_ANSWER = /Keine Antwort vom Server – nicht gespeichert\.|No answer from the server – not saved\./;

const status = { needsObservation: true, count: 0 };
const COACHEES = [
  { id: 'c1', full_name: 'Rita Zwahlen', first_name: 'Rita', last_name: 'Zwahlen', email: 'rita@example.ch', season: 2026, referee_id: '90003', observation_status: status },
];
const REGISTER = { source: 'roster', people: [{ id: '90003', name: 'Rita Zwahlen', email: 'rita@example.ch', level: 'N4' }] };

async function openCoacheeTab(page: Page): Promise<void> {
  await page.clock.install();
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: COACHEES }) : r.fallback()));
  await page.route('**/api/admin/referees', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: REGISTER }) : r.fallback()));
  await page.goto('/admin');
  await expect(page.getByText('Zwahlen, Rita')).toBeVisible();
}

/** A write that reaches nothing: the request is held and never answered. */
async function neverAnswer(page: Page, url: string, method: string): Promise<{ sent: number }> {
  const seen = { sent: 0 };
  await page.route(url, (r) => {
    if (r.request().method() !== method) return r.fallback();
    seen.sent += 1;
    // Held on purpose. Nothing answers it; the page's own timeout has to.
    return undefined;
  });
  return seen;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('an edit with no answer stops saving after 20 s and says it was not saved', async ({ page }) => {
  await openCoacheeTab(page);
  const put = await neverAnswer(page, '**/api/coachees/c1', 'PUT');

  const row = page.locator('div.py-2').filter({ hasText: 'Zwahlen, Rita' });
  await row.getByRole('button', { name: /Bearbeiten|Edit/ }).click();
  const save = page.locator('div.py-2').filter({ has: page.locator('#coachee-sv-c1') }).getByRole('button', { name: /Speichern|Save/ });
  await save.click();
  await expect.poll(() => put.sent).toBe(1);
  await expect(save).toBeDisabled();

  // Not before its time: a slow answer is still an answer.
  await page.clock.fastForward(WRITE_TIMEOUT_MS - 2000);
  await expect(page.getByTestId('coachee-refusal')).toHaveCount(0);
  await expect(save).toBeDisabled();

  await page.clock.fastForward(2500);
  await expect(page.getByTestId('coachee-refusal')).toHaveText(NO_ANSWER);
  // The row is still open with the edit in it, and the button can send again.
  await expect(save).toBeEnabled();
  await expect(page.locator('#coachee-sv-c1')).toHaveValue('Rita Zwahlen');
});

test('an add with no answer says the same under its button', async ({ page }) => {
  await openCoacheeTab(page);
  const post = await neverAnswer(page, '**/api/coachees', 'POST');

  const form = page.locator('div.grid').filter({ has: page.locator('#coachee-sv') });
  await form.getByPlaceholder(/^(Vorname|First name)$/).fill('Bea');
  await form.getByPlaceholder(/^(Nachname|Last name)$/).fill('Beispiel');
  const addButton = form.getByRole('button', { name: /^\s*(Hinzufügen|Add)$/ });
  await addButton.click();
  await expect.poll(() => post.sent).toBe(1);

  await page.clock.fastForward(WRITE_TIMEOUT_MS + 500);
  await expect(page.getByTestId('coachee-refusal')).toHaveText(NO_ANSWER);
  // Not a refusal for good: the same entry may be sent again as it is.
  await expect(addButton).toBeEnabled();
  await expect(form.getByPlaceholder(/^(Vorname|First name)$/)).toHaveValue('Bea');
});

import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, fillWholeForm, COACHEE } from './support/app';

/**
 * "Further visit: Y" says a coach should come back — and a Y alone left the
 * next coach guessing which role to watch. The Y now names it, offering only
 * the roles the Niveau table allows the referee: N4 is "ohne Ausbildung zum
 * 2. SR", so an N4 is offered the 1. SR alone. A plain Y ("another visit,
 * any role") stands in front of them; with only one role on offer, that Y is
 * all there is, and it records that role.
 */

const visitCell = (page: Page) =>
  page.getByRole('heading', { name: /^(Further visit|Weiterer Besuch)$/ }).locator('xpath=..');
/** The answers, without the cell's info button beside the heading. */
const answers = (page: Page) => visitCell(page).getByRole('button', { name: /^(Y|N)\b/ });

async function openFor(page: Page, level: string, stage: string) {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [{ ...COACHEE, referee_level: level, stage }] }));
  await page.goto('/');
  await openFeedbackForm(page);
}

test('an N3 is offered a further visit in either role, and the choice is kept', async ({ page }) => {
  await openFor(page, 'N3', '2');
  const cell = visitCell(page);
  await expect(answers(page)).toHaveText(['Y', /^Y, (as|als) 1SR$/, /^Y, (as|als) 2SR$/, 'N']);

  const picked = /bg-blue-600/;
  await cell.getByRole('button', { name: /2SR$/ }).click();
  await expect(cell.getByRole('button', { name: /2SR$/ })).toHaveClass(picked);
  await expect(cell.getByRole('button', { name: /1SR$/ })).not.toHaveClass(picked);
  // One answer: choosing N clears the Y and its role.
  await cell.getByRole('button', { name: /^N$/ }).click();
  await expect(cell.getByRole('button', { name: /^N$/ })).toHaveClass(picked);
  await expect(cell.getByRole('button', { name: /2SR$/ })).not.toHaveClass(picked);
});

test('an N4, who can only be visited as 1. SR, is offered a plain Y', async ({ page }) => {
  await openFor(page, 'N4', '2');
  await expect(answers(page)).toHaveText(['Y', 'N']);
});

test('a plain Y is offered beside the role-specific ones', async ({ page }) => {
  await openFor(page, 'N3', '2');
  const cell = visitCell(page);
  const picked = /bg-blue-600/;
  await cell.getByRole('button', { name: /^Y$/ }).click();
  await expect(cell.getByRole('button', { name: /^Y$/ })).toHaveClass(picked);
  await expect(cell.getByRole('button', { name: /1SR$/ })).not.toHaveClass(picked);
  await expect(cell.getByRole('button', { name: /2SR$/ })).not.toHaveClass(picked);
});

test('a level the table cannot place keeps a plain Y', async ({ page }) => {
  await openFor(page, 'ITA', '');
  await expect(answers(page)).toHaveText(['Y', 'N']);
});

/** Sends the open form and hands back what reached the server. */
async function sendAndCapture(page: Page): Promise<Record<string, any>> {
  const posted: Record<string, any>[] = [];
  await page.route('**/api/feedback/submit', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, json: { id: 'fb-1', emailSent: true } });
  });
  await page.route(/\/api\/drafts\/parked\//, (r) => r.fulfill({
    json: r.request().method() === 'DELETE' ? { removed: 1 } : { parked: 1 },
  }));
  await page.getByRole('button', { name: /Confirm and send|Bestätigen und senden/ }).click();
  await page.getByRole('button', { name: /^(Speichern|Save)$/ }).last().click();
  await expect.poll(() => posted.length, { timeout: 15000 }).toBe(1);
  return posted[0];
}

test.slow();
test('a plain Y is what gets sent: another visit, no role named', async ({ page }) => {
  await openFor(page, 'N3', '2');
  await fillWholeForm(page);
  await visitCell(page).getByRole('button', { name: /^Y$/ }).click();
  const sent = await sendAndCapture(page);
  expect(sent.formData.results.secondBesuch).toBe('Y');
  expect(sent.formData.results.secondBesuchRole ?? '').toBe('');
});

test.slow();
test('the N4\'s single Y is sent as a visit in the 1. SR role', async ({ page }) => {
  await openFor(page, 'N4', '2');
  await fillWholeForm(page);
  await visitCell(page).getByRole('button', { name: /^Y$/ }).click();
  await expect(visitCell(page).getByRole('button', { name: /^Y$/ })).toHaveClass(/bg-blue-600/);
  const sent = await sendAndCapture(page);
  expect(sent.formData.results.secondBesuch).toBe('Y');
  expect(sent.formData.results.secondBesuchRole).toBe('1SR');
});

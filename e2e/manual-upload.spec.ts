import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, GAME, COACHEE } from './support/app';

// The manual upload — a photo of a paper form filed against a game — and what
// it sends the server about WHO the report is about.
//
// The dialog names the coachee as the roster spells them (meta.srName), and
// the server's guard compares that with the name on the game's slot, which
// VolleyManager may print as the licence has it: "Kevin León Peña de los
// Santos" against "Kevin Peña". The SV number settles that when the claim
// carries the SLOT's number; a claim carrying any other number is refused
// outright, and two thirds of stored games carry none on the slot. So the
// row's number travels only when it is the slot's own (svClaimOnSlot), else
// nothing — and the server settles the two spellings through the index, the
// way it did before the client knew any number. The first shape here sent
// the row's number unconditionally and turned every such upload into a 422.

const LICENCE_SLOT = { ...GAME, firstReferee: 'Kevin León Peña de los Santos', firstRefereeId: '', firstCoacheeId: COACHEE.id };

/** Everything the dialog insists on, filled with the first grade offered. */
async function fillManualUpload(page: Page) {
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[name="spielNr"]').fill(GAME.matchNo);
  for (const grade of await dialog.getByRole('button', { name: 'A', exact: true }).all()) await grade.click();
  await dialog.locator('select[name="spielniveau"]').selectOption('normal');
  await dialog.locator('select[name="motivation"]').selectOption('up');
  await dialog.locator('select[name="einstufung"]').selectOption('check');
  await dialog.locator('select[name="secondBesuch"]').selectOption('N');
  await dialog.locator('select[name="srZiel"]').selectOption('3L');
  await dialog.locator('input[name="formFile"]').setInputFiles({ name: 'paper.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') });
}

/** Open the coachee's row and its upload dialog, and catch the submit. */
async function submitFor(page: Page, game: Record<string, unknown>) {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [game] }));
  const bodies: Record<string, unknown>[] = [];
  await page.route('**/api/feedback/submit', (r) => {
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ json: { id: 'fb1', emailSent: true } });
  });
  await page.goto('/coachees');
  await page.getByRole('button', { name: /Show details|Details anzeigen/ }).first().click();
  await page.getByRole('button', { name: /Upload manual observation|Manuelle Beobachtung hochladen/ }).click();
  await fillManualUpload(page);
  await page.getByRole('dialog').getByRole('button', { name: /Upload and send|Hochladen und senden/ }).click();
  await expect.poll(() => bodies.length).toBe(1);
  const body = bodies[0] as { gameId: string; role: string; refereeId?: string; formData: { meta: { srName: string } } };
  expect(body.gameId).toBe(GAME.id);
  expect(body.role).toBe('1. SR');
  return body;
}

test('a slot without a number: the row\'s name, and no number to claim', async ({ page }) => {
  const body = await submitFor(page, LICENCE_SLOT);
  expect(body.formData.meta.srName).toBe(COACHEE.full_name);
  expect(body.refereeId ?? '').toBe('');
});

test('a slot carrying the row\'s number: the number travels as the claim', async ({ page }) => {
  const body = await submitFor(page, { ...LICENCE_SLOT, firstRefereeId: COACHEE.referee_id });
  expect(body.formData.meta.srName).toBe(COACHEE.full_name);
  expect(body.refereeId).toBe(COACHEE.referee_id);
});

test('a slot carrying another number: nothing is claimed, the names are left to the server', async ({ page }) => {
  const body = await submitFor(page, { ...LICENCE_SLOT, firstRefereeId: '90099' });
  expect(body.refereeId ?? '').toBe('');
});

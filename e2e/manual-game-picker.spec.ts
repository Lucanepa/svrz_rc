import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The manual-game form used to take three free-text names. Nothing on screen
// said whether "Luca Canepa" was a person the app knows, and a test game whose
// referee matches no coachee sends its feedback nowhere — the failure only
// shows up later, as a mail that never arrives. The fields are pickers now:
// they carry every referee (and every referee coach) with the address the
// feedback would actually reach.

const COACHEES = [
  { id: 'c1', full_name: 'Luca Canepa', email: 'luca@example.ch', season: 2026 },
  // The same referee, coached last season too, under an address that has since
  // changed. One person, one row in the picker.
  { id: 'c0', full_name: 'Luca Canepa', email: 'old.luca@example.ch', season: 2025 },
  { id: 'c2', full_name: 'Jürg Müller', email: 'juerg@example.ch', season: 2026 },
  { id: 'c3', full_name: 'Nina Ohnemail', email: '', season: 2026 },
];

const RC_PEOPLE = [
  { id: 'rc1', fullName: 'Anna Muster', email: 'anna@example.ch' },
  { id: 'rc2', fullName: 'Beat Zimmermann', email: 'beat@example.ch' },
];

/** The line under a picker: which address the feedback would reach. */
function fieldNote(page: Page, id: string) {
  return page.locator(`#${id} ~ span`);
}

async function openManualGameForm(page: Page) {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.route('**/api/referee-coach-people', (r) => r.fulfill({ json: RC_PEOPLE }));
  await page.route('**/api/admin/games/manual*', (r) => r.fulfill({ json: [] }));
  await page.goto('/#/admin');
  await page.getByRole('button', { name: /Einstellungen|Settings/ }).click();
}

test.describe('Manual game name pickers', () => {
  test('the referee field offers coachees with their e-mail, and picking one fills it in', async ({ page }) => {
    await openManualGameForm(page);

    await page.locator('#mg-ref1').fill('canepa');
    const option = page.getByRole('button', { name: /Luca Canepa/ });
    await expect(option).toHaveCount(1); // one person, not one row per season
    await expect(option).toContainText('luca@example.ch'); // the current season's address
    await option.click();

    await expect(page.locator('#mg-ref1')).toHaveValue('Luca Canepa');
    // The address stays under the field after the pick — that is what makes it
    // possible to check which inbox the test mail should land in. Scoped to the
    // field: the coachee tab is mounted (hidden) and prints addresses too.
    await expect(fieldNote(page, 'mg-ref1')).toHaveText('luca@example.ch');
  });

  test('the search is accent-blind, so "muller" finds Müller', async ({ page }) => {
    await openManualGameForm(page);

    await page.locator('#mg-ref2').fill('muller');
    await page.getByRole('button', { name: /Jürg Müller/ }).click();
    await expect(page.locator('#mg-ref2')).toHaveValue('Jürg Müller');
  });

  test('a coachee without an address is marked as such rather than looking ready', async ({ page }) => {
    await openManualGameForm(page);

    await page.locator('#mg-ref1').fill('ohnemail');
    await page.getByRole('button', { name: /Nina Ohnemail/ }).click();
    await expect(fieldNote(page, 'mg-ref1')).toHaveText(/keine E-Mail|no email/);
  });

  test('the referee coach field offers the RC roster, not the coachees', async ({ page }) => {
    await openManualGameForm(page);

    await page.locator('#mg-rc').fill('zimmer');
    const option = page.getByRole('button', { name: /Beat Zimmermann/ });
    await expect(option).toContainText('beat@example.ch');
    await option.click();
    await expect(page.locator('#mg-rc')).toHaveValue('Beat Zimmermann');

    // A coachee is not a referee coach: the RC field must not offer one.
    await page.locator('#mg-rc').fill('canepa');
    await expect(page.getByRole('button', { name: /Luca Canepa/ })).toHaveCount(0);
  });

  test('a name nobody knows still goes through, but says it is unknown', async ({ page }) => {
    await openManualGameForm(page);

    let posted: Record<string, unknown> | null = null;
    await page.route('**/api/admin/games', (r) => {
      posted = r.request().postDataJSON();
      return r.fulfill({ status: 201, json: { id: 'g-new', match_no: 'TEST-1' } });
    });

    await page.locator('#mg-ref1').fill('Gastspieler Ohne Akte');
    await expect(fieldNote(page, 'mg-ref1')).toHaveText(/Nicht in der Liste|Not in the list/);

    await page.getByRole('button', { name: /Spiel anlegen|Create game/ }).click();
    await expect(page.getByText(/(Angelegt|Created): TEST-1/)).toBeVisible();
    expect(posted).not.toBeNull();
    expect((posted as unknown as { first_referee: string }).first_referee).toBe('Gastspieler Ohne Akte');
  });
});

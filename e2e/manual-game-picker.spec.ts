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
  // Filed surname-first, the way half the XLSX is.
  { id: 'c4', full_name: 'Zwahlen Rita', first_name: 'Rita', last_name: 'Zwahlen', email: 'rita@example.ch', season: 2026, referee_id: '90003' },
];

// The register: every licensed referee, coachee or not, keyed by SV-Nr.
const DIRECTORY = {
  source: 'roster',
  people: [
    { id: '90001', name: 'Peter Pfeifer', email: 'peter.pfeifer@example.ch', level: 'N2' },
    // Already a coachee — the coachee row is the one that decides where the
    // feedback goes, so this address must not be the one on offer.
    { id: '90002', name: 'Luca Canepa', email: 'vm.luca@example.ch', level: 'N3' },
    // The same person as the surname-first coachee above, and linked by number
    // rather than by the spelling the two lists disagree on.
    { id: '90003', name: 'Rita Zwahlen', email: 'vm.rita@example.ch', level: 'N4' },
    { id: '90004', name: 'Jürg Müller', email: 'vm.juerg@example.ch', level: 'N2' },
    { id: '90005', name: 'Nina Ohnemail', email: 'vm.nina@example.ch', level: 'N4' },
  ],
};

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
  await page.route('**/api/admin/referees*', (r) => r.fulfill({ json: DIRECTORY }));
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
    // The current season's address, and the coachee's — not VolleyManager's.
    await expect(option).toContainText('luca@example.ch');
    await expect(option).not.toContainText('vm.luca@example.ch');
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

  test('a referee who is no coachee is offered, marked as unable to receive', async ({ page }) => {
    await openManualGameForm(page);

    // Not on the coachee list at all — but VolleyManager knows him, and the
    // point of the list is that every referee can be put on a test game.
    await page.locator('#mg-ref1').fill('pfeifer');
    const option = page.getByRole('button', { name: /Peter Pfeifer/ });
    await expect(option).toContainText('peter.pfeifer@example.ch');
    // Said before the pick, not as a 422 at the end of a filled-in form.
    await expect(option).toContainText(/kein Coachee|not a coachee/);
    await option.click();
    await expect(fieldNote(page, 'mg-ref1')).toHaveText(/kein Coachee|not a coachee/);
  });

  test('a coachee filed surname-first is not offered a second time as a stranger', async ({ page }) => {
    await openManualGameForm(page);

    await page.locator('#mg-ref1').fill('zwahlen');
    const option = page.getByRole('button', { name: /Zwahlen|Rita/ });
    await expect(option).toHaveCount(1);
    await expect(option).toContainText('rita@example.ch');
    await expect(option).not.toContainText(/kein Coachee|not a coachee/);
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
    const sent = posted as unknown as { first_referee: string; first_referee_id: string };
    expect(sent.first_referee).toBe('Gastspieler Ohne Akte');
    // Nobody in the register, so no number to send — and none invented.
    expect(sent.first_referee_id).toBe('');
  });

  test('a referee picked off the register puts their SV number on the game', async ({ page }) => {
    await openManualGameForm(page);

    let posted: Record<string, unknown> | null = null;
    await page.route('**/api/admin/games', (r) => {
      posted = r.request().postDataJSON();
      return r.fulfill({ status: 201, json: { id: 'g-new', match_no: 'TEST-2' } });
    });

    await page.locator('#mg-ref1').fill('canepa');
    await page.getByRole('button', { name: /Luca Canepa/ }).click();
    await page.locator('#mg-ref2').fill('pfeifer');
    await page.getByRole('button', { name: /Peter Pfeifer/ }).click();

    // The kick-off is a field, and it is Swiss wall-clock time: the form used to
    // append "20:00:00.000Z", which is 22:00 in Zurich in summer.
    await page.locator('#mg-time').fill('14:30');

    await page.getByRole('button', { name: /Spiel anlegen|Create game/ }).click();
    await expect(page.getByText(/(Angelegt|Created): TEST-2/)).toBeVisible();
    const sent = posted as unknown as { first_referee_id: string; second_referee_id: string; match_date: string; match_time: string };
    // The name is what prints; this is what the feedback will match on.
    expect(sent.first_referee_id).toBe('90002');
    expect(sent.second_referee_id).toBe('90001');
    // A bare date and a wall clock — the region is the server's to apply.
    expect(sent.match_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sent.match_time).toBe('14:30');
  });
});

import { test, expect, type Page } from '@playwright/test';
import { randomInt } from 'node:crypto';
import { stubSignedInApp } from './support/app';
import { manualMatchNo } from '../server/dataHygiene';

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
  await page.goto('/admin');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).click();
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
    // Case-insensitive: the label is sentence case now, and what this checks is
    // that the missing address is MARKED, not how the marker is capitalised.
    await expect(fieldNote(page, 'mg-ref1')).toHaveText(/keine E-Mail|no email/i);
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

  test('a name edited after the pick leaves without its number', async ({ page }) => {
    await openManualGameForm(page);

    let posted: Record<string, unknown> | null = null;
    await page.route('**/api/admin/games', (r) => {
      posted = r.request().postDataJSON();
      return r.fulfill({ status: 201, json: { id: 'g-new', match_no: 'TEST-3' } });
    });

    // Picked, then typed over: the number rode in with the pick and must not
    // stay behind for a name that is no longer the picked person's.
    await page.locator('#mg-ref1').fill('canepa');
    await page.getByRole('button', { name: /Luca Canepa/ }).click();
    await page.locator('#mg-ref1').fill('Luca Canepa-Meier');
    await page.locator('#mg-ref1').press('Escape');

    await page.getByRole('button', { name: /Spiel anlegen|Create game/ }).click();
    await expect(page.getByText(/(Angelegt|Created): TEST-3/)).toBeVisible();
    const sent = posted as unknown as { first_referee: string; first_referee_id: string };
    expect(sent.first_referee).toBe('Luca Canepa-Meier');
    expect(sent.first_referee_id).toBe('');
  });
});

// ── One number, one game ──────────────────────────────────────────────
// The number is what the reminder, the survey and the Börse look a game up
// by; a typed duplicate would make every one of those mean whichever row
// sorts newest. The server refuses it naming the game, and the default it
// hands a game without one is the day and four random characters — the old
// six clock digits wrapped every 16.7 minutes and were never checked.

test.describe('the match number of a manual game', () => {
  test('a typed number another game holds is refused, and the refusal names that game', async ({ page }) => {
    await openManualGameForm(page);
    await page.route('**/api/admin/games', (r) => r.fulfill({
      status: 409,
      json: { error: 'Die Spiel-Nr. 2345678 gibt es schon: VBC Züri Unterland – Volley Näfels II, 15.11.2026.' },
    }));

    await page.getByLabel(/Spiel-Nr\.|Match no\./).fill('2345678');
    await page.getByRole('button', { name: /Spiel anlegen|Create game/ }).click();
    // The server's sentence, with the game in it — not "Could not create game".
    await expect(page.getByText(/gibt es schon: VBC Züri Unterland – Volley Näfels II, 15\.11\.2026/)).toBeVisible();
    await expect(page.getByText(/(Angelegt|Created):/)).toHaveCount(0);
  });

  test('the generated number is TEST-<day>-<four base-36 characters>', () => {
    // The shape, with node's own random source — what the server passes.
    expect(manualMatchNo('2026-09-16', randomInt)).toMatch(/^TEST-\d{8}-[a-z0-9]{4}$/);
    expect(manualMatchNo('2026-09-16', randomInt)).toMatch(/^TEST-20260916-/);
    // Every value in [0, 36) is a character; the ends of the alphabet both print.
    expect(manualMatchNo('2026-01-02', () => 0)).toBe('TEST-20260102-0000');
    expect(manualMatchNo('2026-01-02', () => 35)).toBe('TEST-20260102-zzzz');
  });
});

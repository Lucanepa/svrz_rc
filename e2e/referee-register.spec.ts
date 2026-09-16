import { test, expect, type Page } from '@playwright/test';
import * as XLSX from 'xlsx';
import { stubSignedInApp } from './support/app';
import { refereeLinkProblem, planRefereeIdBackfill, planCoacheeLinks } from '../server/dataHygiene';
import { registerNumbers } from '../server/coacheeIndex';

// The referee register: the SVRZ "Schiedsrichter verwalten" export, read for
// the one column every other list in this app lacks — the SV-Nr. Names are
// spelled two ways in two exports, change on marriage, and are shared often
// enough that the contact sync has to refuse those cases outright; a number is
// none of those things.

/** A workbook shaped like the real export: its own title on row 1, a blank
 *  row, the column names on row 3. The real file holds 143 referees and their
 *  home addresses, so this is a stand-in — same shape, invented people. */
function registerXlsx(): Buffer {
  const rows = [
    ['Schiedsrichter verwalten'],
    [],
    ['SV-Nr.', 'Nachname', 'Vorname', 'Geburtsdatum', 'Geschlecht', 'Niveau', 'Niveaustufe', 'LR-Niveau',
      'Nationalität', 'Aktive Lizenz', 'Lizenzverband', 'Zurückgetreten', 'Dispensiert', 'Korrespondenz-Sprache',
      'E-Mail-Adresse', 'Telefon-Nr.', 'Anschrift', 'PLZ', 'Ort'],
    ['34536', 'Beispiel', 'Bea', '1990-01-01', 'F', 'N3', '1', 'L2', 'Schweiz', 'Ja', 'SVRZ', 'Nein', 'Nein', 'de',
      'bea@example.ch', '+41790000001', 'Musterweg 1', '8000', 'Zürich'],
    ['155732', 'Zwahlen', 'Rita', '1985-05-05', 'F', 'N2', '2', '', 'Schweiz', 'Nein', 'SVRNO', 'Nein', 'Nein', 'de',
      'rita@example.ch', '+41790000002', 'Musterweg 2', '8000', 'Zürich'],
    // No number: not a referee this register can key on, so not imported.
    ['', 'Ohnenummer', 'Nils', '', 'M', 'N4', '3', '', '', 'Ja', 'SVRZ', 'Nein', 'Nein', 'de', 'nils@example.ch', '', '', '', ''],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('the XLSX is read for its numbers, and the coachees it links are reported', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/admin/referees', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ json: { source: 'roster', people: [] } });
  });

  let sent: { referees: Record<string, unknown>[] } | null = null;
  await page.route('**/api/admin/referees/import', (r) => {
    sent = r.request().postDataJSON();
    return r.fulfill({
      json: {
        created: 2, updated: 0, skipped: 1, total: 2,
        linked: 1, alreadyLinked: 0,
        unmatched: ['Nie Registriert'],
        ambiguousNames: ['Zwei Gleichnamige'],
        // The third step: the stored games, given their numbers.
        backfill: { games: 10, filled: 4, already: 2, blank: 0, unresolved: ['Gast Ohne Akte'], ambiguous: ['Doppel Name'] },
      },
    });
  });

  await page.goto('/admin');
  await page.getByLabel(/Register importieren|Import register/).setInputFiles({
    name: 'Schiedsrichter-verwalten.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: registerXlsx(),
  });

  await expect(page.getByText(/2 (neu|new), 0/)).toBeVisible();
  // Ambiguity is the outcome that needs a person; it is said out loud.
  await expect(page.getByText(/Zwei Gleichnamige/)).toBeVisible();
  await expect(page.getByText(/Nie Registriert/)).toBeVisible();
  // The games backfill's report rides on the same answer, with its own two
  // lists: a game's name is VolleyManager's, and only the register can
  // settle it — unlike a coachee, who is linked by hand in the list above.
  await expect(page.getByText(/4 SR-Einträge|4 referee slots/)).toBeVisible();
  await expect(page.getByText(/Doppel Name/)).toBeVisible();
  await expect(page.getByText(/Gast Ohne Akte/)).toBeVisible();

  const rows = (sent as unknown as { referees: Record<string, unknown>[] }).referees;
  // The row with no SV-Nr. never leaves the browser.
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    sv_number: '34536', first_name: 'Bea', last_name: 'Beispiel', full_name: 'Bea Beispiel',
    email: 'bea@example.ch', level: 'N3', stage: '1', lr_level: 'L2',
    license_association: 'SVRZ', license_active: true, retired: false, dispensed: false, language: 'de',
  });
  // "Nein" is a withdrawn licence, not a missing column.
  expect(rows[1]).toMatchObject({ sv_number: '155732', license_active: false });
  // Read for identity, contact and level — never for where somebody lives.
  expect(Object.keys(rows[0]).some((k) => /address|anschrift|plz|birth|geburt/i.test(k))).toBe(false);
});

// ── The hand-link ─────────────────────────────────────────────────────
// A coachee the register could not link — a name it holds twice, a sheet
// spelling it does not know — is linked by hand in the coachee list: a pick
// off the register, never a typed number, so a typo cannot create a phantom
// identity the games would then match nobody to.

const REGISTER = {
  source: 'roster',
  people: [
    { id: '90001', name: 'Peter Pfeifer', email: 'peter@example.ch', level: 'N2' },
    { id: '90003', name: 'Rita Zwahlen', email: 'rita@example.ch', level: 'N4' },
    { id: '90004', name: 'Jürg Müller', email: 'juerg@example.ch', level: 'N2' },
  ],
};

const status = { needsObservation: true, count: 0 };
const COACHEES = [
  { id: 'c1', full_name: 'Rita Zwahlen', first_name: 'Rita', last_name: 'Zwahlen', email: 'rita@example.ch', season: 2026, referee_id: '90003', observation_status: status },
  // Linked by nobody yet: the register holds her under another spelling.
  { id: 'c2', full_name: 'Jürg Mueller', first_name: 'Jürg', last_name: 'Mueller', email: 'juerg@example.ch', season: 2026, referee_id: '', observation_status: status },
];

async function openCoacheeTab(page: Page, coachees = COACHEES) {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: coachees }));
  await page.route('**/api/admin/referees', (r) => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ json: REGISTER });
  });
  await page.goto('/admin');
  await expect(page.getByText('Zwahlen, Rita')).toBeVisible();
}

/** The row as listed ("Nachname, Vorname"), for its edit button and, once
 *  editing, its save button — the list is ordered by surname, so "first"
 *  is not a name. */
const row = (page: Page, listed: string) => page.locator('div.py-2').filter({ hasText: listed });
async function editRow(page: Page, listed: string) {
  await row(page, listed).getByRole('button', { name: /Bearbeiten|Edit/ }).click();
}
/** The tick on the open edit row. */
const saveRow = (page: Page, fieldId: string) =>
  page.locator('div.py-2').filter({ has: page.locator(`#${fieldId}`) }).getByRole('button', { name: /Speichern|Save/ });

/** The PUT the save sends, and the answer it gets. */
async function stubSave(page: Page, id: string, reply: { status?: number; json: Record<string, unknown> }) {
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**/api/coachees/${id}`, (r) => {
    if (r.request().method() !== 'PUT') return r.fallback();
    bodies.push(r.request().postDataJSON());
    return r.fulfill({ status: reply.status ?? 200, json: reply.json });
  });
  return bodies;
}

test.describe('the SV-Nr. field on a coachee', () => {
  test('the edit form shows the linked referee by name and number', async ({ page }) => {
    await openCoacheeTab(page);
    await editRow(page, 'Zwahlen, Rita');
    const field = page.locator('#coachee-sv-c1');
    await expect(field).toHaveValue('Rita Zwahlen');
    await expect(page.locator('#coachee-sv-c1 ~ span')).toHaveText(/SV-Nr\. 90003|SV no\. 90003/);
  });

  test('a pick off the register sets the number; the save sends it', async ({ page }) => {
    await openCoacheeTab(page);
    const bodies = await stubSave(page, 'c2', { json: { id: 'c2' } });
    await editRow(page, 'Mueller, Jürg');
    const field = page.locator('#coachee-sv-c2');
    // Typing alone is no link — said under the field until a row is picked.
    await field.fill('muller');
    await expect(page.locator('#coachee-sv-c2 ~ span')).toHaveText(/Nur aus dem Register|Register entries only/);
    await page.getByRole('button', { name: /Jürg Müller/ }).click();
    await expect(field).toHaveValue('Jürg Müller');
    await expect(page.locator('#coachee-sv-c2 ~ span')).toHaveText(/SV-Nr\. 90004|SV no\. 90004/);
    await saveRow(page, 'coachee-sv-c2').click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].referee_id).toBe('90004');
  });

  test('clearing the field unlinks: the save sends an empty number', async ({ page }) => {
    await openCoacheeTab(page);
    const bodies = await stubSave(page, 'c1', { json: { id: 'c1' } });
    await editRow(page, 'Zwahlen, Rita');
    const field = page.locator('#coachee-sv-c1');
    await field.fill('');
    // An emptied field opens the whole list; closed the way a person would.
    await field.press('Escape');
    await saveRow(page, 'coachee-sv-c1').click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].referee_id).toBe('');
  });

  test('a name edited after the pick drops the number', async ({ page }) => {
    await openCoacheeTab(page);
    const bodies = await stubSave(page, 'c1', { json: { id: 'c1' } });
    await editRow(page, 'Zwahlen, Rita');
    const field = page.locator('#coachee-sv-c1');
    await field.fill('Rita Zwahlen-Meier');
    await expect(page.locator('#coachee-sv-c1 ~ span')).toHaveText(/Nur aus dem Register|Register entries only/);
    await field.press('Escape');
    await saveRow(page, 'coachee-sv-c1').click();
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].referee_id).toBe('');
  });

  test('the server\'s refusals are shown as its sentence, not as a JSON envelope', async ({ page }) => {
    await openCoacheeTab(page);
    // A number that is not in the register (400), then one another row of
    // the season holds (409, naming the row).
    await stubSave(page, 'c2', { status: 409, json: { error: 'Die SV-Nr. 90003 ist in der Saison 2026/27 bereits „Rita Zwahlen" zugeordnet.' } });
    await editRow(page, 'Mueller, Jürg');
    const field = page.locator('#coachee-sv-c2');
    await field.fill('zwahlen');
    await page.getByRole('button', { name: /Rita Zwahlen/ }).click();
    await saveRow(page, 'coachee-sv-c2').click();
    await expect(page.getByText(/bereits „Rita Zwahlen" zugeordnet/)).toBeVisible();
    await expect(page.getByText(/{"error"/)).toHaveCount(0);
  });

  test('the badge counts the coachees still matched by name, and pressed, shows only them', async ({ page }) => {
    await openCoacheeTab(page);
    const badge = page.getByRole('button', { name: /1 Coachee ohne SV-Nr\.|1 coachee without an SV number/ });
    await expect(badge).toBeVisible();
    await badge.click();
    await expect(page.getByText('Zwahlen, Rita')).toHaveCount(0);
    await expect(page.getByText('Mueller, Jürg')).toBeVisible();
    await badge.click();
    await expect(page.getByText('Zwahlen, Rita')).toBeVisible();
  });
});

// The two register writes on their own. They moved from the register card
// to the Datenqualität card beside it (admin-identity-audit.spec.ts) — same
// buttons, same sentences, one card for everything that is left to link.
test.describe('the two register buttons', () => {
  test('"Coachees jetzt verknüpfen" runs the link on its own and reports', async ({ page }) => {
    await openCoacheeTab(page);
    let calls = 0;
    await page.route('**/api/admin/coachees/link-referees', (r) => {
      calls += 1;
      return r.fulfill({ json: { linked: 2, alreadyLinked: 5, unmatched: ['Nie Registriert'], ambiguousNames: [] } });
    });
    await page.getByRole('button', { name: /Coachees jetzt verknüpfen|Link coachees now/ }).click();
    await expect(page.getByText(/2 Coachees neu mit ihrer SV-Nr\. verknüpft, 5|2 coachees newly linked to their SV number, 5/)).toBeVisible();
    await expect(page.getByText(/Nie Registriert/)).toBeVisible();
    expect(calls).toBe(1);
  });

  test('"SV-Nr. auf Spielen nachtragen" runs the games backfill and reports', async ({ page }) => {
    await openCoacheeTab(page);
    let calls = 0;
    await page.route('**/api/admin/games/backfill-referee-ids', (r) => {
      calls += 1;
      return r.fulfill({ json: { games: 300, filled: 41, already: 190, blank: 12, unresolved: ['Gast Ohne Akte'], ambiguous: ['Doppel Name'] } });
    });
    await page.getByRole('button', { name: /SV-Nr\. auf Spielen nachtragen|Add SV numbers to games/ }).click();
    await expect(page.getByText(/41 SR-Einträge|41 referee slots/)).toBeVisible();
    await expect(page.getByText(/Doppel Name/)).toBeVisible();
    await expect(page.getByText(/Gast Ohne Akte/)).toBeVisible();
    expect(calls).toBe(1);
  });
});

// ── The rules, without a browser ──────────────────────────────────────
// What the server answers a link with, and which game slots the backfill
// may fill — pure in server/dataHygiene.ts, pinned here on fixtures.

test.describe('refereeLinkProblem — what a hand-link may write', () => {
  const register = [
    { sv_number: '90001', first_name: 'Peter', last_name: 'Pfeifer', full_name: 'Peter Pfeifer' },
    { sv_number: '90003', first_name: 'Rita', last_name: 'Zwahlen', full_name: 'Rita Zwahlen' },
  ];
  const coachees = [
    { id: 'c1', full_name: 'Rita Zwahlen', season: 2026, referee_id: '90003' },
    { id: 'c0', full_name: 'Rita Zwahlen', season: 2025, referee_id: '90003' },
    { id: 'c2', full_name: 'Jürg Mueller', season: 2026, referee_id: '' },
    { id: 'old', full_name: 'Olga Ohne', season: null, referee_id: '90001' },
  ];

  test('an empty number always may — it unlinks', () => {
    expect(refereeLinkProblem({ sv: '', season: 2026, rowId: 'c1' }, register, coachees)).toBeNull();
    expect(refereeLinkProblem({ sv: '', season: 2026, rowId: 'c1' }, [], coachees)).toBeNull();
  });

  test('a number the register does not hold is refused (400)', () => {
    const problem = refereeLinkProblem({ sv: '12345', season: 2026, rowId: 'c2' }, register, coachees);
    expect(problem?.status).toBe(400);
    expect(problem?.error).toContain('12345');
    // Before the register has been imported there is nothing to link to.
    expect(refereeLinkProblem({ sv: '90003', season: 2026, rowId: 'c2' }, [], coachees)?.status).toBe(400);
  });

  test('a number another row of the same season holds is refused (409), naming that row', () => {
    const problem = refereeLinkProblem({ sv: '90003', season: 2026, rowId: 'c2' }, register, coachees);
    expect(problem?.status).toBe(409);
    expect(problem?.error).toContain('Rita Zwahlen');
    expect(problem?.error).toContain('2026/27');
  });

  test('the row\'s own number, and a row of another season, are no conflict', () => {
    expect(refereeLinkProblem({ sv: '90003', season: 2026, rowId: 'c1' }, register, coachees)).toBeNull();
    // Coached again next season: the same referee, a new row.
    expect(refereeLinkProblem({ sv: '90003', season: 2027, rowId: '' }, register, coachees)).toBeNull();
    // A seasonless row is every season's and blocks none of them.
    expect(refereeLinkProblem({ sv: '90001', season: 2026, rowId: 'c2' }, register, coachees)).toBeNull();
    // Two seasonless rows on one number are a same-season tie.
    expect(refereeLinkProblem({ sv: '90001', season: null, rowId: 'new' }, register, coachees)?.status).toBe(409);
  });
});

test.describe('planCoacheeLinks — which coachee rows get their number from the register', () => {
  const register = [
    { id: 'p', sv_number: '90001', first_name: 'Peter', last_name: 'Pfeifer', full_name: 'Peter Pfeifer' },
    { id: 'r', sv_number: '90003', first_name: 'Rita', last_name: 'Zwahlen', full_name: 'Rita Zwahlen' },
    // The licence name, middle names and all, for the everyday "Kevin Peña".
    { id: 'k', sv_number: '90007', first_name: 'Kevin León', last_name: 'Peña de los Santos', full_name: 'Kevin León Peña de los Santos' },
    // Two licences under one spelling.
    { id: 'm1', sv_number: '90010', first_name: 'Max', last_name: 'Muster', full_name: 'Max Muster' },
    { id: 'm2', sv_number: '90011', first_name: 'Max', last_name: 'Muster', full_name: 'Max Muster' },
    // Two register names holding every word of "Anna Meier".
    { id: 'a1', sv_number: '90020', first_name: 'Anna', last_name: 'Meier Huber', full_name: 'Anna Meier Huber' },
    { id: 'a2', sv_number: '90021', first_name: 'Anna Lea', last_name: 'Meier', full_name: 'Anna Lea Meier' },
  ];

  test('a spelling the register holds once, in either order, or by its words', () => {
    const plan = planCoacheeLinks(register, [
      { id: 'c1', full_name: 'Rita Zwahlen', season: 2026, referee_id: '' },
      { id: 'c2', full_name: 'Pfeifer Peter', first_name: 'Peter', last_name: 'Pfeifer', season: 2026, referee_id: '' },
      { id: 'c3', full_name: 'Kevin Peña', season: 2026, referee_id: '' },
      { id: 'c4', full_name: 'Rita Zwahlen', season: 2025, referee_id: '90003' },
    ]);
    expect(plan.writes).toEqual([
      { id: 'c1', sv: '90003', name: 'Rita Zwahlen' },
      { id: 'c2', sv: '90001', name: 'Pfeifer Peter' },
      { id: 'c3', sv: '90007', name: 'Kevin Peña' },
    ]);
    expect(plan.alreadyLinked).toBe(1);
    expect(plan.unmatched).toEqual([]);
    expect(plan.ambiguousNames).toEqual([]);
  });

  test('a name the register holds twice, as a spelling or by its words, is ambiguous — not "not in the register"', () => {
    const plan = planCoacheeLinks(register, [
      { id: 'c1', full_name: 'Max Muster', season: 2026, referee_id: '' },
      { id: 'c2', full_name: 'Anna Meier', season: 2026, referee_id: '' },
      { id: 'c3', full_name: 'Nie Registriert', season: 2026, referee_id: '' },
      // A lone surname is a claim about a family, not a person.
      { id: 'c4', full_name: 'Meier', season: 2026, referee_id: '' },
    ]);
    expect(plan.writes).toEqual([]);
    expect(plan.ambiguousNames).toEqual(['Max Muster', 'Anna Meier']);
    expect(plan.unmatched).toEqual(['Nie Registriert', 'Meier']);
  });

  test('a licence another row of the same season already holds is refused, the way the hand-link refuses it', () => {
    // The same person twice in one season — "Kevin Peña" imported, "Peña
    // Kevin" typed in by hand — must not end up as two rows on one number:
    // the index would resolve every game to whichever sorts first, and the
    // other row would never receive a game or a feedback.
    const plan = planCoacheeLinks(register, [
      { id: 'c1', full_name: 'Kevin Peña', season: 2026, referee_id: '90007' },
      { id: 'c2', full_name: 'Peña Kevin', season: 2026, referee_id: '' },
      // Another season is the same referee coached again — allowed.
      { id: 'c3', full_name: 'Kevin Peña', season: 2025, referee_id: '' },
    ]);
    expect(plan.writes).toEqual([{ id: 'c3', sv: '90007', name: 'Kevin Peña' }]);
    expect(plan.ambiguousNames).toEqual(['Peña Kevin']);
  });

  test('two unlinked rows of one season resolving to one licence: the first is linked, the second refused', () => {
    // A number written in this run counts for the rows after it.
    const plan = planCoacheeLinks(register, [
      { id: 'c1', full_name: 'Rita Zwahlen', season: 2026, referee_id: '' },
      { id: 'c2', full_name: 'Zwahlen Rita', season: 2026, referee_id: '' },
    ]);
    expect(plan.writes).toEqual([{ id: 'c1', sv: '90003', name: 'Rita Zwahlen' }]);
    expect(plan.ambiguousNames).toEqual(['Zwahlen Rita']);
  });

  test('the rows handed in are not written to', () => {
    const rows = [{ id: 'c1', full_name: 'Rita Zwahlen', season: 2026, referee_id: '' }];
    planCoacheeLinks(register, rows);
    expect(rows[0].referee_id).toBe('');
  });

  test('an empty register links nobody and reports nobody', () => {
    const plan = planCoacheeLinks([], [{ id: 'c1', full_name: 'Rita Zwahlen', season: 2026, referee_id: '' }]);
    expect(plan).toEqual({ writes: [], alreadyLinked: 0, unmatched: [], ambiguousNames: [] });
  });
});

test.describe('planRefereeIdBackfill — which game slots get a number', () => {
  const register = [
    { sv_number: '90001', first_name: 'Peter', last_name: 'Pfeifer', full_name: 'Peter Pfeifer' },
    { sv_number: '90003', first_name: 'Rita', last_name: 'Zwahlen', full_name: 'Rita Zwahlen' },
    // Two licences under one name.
    { sv_number: '90010', first_name: 'Max', last_name: 'Muster', full_name: 'Max Muster' },
    { sv_number: '90011', first_name: 'Max', last_name: 'Muster', full_name: 'Max Muster' },
  ];
  const numbersFor = registerNumbers(register);

  test('a blank slot whose name the register spells once is filled; a numbered one is left alone', () => {
    const plan = planRefereeIdBackfill([
      { id: 'g1', first_referee: 'Rita Zwahlen', first_referee_id: '', second_referee: 'Pfeifer Peter', second_referee_id: '' },
      { id: 'g2', first_referee: 'Rita Zwahlen', first_referee_id: '90003', second_referee: '', second_referee_id: '' },
    ], numbersFor);
    expect(plan.patches).toEqual([{ id: 'g1', patch: { first_referee_id: '90003', second_referee_id: '90001' } }]);
    expect(plan.filled).toBe(2);
    expect(plan.already).toBe(1);
    expect(plan.blank).toBe(1);
  });

  test('a stored number is never replaced, even when the register disagrees', () => {
    const plan = planRefereeIdBackfill([
      { id: 'g1', first_referee: 'Rita Zwahlen', first_referee_id: '77777', second_referee: '', second_referee_id: '' },
    ], numbersFor);
    expect(plan.patches).toEqual([]);
    expect(plan.already).toBe(1);
  });

  test('names the register does not hold, or holds twice, are reported once and never guessed', () => {
    const plan = planRefereeIdBackfill([
      { id: 'g1', first_referee: 'Max Muster', first_referee_id: '', second_referee: 'Gast Ohne Akte', second_referee_id: '' },
      { id: 'g2', first_referee: 'Max Muster', first_referee_id: '', second_referee: 'Gast Ohne Akte', second_referee_id: '' },
    ], numbersFor);
    expect(plan.patches).toEqual([]);
    expect(plan.ambiguous).toEqual(['Max Muster']);
    expect(plan.unresolved).toEqual(['Gast Ohne Akte']);
  });

  test('only the slot that gains a number is in the patch', () => {
    const plan = planRefereeIdBackfill([
      { id: 'g1', first_referee: 'Gast Ohne Akte', first_referee_id: '', second_referee: 'Rita Zwahlen', second_referee_id: '' },
    ], numbersFor);
    expect(plan.patches).toEqual([{ id: 'g1', patch: { second_referee_id: '90003' } }]);
  });
});

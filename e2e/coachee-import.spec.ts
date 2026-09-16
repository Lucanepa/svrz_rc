import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { stubSignedInApp } from './support/app';
import { inheritedRefereeId, startingRefereeId } from '../server/dataHygiene';
import { registerNumbers } from '../server/coacheeIndex';

// The xlsx import, end to end: a real workbook goes in through the file picker
// and we assert on the payload the browser actually posts. parseXlsx lives
// inside AdminConsole and is not exported, so this is the only way to cover the
// header-matching without testing a copy of the logic instead of the logic.
//
// The second half — what the server does with a row's SV number — is pure
// (server/dataHygiene.ts) and pinned below without a browser.

function sheet(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function importFile(page: import('@playwright/test').Page, buf: Buffer, reply: Record<string, unknown> = { created: 1, updated: 0, total: 1 }) {
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/coachees/import', async (r) => {
    posted.push(r.request().postDataJSON());
    await r.fulfill({ json: reply });
  });
  await page.goto('/admin');
  // By its label, not by "the xlsx input": the console has two of those now —
  // this one and the referee register's.
  await page.getByLabel(/xlsx importieren|Import xlsx/).setInputFiles({
    name: 'coachees.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: buf,
  });
  await expect.poll(() => posted.length).toBeGreaterThan(0);
  return posted[0];
}

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [] }));
});

test('a Telefon column is imported onto the coachee', async ({ page }) => {
  const body = await importFile(page, sheet([
    ['Name', 'Vorname', 'E-Mail', 'Telefon', 'Niveau', 'Stufe', 'Gruppe'],
    ['Rama', 'Endri', 'endri@example.ch', '+41 79 123 45 67', 'N3', '1', 'Varia'],
  ]));
  const rows = body.coachees as Record<string, string>[];
  expect(rows).toHaveLength(1);
  expect(rows[0].full_name).toBe('Endri Rama');
  expect(rows[0].phone).toBe('+41 79 123 45 67');
  expect(rows[0].email).toBe('endri@example.ch');
});

test('the Swiss spelling "Natel" is recognised too', async ({ page }) => {
  const body = await importFile(page, sheet([
    ['Name', 'Vorname', 'Natel'],
    ['Rama', 'Endri', '079 123 45 67'],
  ]));
  expect((body.coachees as Record<string, string>[])[0].phone).toBe('079 123 45 67');
});

test('a sheet with no phone column sends an empty one, never a wrong one', async ({ page }) => {
  // The server only writes a field when the value is truthy, so an empty string
  // here is what stops a re-import blanking a number maintained in the app.
  const body = await importFile(page, sheet([
    ['Name', 'Vorname', 'E-Mail'],
    ['Rama', 'Endri', 'endri@example.ch'],
  ]));
  const row = (body.coachees as Record<string, string>[])[0];
  expect(row.phone).toBe('');
  expect(row.email).toBe('endri@example.ch');
});

test('an SV-Nr. column is sent as the row\'s number; a sheet without one sends an empty one', async ({ page }) => {
  // The one column the commission could add to its sheet: with it a season
  // starts linked without a register re-import. Headed the way the SVRZ
  // export heads it, so the two files agree on the spelling.
  const body = await importFile(page, sheet([
    ['Name', 'Vorname', 'SV-Nr.', 'E-Mail'],
    ['Zwahlen', 'Rita', 34536, 'rita@example.ch'],
  ]));
  const row = (body.coachees as Record<string, string>[])[0];
  // A numeric cell comes through as the digits, never "34536.0".
  expect(row.referee_id).toBe('34536');
});

test('a sheet with no SV-Nr. column sends an empty one — "nothing said", not "unlink"', async ({ page }) => {
  const body = await importFile(page, sheet([
    ['Name', 'Vorname'],
    ['Zwahlen', 'Rita'],
  ]));
  expect((body.coachees as Record<string, string>[])[0].referee_id).toBe('');
});

test('the register link runs after the import, and its counts are shown', async ({ page }) => {
  await importFile(page, sheet([
    ['Name', 'Vorname'],
    ['Zwahlen', 'Rita'],
  ]), {
    created: 1, updated: 0, total: 1,
    linked: 1, alreadyLinked: 3, unmatched: ['Nie Registriert'], ambiguousNames: ['Zwei Gleichnamige'],
  });
  // The counts in a toast where the button was pressed...
  await expect(page.getByText(/1 neu verknüpft|1 newly linked/)).toBeVisible();
  // ...and the names that need a person, on the card. Ambiguity first: it is
  // the one outcome the link will not decide.
  await expect(page.getByText(/Zwei Gleichnamige/)).toBeVisible();
  await expect(page.getByText(/Nie Registriert/)).toBeVisible();
});

test('a sheet number that contradicts a linked one is kept as linked, and said so', async ({ page }) => {
  // A hand link is not the sheet's to undo: a one-digit typo in the SV
  // column is another valid licence, and written silently it would hang a
  // stranger's fixtures under this coachee.
  await importFile(page, sheet([
    ['Name', 'Vorname', 'SV-Nr.'],
    ['Peña', 'Kevin', 90070],
  ]), {
    created: 0, updated: 1, total: 1,
    svConflicts: [{ name: 'Kevin Peña', stored: '90007', sheet: '90070' }],
    linked: 0, alreadyLinked: 1, unmatched: [], ambiguousNames: [],
  });
  await expect(page.getByText(/die verknüpfte bleibt|the linked one stays/)).toBeVisible();
  await expect(page.getByText(/Kevin Peña \(90007 ≠ 90070\)/)).toBeVisible();
});

test.describe('inheritedRefereeId — a new season row starts with its person\'s number', () => {
  const rows = [
    { id: 'r25', full_name: 'Rita Zwahlen', season: 2025, referee_id: '90003' },
    { id: 'k25', full_name: 'Kevin Peña', season: 2025, referee_id: '90007' },
    // Two seasons, one number — one person.
    { id: 'k24', full_name: 'Peña Kevin', first_name: 'Kevin', last_name: 'Peña', season: 2024, referee_id: '90007' },
    // Two seasons, two numbers — two people behind one name, or a wrong link.
    { id: 'm25', full_name: 'Max Muster', season: 2025, referee_id: '90010' },
    { id: 'm24', full_name: 'Max Muster', season: 2024, referee_id: '90011' },
    // Coached before, never linked.
    { id: 'n25', full_name: 'Nina Neu', season: 2025, referee_id: '' },
    // A row of the season being imported, already numbered — not a source:
    // the import updates it rather than inheriting from it.
    { id: 's26', full_name: 'Sara Selbe', season: 2026, referee_id: '90020' },
    // Seasonless — an import predating the field.
    { id: 'o', full_name: 'Olga Ohne', season: null, referee_id: '90030' },
  ];

  test('the previous season\'s number carries over, whichever way the sheet orders the name', () => {
    expect(inheritedRefereeId('Rita Zwahlen', 2026, rows)).toBe('90003');
    expect(inheritedRefereeId('Zwahlen Rita', 2026, rows)).toBe('90003');
    // Accents fold: the sheet may write "Pena".
    expect(inheritedRefereeId('Kevin Pena', 2026, rows)).toBe('90007');
  });

  test('two seasons on one number are one source, not two', () => {
    expect(inheritedRefereeId('Kevin Peña', 2026, rows)).toBe('90007');
  });

  test('two different numbers inherit nothing', () => {
    expect(inheritedRefereeId('Max Muster', 2026, rows)).toBe('');
  });

  test('a person never linked, or never coached, inherits nothing', () => {
    expect(inheritedRefereeId('Nina Neu', 2026, rows)).toBe('');
    expect(inheritedRefereeId('Neu Hier', 2026, rows)).toBe('');
    expect(inheritedRefereeId('', 2026, rows)).toBe('');
  });

  test('a row of the same season is not a source', () => {
    expect(inheritedRefereeId('Sara Selbe', 2026, rows)).toBe('');
    // From any other season it is.
    expect(inheritedRefereeId('Sara Selbe', 2027, rows)).toBe('90020');
  });

  test('a seasonless row counts as another season', () => {
    expect(inheritedRefereeId('Olga Ohne', 2026, rows)).toBe('90030');
    expect(inheritedRefereeId('Olga Ohne', null, rows)).toBe('');
  });
});

test.describe('startingRefereeId — the register before the earlier rows', () => {
  const register = [
    { sv_number: '90003', first_name: 'Rita', last_name: 'Zwahlen', full_name: 'Rita Zwahlen' },
    // Two licences under one name.
    { sv_number: '90001', first_name: 'Lena', last_name: 'Meier', full_name: 'Lena Meier' },
    { sv_number: '90002', first_name: 'Lena', last_name: 'Meier', full_name: 'Lena Meier' },
    // The register now spells the everyday name under one licence...
    { sv_number: '90007', first_name: 'Kevin', last_name: 'Peña', full_name: 'Kevin Peña' },
    // ...where the word-subset heuristic once guessed this one.
    { sv_number: '90008', first_name: 'Kevin', last_name: 'Peña Rodriguez', full_name: 'Kevin Peña Rodriguez' },
  ];
  const numbersFor = registerNumbers(register);
  const rows = [
    // Last season's Lena was linked by hand to ONE of the two namesakes.
    { id: 'l25', full_name: 'Lena Meier', season: 2025, referee_id: '90001' },
    // Last season's Kevin was linked by the heuristic to the wrong licence.
    { id: 'k25', full_name: 'Kevin Peña', season: 2025, referee_id: '90008' },
    // Coached before under a spelling the register does not hold.
    { id: 'j25', full_name: 'Jürg Mueller', season: 2025, referee_id: '90004' },
  ];

  test('an exact register hit outranks an inherited number', () => {
    expect(startingRefereeId('Kevin Peña', 2026, rows, numbersFor)).toBe('90007');
    expect(startingRefereeId('Zwahlen Rita', 2026, rows, numbersFor)).toBe('90003');
  });

  test('a name the register holds twice inherits nothing — the ambiguity is not decided by last season', () => {
    expect(startingRefereeId('Lena Meier', 2026, rows, numbersFor)).toBe('');
  });

  test('a name the register does not hold falls back to the earlier rows', () => {
    expect(startingRefereeId('Jürg Mueller', 2026, rows, numbersFor)).toBe('90004');
    expect(startingRefereeId('Neu Hier', 2026, rows, numbersFor)).toBe('');
  });

  test('with no register there is only the inheritance', () => {
    expect(startingRefereeId('Kevin Peña', 2026, rows, registerNumbers([]))).toBe('90008');
  });
});

import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { stubSignedInApp } from './support/app';

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
      },
    });
  });

  await page.goto('/#/admin');
  await page.getByLabel(/Register importieren|Import register/).setInputFiles({
    name: 'Schiedsrichter-verwalten.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: registerXlsx(),
  });

  await expect(page.getByText(/2 (neu|new), 0/)).toBeVisible();
  // Ambiguity is the outcome that needs a person; it is said out loud.
  await expect(page.getByText(/Zwei Gleichnamige/)).toBeVisible();
  await expect(page.getByText(/Nie Registriert/)).toBeVisible();

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

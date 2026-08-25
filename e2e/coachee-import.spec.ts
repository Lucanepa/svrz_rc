import { test, expect } from '@playwright/test';
import * as XLSX from 'xlsx';
import { stubSignedInApp } from './support/app';

// The xlsx import, end to end: a real workbook goes in through the file picker
// and we assert on the payload the browser actually posts. parseXlsx lives
// inside AdminConsole and is not exported, so this is the only way to cover the
// header-matching without testing a copy of the logic instead of the logic.

function sheet(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

async function importFile(page: import('@playwright/test').Page, buf: Buffer) {
  const posted: Record<string, unknown>[] = [];
  await page.route('**/api/coachees/import', async (r) => {
    posted.push(r.request().postDataJSON());
    await r.fulfill({ json: { created: 1, updated: 0, total: 1 } });
  });
  await page.goto('/#/admin');
  await page.locator('input[type="file"][accept=".xlsx"]').setInputFiles({
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

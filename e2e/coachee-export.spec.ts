import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { stubSignedInApp } from './support/app';
import { coacheeExportTable } from '../src/lib/coacheeExport';
import { emptyGrade, type CoacheeSummary } from '../src/lib/statistics';
import { currentSeason } from '../src/lib/season';

/**
 * Admin → Coachees → Export: every coachee of the season in one table, the
 * roster's own columns first and what the season's observations say about
 * them after (counts, averages, trend, the latest answers, the two ticks).
 * The figures come from /api/admin/coachee-summaries; an API that predates
 * it still exports the roster columns.
 */

const SEASON = currentSeason();
const ZOE = { id: 'z1', full_name: 'Zoe Zwei', first_name: 'Zoe', last_name: 'Zwei', email: 'zoe@example.ch', phone: '+41 79 000 00 00', referee_level: 'N3', stage: '2', groups: 'Beförderung?', referee_id: '90001', season: SEASON };
const ANN = { id: 'a1', full_name: 'Ann Alt', first_name: 'Ann', last_name: 'Alt', email: 'ann@example.ch', referee_level: 'N4', stage: '1', groups: 'Varia', season: SEASON };
const SUMMARY: CoacheeSummary = {
  coacheeId: 'z1', observations: 3, obs1SR: 2, obs2SR: 1,
  grade: { obs: 3, items: 6, sum: 60 }, grade1SR: { obs: 2, items: 4, sum: 36 }, grade2SR: { obs: 1, items: 2, sum: 24 },
  firstDate: `${SEASON}-10-01`, lastDate: `${SEASON}-12-01`, firstAvg: 8, lastAvg: 12, trend: 'improved',
  einstufungUp: 2, einstufungSame: 1, einstufungDown: 0, lastEinstufung: 'up', lastMotivation: 'up', lastSpielniveau: 'normal',
  lastSecondBesuch: 'Y', lastSecondBesuchRole: '1SR', lastSrZiel: '2L', wantsPromotion: true, wantsCandidate: false, rcs: ['Anna Muster'],
};

test('the table: roster columns, then the season figures; a coachee never seen keeps empty figures', () => {
  const t = coacheeExportTable([ZOE, ANN], [SUMMARY], SEASON, 'DE');
  const col = (label: string) => t.columns.findIndex((c) => c.label === label);
  // Surname order.
  expect(t.rows.map((r) => r[0])).toEqual(['Alt', 'Zwei']);
  const zoe = t.rows[1];
  expect(zoe[col('E-Mail')]).toBe('zoe@example.ch');
  expect(zoe[col('Gruppe')]).toBe('Beförderung?');
  expect(zoe[col('Beob.')]).toBe(3);
  // Letters only — the ± stay on the form.
  expect(zoe[col('Ø Note')]).toBe('B');
  expect(zoe[col('Ø 2SR')]).toBe('B');
  expect(zoe[col('Ø erste')]).toBe('C');
  expect(zoe[col('Ø letzte')]).toBe('B');
  for (const row of t.rows) for (const cell of row) expect(String(cell ?? '')).not.toMatch(/\b[A-E][+\-−](?![\w])/);
  expect(zoe[col('Trend')]).toBe('Besser');
  expect(zoe[col('Einstufung ↑')]).toBe(2);
  expect(zoe[col('Letzte Einstufung')]).toBe('Beförderung');
  expect(zoe[col('Weiterer Besuch (letzter)')]).toBe('Y (1SR)');
  expect(zoe[col('Will befördert werden')]).toBe('Ja');
  expect(zoe[col('Kandidat:in nächste Saison')]).toBe('');
  const ann = t.rows[0];
  expect(ann[col('Beob.')]).toBe(0);
  expect(ann[col('Ø Note')]).toBe('');
  expect(ann).toHaveLength(t.columns.length);
  // Without the figures (an older API) only the roster columns are there.
  expect(coacheeExportTable([ZOE], null, SEASON, 'DE').columns.map((c) => c.label)).not.toContain('Ø Note');
  void emptyGrade;
});

async function openCoachees(page: import('@playwright/test').Page, summaries: 'ok' | 'missing' = 'ok') {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [ZOE, ANN] }));
  await page.route('**/api/admin/coachee-summaries*', (r) => (summaries === 'ok'
    ? r.fulfill({ json: { season: SEASON, summaries: [SUMMARY] } })
    : r.fulfill({ status: 404, body: 'Not found' })));
  await page.goto('/admin');
  await expect(page.getByTestId('coachees-export-xlsx')).toBeEnabled();
}

test('Export xlsx downloads every coachee with the figures', async ({ page }) => {
  await openCoachees(page);
  const dl = page.waitForEvent('download');
  await page.getByTestId('coachees-export-xlsx').click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/^svrz-rc-coachees-\d{4}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const wb = XLSX.read(readFileSync((await file.path())!));
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  expect(rows).toHaveLength(2);
  const zoe = rows.find((r) => r.Nachname === 'Zwei')!;
  expect(zoe['Beob.']).toBe(3);
  expect(zoe.Trend).toBe('Besser');
  expect(zoe['Will befördert werden']).toBe('Ja');
});

test('Export PDF downloads a landscape PDF', async ({ page }) => {
  await openCoachees(page);
  const dl = page.waitForEvent('download');
  await page.getByTestId('coachees-export-pdf').click();
  const file = await dl;
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // A4 landscape: the MediaBox is wider than it is tall.
  const box = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(bytes.toString('latin1'));
  expect(Number(box![1])).toBeGreaterThan(Number(box![2]));
});

test('an API without the figures still exports the roster, and says so', async ({ page }) => {
  await openCoachees(page, 'missing');
  const dl = page.waitForEvent('download');
  await page.getByTestId('coachees-export-xlsx').click();
  const file = await dl;
  const wb = XLSX.read(readFileSync((await file.path())!));
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]]);
  expect(Object.keys(rows[0])).not.toContain('Ø Note');
  await expect(page.getByText(/noch nicht verfügbar|not on the server yet/)).toBeVisible();
});

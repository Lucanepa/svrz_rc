import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';
import { statsResponse } from './support/statsFixture';
import { buildDeck } from '../src/lib/statsDeck';

// Admin → Statistik: the tab reads one aggregated response per season and
// filter slice, shows it as tiles, charts and tables, and exports the same
// numbers as a deck. The server's counting rules have their own spec
// (statistics-rules.spec.ts); this one is about the page.

async function openStats(page: Page) {
  const asked: string[] = [];
  await page.route('**/api/admin/statistics*', (r) => {
    const u = new URL(r.request().url());
    asked.push(u.search);
    const season = Number(u.searchParams.get('season'));
    const filters = {
      ...(u.searchParams.get('rc') ? { rc: u.searchParams.get('rc')! } : {}),
      ...(u.searchParams.get('group') ? { group: u.searchParams.get('group')! } : {}),
      ...(u.searchParams.get('level') ? { level: u.searchParams.get('level')! } : {}),
      ...(u.searchParams.get('role') ? { role: u.searchParams.get('role') as '1SR' | '2SR' } : {}),
    };
    r.fulfill({ json: statsResponse(season, filters, u.searchParams.get('compare') === '1') });
  });
  await page.goto('/admin/stats');
  await expect(page.getByTestId('stats-body')).toBeVisible();
  return asked;
}

test('the tab shows the season in numbers, and only asks once it is opened', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const asked: string[] = [];
  await page.route('**/api/admin/statistics*', (r) => {
    asked.push(new URL(r.request().url()).search);
    r.fulfill({ json: statsResponse(2026) });
  });

  // Another tab first: the statistics are not fetched behind it.
  await page.goto('/admin/overview');
  await expect(page.getByRole('button', { name: 'Statistik' }).first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);

  await page.getByRole('button', { name: 'Statistik' }).first().click();
  await expect(page).toHaveURL(/\/admin\/stats$/);
  await expect(page.getByTestId('stats-body')).toBeVisible();
  expect(asked).toEqual(['?season=2026&compare=1']);

  const expected = statsResponse(2026).stats.totals;
  const tiles = page.getByTestId('stats-tiles');
  await expect(tiles).toContainText('Beobachtungen');
  await expect(tiles).toContainText(String(expected.observations));
  await expect(tiles).toContainText(`${expected.coachees} / ${expected.roster}`);
  await expect(tiles).toContainText(String(expected.sets));
  // The comparison with the season before rides on the tiles as a delta chip.
  await expect(tiles).toContainText('+');

  // Per coach: every coach with a Pensum, observations first.
  const rcs = page.getByTestId('stats-rcs');
  await expect(rcs).toContainText('Anna Amsler');
  await expect(rcs).toContainText('Claudia Casanova');
  // The criteria block shows the 1. SR form and switches to the 2. SR one.
  const criteria = page.getByTestId('stats-criteria');
  await expect(criteria).toContainText('Absprache mit Schreiber und 2. SR');
  await criteria.getByRole('button', { name: '2. SR' }).click();
  await expect(criteria).toContainText('Absprache mit Schreiber und 1. SR');
  // Every block is there.
  for (const id of ['stats-months', 'stats-histogram', 'stats-sections', 'stats-groups', 'stats-levels', 'stats-coverage', 'stats-einstufung', 'stats-leagues', 'stats-games', 'stats-writing', 'stats-process', 'stats-fun']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }
});

test('filters re-query the server with the slice, and the season picker offers every season with data', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const asked = await openStats(page);

  await page.getByTestId('stats-filter-rc').selectOption('rc-beat');
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&rc=rc-beat&compare=1');
  // The slice shows only that coach.
  const rcs = page.getByTestId('stats-rcs');
  await expect(rcs).toContainText('Beat Brunner');
  await expect(rcs).not.toContainText('Anna Amsler');

  await page.getByTestId('stats-filter-role').selectOption('2SR');
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&rc=rc-beat&role=2SR&compare=1');

  await page.getByTestId('stats-filter-rc').selectOption('');
  await page.getByTestId('stats-filter-group').selectOption('Varia');
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&group=Varia&role=2SR&compare=1');

  // Comparison off → no compare flag, no delta chips.
  await page.getByLabel('Vergleich mit Vorsaison').uncheck();
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&group=Varia&role=2SR');

  const seasons = page.getByTestId('stats-season');
  await expect(seasons.locator('option')).toHaveText(['2026/27', '2025/26']);
  await seasons.selectOption('2025');
  await expect.poll(() => asked.at(-1)).toBe('?season=2025&group=Varia&role=2SR');
});

test('an average from a single observation is shown, but hollow and with its n', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await openStats(page);
  // N1 was visited once. The grade is real and stays visible — the coach did
  // grade — but the row is marked thin so one evening is not read as a pattern.
  const levels = page.getByTestId('stats-levels');
  const thin = levels.locator('[data-thin="true"]');
  await expect(thin).toHaveCount(1);
  await expect(thin).toContainText('N1');
  await expect(thin).toContainText('n = 1');
  // Eight visits on N3-2: a full dot, no warning.
  const solid = levels.locator('div.grid:has-text("N3-2")').first();
  await expect(solid).not.toHaveAttribute('data-thin', 'true');
  await expect(solid).toContainText('· 8');
});

test('the export builds a PowerPoint deck and a PDF from the same numbers', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await openStats(page);
  await page.getByTestId('stats-export').click();
  await expect(page.getByTestId('stats-export-menu')).toBeVisible();
  await page.getByLabel(/Noten pro Coach/).check();

  const pptx = page.waitForEvent('download');
  await page.getByTestId('stats-export-pptx').click();
  const pptxFile = await pptx;
  expect(pptxFile.suggestedFilename()).toMatch(/^svrz-rc-statistik-2026-27-\d{4}-\d{2}-\d{2}\.pptx$/);
  const pptxPath = await pptxFile.path();
  const { statSync } = await import('node:fs');
  expect(statSync(pptxPath!).size).toBeGreaterThan(20_000);

  // The deck can be asked for in the other language than the console's.
  await page.getByRole('radio', { name: 'EN' }).check();
  const pdf = page.waitForEvent('download');
  await page.getByTestId('stats-export-pdf').click();
  const pdfFile = await pdf;
  expect(pdfFile.suggestedFilename()).toMatch(/\.pdf$/);
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync((await pdfFile.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  // One page per slide, as many as the deck model says for this slice.
  const expected = buildDeck(statsResponse(2026).stats, { lang: 'EN', includeRcGrades: true, includeLeagues: false }).slides.length;
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  expect(pages).toBe(expected);
  expect(expected).toBeGreaterThanOrEqual(15);
});

test('the console\'s English follows into the tab', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.addInitScript(() => { try { localStorage.setItem('svrz_admin_lang', 'EN'); } catch { /* ignore */ } });
  await openStats(page);
  await expect(page.getByTestId('stats-tiles')).toContainText('Observations');
  await expect(page.getByTestId('stats-criteria')).toContainText('Briefing with scorer and 2nd referee');
});

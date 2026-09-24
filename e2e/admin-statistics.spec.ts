import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';
import { statsResponse } from './support/statsFixture';
import { buildDeck } from '../src/lib/statsDeck';
import { rcFirstNamer } from '../src/lib/statistics';

// Admin → Statistik: the tab reads one aggregated response per season and
// filter slice, shows it as tiles, charts and tables, and exports the same
// numbers as a deck. The server's counting rules have their own spec
// (statistics-rules.spec.ts); this one is about the page.

// The RC records the page names coaches from — first names only.
async function stubRcPeople(page: Page) {
  await page.route('**/api/admin/rc-people*', (r) => r.fulfill({ json: [
    { id: 'rc-anna', first_name: 'Anna', last_name: 'Amsler' },
    { id: 'rc-beat', first_name: 'Beat', last_name: 'Brunner' },
    { id: 'rc-cla', first_name: 'Claudia', last_name: 'Casanova' },
  ] }));
}

async function openStats(page: Page, opts: { oldApi?: boolean } = {}) {
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
    // An API from before the breakdowns ignores the flag.
    r.fulfill({ json: statsResponse(season, filters, u.searchParams.get('compare') === '1', !opts.oldApi && u.searchParams.get('breakdown') === '1') });
  });
  await stubRcPeople(page);
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
  expect(asked).toEqual(['?season=2026&compare=1&breakdown=1']);

  const expected = statsResponse(2026).stats.totals;
  const tiles = page.getByTestId('stats-tiles');
  await expect(tiles).toContainText('Beobachtungen');
  await expect(tiles).toContainText(String(expected.observations));
  await expect(tiles).toContainText(`${expected.coachees} / ${expected.roster}`);
  await expect(tiles).toContainText(String(expected.sets));
  // The comparison with the season before rides on the tiles as a delta chip.
  await expect(tiles).toContainText('+');

  // Per coach: every coach with a Pensum, observations first — by first name.
  const rcs = page.getByTestId('stats-rcs');
  await expect(rcs).toContainText('Anna');
  await expect(rcs).toContainText('Claudia');
  await expect(rcs).not.toContainText('Amsler');
  await expect(rcs).not.toContainText('Casanova');
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
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&rc=rc-beat&compare=1&breakdown=1');
  // The slice shows only that coach.
  const rcs = page.getByTestId('stats-rcs');
  await expect(rcs).toContainText('Beat');
  await expect(rcs).not.toContainText('Anna');
  // The RC picker names them by first name too.
  await expect(page.getByTestId('stats-filter-rc').locator('option')).toHaveText([/^alle$/i, 'Anna', 'Beat', 'Claudia']);

  await page.getByTestId('stats-filter-role').selectOption('2SR');
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&rc=rc-beat&role=2SR&compare=1&breakdown=1');

  await page.getByTestId('stats-filter-rc').selectOption('');
  // Level and group live in the bar at the bottom.
  const bar = page.getByTestId('stats-groupbar');
  await bar.getByRole('radio', { name: 'Gruppe' }).click();
  await bar.getByTestId('stats-filter-group').getByRole('button', { name: 'Varia' }).click();
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&group=Varia&role=2SR&compare=1&breakdown=1');

  // Comparison off → no compare flag, no delta chips.
  await page.getByLabel('Vergleich mit Vorsaison').uncheck();
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&group=Varia&role=2SR&breakdown=1');

  const seasons = page.getByTestId('stats-season');
  await expect(seasons.locator('option')).toHaveText(['2026/27', '2025/26']);
  await seasons.selectOption('2025');
  await expect.poll(() => asked.at(-1)).toBe('?season=2025&group=Varia&role=2SR&breakdown=1');
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
  const full = statsResponse(2026, {}, true, true);
  const expected = buildDeck(full.stats, { lang: 'EN', includeRcGrades: true, includeLeagues: false, breakdowns: full.breakdowns }).slides.length;
  const pages = (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  expect(pages).toBe(expected);
  expect(expected).toBeGreaterThanOrEqual(15);
  // The per-level and per-group sets ride along: more slides than the aggregate alone.
  expect(expected).toBeGreaterThan(buildDeck(full.stats, { lang: 'EN', includeRcGrades: true, includeLeagues: false }).slides.length + 10);
});

test('the console\'s English follows into the tab', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.addInitScript(() => { try { localStorage.setItem('svrz_admin_lang', 'EN'); } catch { /* ignore */ } });
  await openStats(page);
  await expect(page.getByTestId('stats-tiles')).toContainText('Observations');
  await expect(page.getByTestId('stats-criteria')).toContainText('Briefing with scorer and 2nd referee');
});

test('the bottom bar slices by Niveau, then Stufe, and lines the slices up in a table', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const asked = await openStats(page);
  const bar = page.getByTestId('stats-groupbar');
  await expect(bar.getByRole('radio', { name: 'Kein Filter' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('stats-compare')).toHaveCount(0);

  await bar.getByRole('radio', { name: 'Niveau' }).click();
  // One row per Niveau, read off the slices that came with the main answer —
  // no request per row.
  const table = page.getByTestId('stats-compare');
  await expect(table.locator('tbody tr')).toHaveText([/^N1/, /^N2/, /^N3/, /^N4/]);
  expect(asked.every((q) => q.includes('breakdown=1'))).toBe(true);
  // The trend column is there, and N3 has coachees seen more than once.
  await expect(table.locator('thead')).toContainText('Trend');
  await expect(table.locator('tbody tr', { hasText: /^N3/ })).toContainText('↑');

  await bar.getByTestId('stats-filter-level').getByRole('button', { name: 'N3' }).click();
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&level=N3&compare=1&breakdown=1');
  // The Stufen of N3 appear as a second row of chips, and the table goes one level down.
  const stufe = bar.getByTestId('stats-filter-stufe');
  await expect(stufe.getByRole('button')).toHaveText(['Ganzes N3', 'N3-1', 'N3-2', 'N3-3']);
  await expect(table.locator('tbody tr')).toHaveText([/^N3-1/, /^N3-2/, /^N3-3/]);
  await stufe.getByRole('button', { name: 'N3-2' }).click();
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&level=N3-2&compare=1&breakdown=1');
  // A single Niveau is not drawn as a one-bar chart; its Stufe is.
  await expect(page.getByTestId('stats-levels')).toContainText('N3-2');

  // Back to no filter: level cleared, the table gone.
  await bar.getByRole('radio', { name: 'Kein Filter' }).click();
  await expect.poll(() => asked.at(-1)).toBe('?season=2026&compare=1&breakdown=1');
  await expect(page.getByTestId('stats-compare')).toHaveCount(0);
});

test('an API without the slices still gets the table, one request per row', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  const asked = await openStats(page, { oldApi: true });
  await page.getByTestId('stats-groupbar').getByRole('radio', { name: 'Gruppe' }).click();
  await expect(page.getByTestId('stats-compare').locator('tbody tr').first()).toBeVisible();
  expect(asked).toContain('?season=2026&group=Varia');
});

test('the trend: first visit against the latest, overall and per level and group', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await openStats(page);
  const tr = statsResponse(2026).stats.trend!;
  expect(tr.coachees).toBeGreaterThan(0);
  const total = page.getByTestId('stats-trend-total');
  await expect(total).toContainText(String(tr.coachees));
  await expect(total).toContainText('Besser');
  await expect(page.getByTestId('stats-trend-level')).toContainText('N3');
  await expect(page.getByTestId('stats-trend-group')).toContainText('Varia');
});

test('with a filter on, empty figures are left out', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await openStats(page);
  // Unfiltered, every coach with a Pensum is listed, observed or not.
  await expect(page.getByTestId('stats-rcs').locator('tbody tr')).toHaveCount(3);

  const bar = page.getByTestId('stats-groupbar');
  await bar.getByRole('radio', { name: 'Gruppe' }).click();
  await bar.getByTestId('stats-filter-group').getByRole('button', { name: '2. Schiedsrichter' }).click();
  await expect(page.getByTestId('stats-body')).toBeVisible();
  // Only the coaches who observed this group stay, and no chart shows a bar
  // or a legend line at zero.
  const rcRows = page.getByTestId('stats-rcs').locator('tbody tr');
  await expect.poll(() => rcRows.count()).toBeLessThan(3);
  for (const row of await rcRows.all()) await expect(row.locator('td').nth(1)).not.toHaveText('0');
  for (const list of await page.getByTestId('stats-body').locator('span.tabular-nums.font-medium').all()) {
    await expect(list).not.toHaveText('0');
  }
});

test('coaches are named by first name; a shared one gets the initial', () => {
  const nameOf = rcFirstNamer([
    { id: 'a', first_name: 'Luca', last_name: 'Canepa' },
    { id: 'b', first_name: 'Luca', last_name: 'Meier' },
    { id: 'c', first_name: 'Thanh Ut', last_name: 'Nguyen' },
  ], ['Old Spelling Person']);
  expect(nameOf({ id: 'a', name: 'Luca Canepa' })).toBe('Luca C.');
  expect(nameOf({ id: 'b', name: 'Luca Meier' })).toBe('Luca M.');
  // The record's own first name, not the first word of the full one.
  expect(nameOf({ id: 'c', name: 'Thanh Ut Nguyen' })).toBe('Thanh Ut');
  expect(nameOf({ name: 'Thanh Ut Nguyen' })).toBe('Thanh Ut');
  // No record behind the name: its first word.
  expect(nameOf({ name: 'Old Spelling Person' })).toBe('Old');
});

test('the deck: one set of slides per level and per group, empty slices left out', () => {
  const full = statsResponse(2026, {}, true, true);
  const deck = buildDeck(full.stats, { lang: 'DE', includeRcGrades: false, includeLeagues: false, breakdowns: full.breakdowns });
  const titles = deck.slides.map((s) => s.title);
  expect(titles).toContain('Nach Niveau');
  expect(titles).toContain('Nach Gruppe');
  expect(titles).toContain('Entwicklung');
  for (const x of full.breakdowns!.level) {
    expect(titles.includes(`Niveau ${x.key}`)).toBe(x.stats.totals.observations > 0);
  }
  for (const x of full.breakdowns!.group) {
    expect(titles.some((t) => t.startsWith('Gruppe: '))).toBe(true);
    if (x.stats.totals.observations === 0) expect(titles.some((t) => t.endsWith(`: ${x.key}`))).toBe(false);
  }
  // No figure in a slice set is empty.
  for (const s of deck.slides) for (const f of s.figures ?? []) {
    const c = f.chart;
    const v = c.kind === 'columns' ? c.values.flat() : c.kind === 'diverging' ? [...c.neg, ...c.mid, ...c.pos] : c.values;
    if (s.title.startsWith('Niveau ') || s.title.startsWith('Gruppe: ')) expect(v.some((n) => n !== null && n > 0)).toBe(true);
  }
  // Without the slices, the deck is the aggregate alone.
  const plain = buildDeck(full.stats, { lang: 'DE', includeRcGrades: false, includeLeagues: false }).slides.map((s) => s.title);
  expect(plain.some((t) => t.startsWith('Niveau '))).toBe(false);
});

test('on a phone nothing on the page scrolls sideways — tables fold their extra columns under the name', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'Mobile viewport only');
  await stubSignedInApp(page, { admin: true });
  await openStats(page);
  await page.getByTestId('stats-groupbar').getByRole('radio', { name: 'Niveau' }).click();
  await expect(page.getByTestId('stats-compare').locator('tbody tr').first()).toBeVisible();
  const overflowing = await page.getByTestId('stats-body').evaluate((body) =>
    [...body.querySelectorAll<HTMLElement>('.overflow-x-auto')]
      .filter((el) => el.scrollWidth > el.clientWidth + 1)
      .map((el) => el.closest('[data-testid]')?.getAttribute('data-testid') ?? el.className));
  expect(overflowing).toEqual([]);
  // The folded figures are there, under the coach's name.
  await expect(page.getByTestId('stats-rcs').locator('tbody tr').first()).toContainText(/Coachees/);
});

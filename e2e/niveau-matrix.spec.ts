import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// Admin → Niveau edits the official SVRZ table "Übersicht SR-Niveau und Stufe",
// which decides which games are in a coachee's focus. A wrong cell here is not a
// cosmetic bug: it changes what every coach sees. So the three things that must
// hold are pinned — the published values are on screen, an edit is saved as an
// OVERRIDE of that row alone, and Reset puts the paper back.

const settingsBody = {
  default_season: 2026, test_mode: false, groups: [],
  coachee_targets: {}, rc_mandates: {}, default_goal: 10, niveau_table: {},
};

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/settings', (r) => r.fulfill({ json: settingsBody }));
});

// One league chip. Its accessible name carries the whole coordinate, so this
// works for both layouts: the table on a desktop and the per-level cards on a
// phone render the same buttons, and only the visible one has a role.
const chip = (page: Page, level: string, column: string, league: string) =>
  page.getByRole('button', { name: `${level} · ${column} · ${league}`, exact: true });

test('the published table is what the console shows', async ({ page }) => {
  await page.goto('/#/admin/niveau');

  // N3-3 · Herren · 1. SR is "4. Liga" on the paper, and nothing else.
  await expect(chip(page, 'N3-3', 'Herren 1. SR', '4. Liga')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'N3-3', 'Herren 1. SR', '3. Liga')).toHaveAttribute('aria-pressed', 'false');
  await expect(chip(page, 'N3-3', 'Herren 1. SR', '5. Liga')).toHaveAttribute('aria-pressed', 'false');

  // U23 is split by gender: N3-3 has DU23 1. Liga and no HU23 at all.
  await expect(chip(page, 'N3-3', 'DU23 1. SR', '1. Liga')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'N3-3', 'HU23 1. SR', '1. Liga')).toHaveAttribute('aria-pressed', 'false');

  // A cell holds a SET, which is why the paper can say "DU23 2. + 3. Liga".
  await expect(chip(page, 'N4-3', 'DU23 1. SR', '2. Liga')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'N4-3', 'DU23 1. SR', '3. Liga')).toHaveAttribute('aria-pressed', 'true');
  await expect(chip(page, 'N4-3', 'DU23 1. SR', '1. Liga')).toHaveAttribute('aria-pressed', 'false');

  // N1 is the only row that reaches the Nationalliga.
  await expect(chip(page, 'N1', 'Herren 1. SR', 'NL')).toHaveAttribute('aria-pressed', 'true');

  await expect(page.getByText('Keine Abweichung von der offiziellen Tabelle')).toBeVisible();
});

test('an edit is stored as an override of that row alone, and Reset undoes it', async ({ page }) => {
  const saved: { niveau_table: Record<string, { H1?: string[] }> }[] = [];
  await page.route('**/api/admin/settings', async (r) => {
    saved.push(JSON.parse(r.request().postData() || '{}'));
    await r.fulfill({ json: { ok: true } });
  });

  await page.goto('/#/admin/niveau');
  await chip(page, 'N3-3', 'Herren 1. SR', '3. Liga').click();

  await expect(page.getByText(/1 Zelle weicht von der offiziellen Tabelle ab/)).toBeVisible();
  await expect.poll(() => saved.length).toBeGreaterThan(0);
  // Only the row that differs travels — every untouched row keeps following the
  // table shipped in the code, so a future correction to it still lands.
  expect(Object.keys(saved[saved.length - 1].niveau_table)).toEqual(['N3-3']);
  expect(saved[saved.length - 1].niveau_table['N3-3'].H1).toEqual(['3', '4']);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Auf offizielle Tabelle zurücksetzen' }).click();
  await expect(page.getByText('Keine Abweichung von der offiziellen Tabelle')).toBeVisible();
  expect(Object.keys(saved[saved.length - 1].niveau_table)).toEqual([]);
});

test('the table says the focus hides rather than blocks', async ({ page }) => {
  // Said out loud by the first person who read the matrix: an unlit cell looks
  // like a ban. The sentence that says otherwise has to stay next to the grid.
  await page.goto('/#/admin/niveau');
  await expect(page.getByText(/blendet nur aus, er sperrt nichts/)).toBeVisible();
});

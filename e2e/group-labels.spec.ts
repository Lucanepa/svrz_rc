import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The groups in the database are the xlsx import's spellings — "Beförderung",
// "2. Schiedsrichter", "Neu-Schiedsrichter 26/27". None of them were in the
// English map, so an English reader got German badges for most of the roster
// while a few neighbouring groups translated fine. See lib/coacheeGroup.ts.

const status = { needsObservation: true, count: 0 };
const coachee = (id: string, full_name: string, groups: string) =>
  ({ id, full_name, groups, referee_level: 'N3', stage: '2', observation_status: status });

const COACHEES = [
  coachee('a', 'Aaa One', 'Beförderung'),
  coachee('b', 'Bbb Two', 'Neu-Schiedsrichter 26/27'),
  coachee('c', 'Ccc Three', '2. Schiedsrichter'),
  coachee('d', 'Ddd Four', 'Beförderung?/Varia'),
  // Not a group anyone maintains — whatever was typed shows as typed.
  coachee('e', 'Eee Five', 'Referee Coaching'),
  // The legacy participle, which a few old rows still carry and which really
  // does mean it happened.
  coachee('f', 'Fff Six', 'Befördert'),
  coachee('g', 'Ggg Seven', 'Rückstufung'),
];

test('the groups actually stored are shown in English, not left in German', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page.getByText('Aaa One')).toBeVisible();

  // The noun, not the participle: "Beförderung" is the cohort up for promotion,
  // not people it has already happened to.
  await expect(page.getByText('Promotion', { exact: true })).toBeVisible();
  await expect(page.getByText('New SR 26/27', { exact: true })).toBeVisible();
  await expect(page.getByText('2nd referee', { exact: true })).toBeVisible();
  await expect(page.getByText('Promotion? / Misc', { exact: true })).toBeVisible();
  await expect(page.getByText('Promoted', { exact: true })).toBeVisible();
  await expect(page.getByText('Demotion', { exact: true })).toBeVisible();
  // Unknown groups still pass through untouched rather than being dropped.
  await expect(page.getByText('Referee Coaching', { exact: true })).toBeVisible();

  // None of the German source spellings should survive into the English badge.
  await expect(page.getByText('Beförderung', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Neu-Schiedsrichter 26/27', { exact: true })).toHaveCount(0);
});

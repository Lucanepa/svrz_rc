import { test, expect } from '@playwright/test';
import { stubSignedInApp } from './support/app';

// The groups in the database are the xlsx import's spellings — "Beförderung",
// "Referee Coaching", "2. Schiedsrichter", "Neu-Schiedsrichter 26/27". None of
// them were in the English map, so an English reader got German badges for most
// of the roster while a few neighbouring groups translated fine.
//
// Which English word each one takes is not a judgement call about German nouns:
// Infoschreiben 4.4.4–4.4.6 define the XLSX codes GROUP_MAP reads. B? is the SR
// still to be visited for a promotion, B is the one it already happened to, and
// RC is "RC gewünscht" — not the name of the programme. See lib/coacheeGroup.ts.

const status = { needsObservation: true, count: 0 };
const coachee = (id: string, full_name: string, groups: string) =>
  ({ id, full_name, groups, referee_level: 'N3', stage: '2', observation_status: status });

const COACHEES = [
  coachee('a', 'Aaa One', 'Beförderung'),
  coachee('b', 'Bbb Two', 'Neu-Schiedsrichter 26/27'),
  coachee('c', 'Ccc Three', '2. Schiedsrichter'),
  coachee('d', 'Ddd Four', 'Beförderung?/Varia'),
  // What the import writes for the XLSX's `RC` — Infoschreiben 4.4.6, the SR who
  // asked for a visit. It read as the name of the programme for as long as it
  // went untranslated.
  coachee('e', 'Eee Five', 'Referee Coaching'),
  // The legacy participle, which a few old rows still carry and which means the
  // same thing as the noun above it.
  coachee('f', 'Fff Six', 'Befördert'),
  coachee('g', 'Ggg Seven', 'Rückstufung'),
  // Nobody maintains this one — whatever was typed shows as typed.
  coachee('h', 'Hhh Eight', 'Sonderfall'),
];

test('the groups actually stored are shown in English, not left in German', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await expect(page.getByText('One, Aaa')).toBeVisible();

  // Both spellings of the SVRZ's `B` say the promotion happened — the noun the
  // import writes, and the participle on the older rows.
  await expect(page.getByText('Promoted', { exact: true })).toHaveCount(2);
  await expect(page.getByText('New SR 26/27', { exact: true })).toBeVisible();
  await expect(page.getByText('2nd referee', { exact: true })).toBeVisible();
  // `B?` is the one still to be decided, so it keeps the question mark.
  await expect(page.getByText('Promotion? / Misc', { exact: true })).toBeVisible();
  await expect(page.getByText('Demoted', { exact: true })).toBeVisible();
  // `RC` means the SR asked for a visit, not "the Referee Coaching programme".
  await expect(page.getByText('RC requested', { exact: true })).toBeVisible();
  // Unknown groups still pass through untouched rather than being dropped.
  await expect(page.getByText('Sonderfall', { exact: true })).toBeVisible();

  // None of the German source spellings should survive into the English badge.
  await expect(page.getByText('Beförderung', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Neu-Schiedsrichter 26/27', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Referee Coaching', { exact: true })).toHaveCount(0);
});

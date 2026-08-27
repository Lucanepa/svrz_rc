import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, GAME, COACHEE, RC } from './support/app';

// VolleyManager spells the referee with the accents his passport has; the xlsx
// import that made the coachee row does not always. Every list in the app folds
// accents before comparing — except the form's own lookup, which used a plain
// lowercase compare. So the games list badged him a coachee while the form found
// nobody: Niveau and Gruppe came out empty, on screen and in the PDF he receives.

test('a referee spelled with accents still finds his unaccented coachee row', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...GAME, assignedRc: RC.name, firstReferee: 'Kevin León Peña de los Santos', secondReferee: '' }],
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({
    json: [{
      ...COACHEE,
      full_name: 'Kevin Leon Peña de los Santos',
      first_name: 'Kevin Leon',
      last_name: 'Peña de los Santos',
      referee_level: 'N4',
      stage: '2',
      groups: 'Varia',
    }],
  }));

  await page.goto('/');
  await openFeedbackForm(page);

  await expect(page.getByLabel(/Referee level/i)).toHaveValue('N4 - 2');
  await expect(page.getByLabel(/^Group$/i)).toHaveValue('Varia');
});

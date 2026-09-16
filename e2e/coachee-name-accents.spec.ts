import { test, expect } from '@playwright/test';
import { stubSignedInApp, openFeedbackForm, GAME, GAME_NOSV, COACHEE, RC } from './support/app';

// VolleyManager spells the referee with the accents his passport has; the xlsx
// import that made the coachee row does not always. Every list in the app folds
// accents before comparing — except the form's own lookup, which used a plain
// lowercase compare. So the games list badged him a coachee while the form found
// nobody: Niveau and Gruppe came out empty, on screen and in the PDF he receives.
//
// Since the ids went on the wire the form reads the coachee row off
// `firstCoacheeId`, which the server resolved for the game — and the fold is
// the fallback for a game an older API or a cached list sent without it. Both
// paths have to fill the form, so both are pinned.

test('a referee spelled with accents still finds his unaccented coachee row (the name path)', async ({ page }) => {
  await stubSignedInApp(page);
  // GAME_NOSV: no slot ids at all, the way an API older than them answers —
  // so the folded name is the only thing the form has to go on.
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{ ...GAME_NOSV, assignedRc: RC.name, firstReferee: 'Kevin León Peña de los Santos', secondReferee: '' }],
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

test('names that do not fold equal but share the SV number: the server resolved the row, and the form is filled', async ({ page }) => {
  await stubSignedInApp(page);
  // The convocation prints the licence name, the sheet the everyday one —
  // no fold makes "Kevin León Peña de los Santos" meet "Kevin Peña". The
  // number does: the server matched the slot to the row by it and sent the
  // row's id, and the client reads that and nothing else.
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{
      ...GAME, assignedRc: RC.name,
      firstReferee: 'Kevin León Peña de los Santos', firstRefereeId: '90003', firstCoacheeId: COACHEE.id,
      secondReferee: '',
    }],
  }));
  await page.route('**/api/coachees*', (r) => r.fulfill({
    json: [{
      ...COACHEE,
      full_name: 'Kevin Peña',
      first_name: 'Kevin',
      last_name: 'Peña',
      referee_id: '90003',
      referee_level: 'N4',
      stage: '2',
      groups: 'Varia',
    }],
  }));

  await page.goto('/');
  await openFeedbackForm(page);

  await expect(page.getByLabel(/Referee level/i)).toHaveValue('N4 - 2');
  await expect(page.getByLabel(/^Group$/i)).toHaveValue('Varia');
  // The report names the referee as the convocation does (the meta field
  // is labelled with the role); the row supplied the rest.
  await expect(page.getByLabel('1. SR', { exact: true })).toHaveValue('Kevin León Peña de los Santos');
});

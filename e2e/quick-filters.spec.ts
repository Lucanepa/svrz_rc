import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, COACHEE, COACHEE_LISTED, GAME } from './support/app';

// The two pills above a list — "Flagged" and "In focus only" — are filters with
// one question each, kept out of the collapsible panel because they are asked on
// nearly every visit. A pill nothing in the list answers to can only ever empty
// the screen, so it is not drawn at all: the rule the panel's own toggles have
// followed for months, applied to the two that had escaped it.
//
// And the Coachees tab asks the same two questions of the same fixtures, so it
// has them too — above the list, not inside every unfolded row.
//
// Like the rest of the suite these dates are read against the real clock: the
// fixtures below are the 2026/27 season the stub opens on.

const FREE = { ...GAME, id: 'g-free', assignedRc: '', starred: false };
const STARRED = {
  ...FREE, id: 'g-star', matchNo: '2400111',
  homeTeam: 'VBC Volketswil', awayTeam: 'DTV Bülach', starred: true,
};
/** Flagged, but played before today — nothing left to plan around. */
const PLAYED = { ...STARRED, id: 'g-past', date: '2026-09-01T19:30:00Z' };

const COACHEE_TWO = {
  id: 'c2', full_name: 'Zoe Two', email: 'zoe.two@example.ch',
  referee_level: 'N3', stage: '2',
  observation_status: { needsObservation: true, count: 0 },
};
const TWOS_GAME = {
  ...FREE, id: 'g-two', matchNo: '2400222',
  homeTeam: 'Volley Oerlikon', awayTeam: 'KSC Wiedikon',
  firstReferee: COACHEE_TWO.full_name,
};

/** Signed off: the latest visit said no further one is needed, so the default
 *  "needs observation" switch drops them — unless somebody flagged a game. */
const COACHEE_DONE = {
  id: 'c3', full_name: 'Nia Done', email: 'nia.done@example.ch',
  referee_level: 'N3', stage: '2',
  observation_status: { needsObservation: false, count: 1, hasCompletedObservation: true },
};
const DONES_STARRED = {
  ...FREE, id: 'g-done-star', matchNo: '2400333',
  homeTeam: 'TV Dietikon', awayTeam: 'VBC Kanti Baden',
  firstReferee: COACHEE_DONE.full_name, starred: true,
};
const DONES_PLAIN = {
  ...FREE, id: 'g-done-plain', matchNo: '2400334',
  homeTeam: 'VBC Glattal', awayTeam: 'SV Volley Wetzikon',
  firstReferee: COACHEE_DONE.full_name,
};

const flagPill = (page: Page) => page.getByRole('button', { name: /^(Flagged|Vorgemerkt)$/ });
const focusPill = (page: Page) => page.getByRole('button', { name: /In focus only|Nur im Fokus|All games|Alle Spiele/ });

/** Both coachees watched at every level, so only the test that is about the
 *  Niveau rule has to think about it. */
const targets = (page: Page, coachee_targets: Record<string, unknown>) =>
  page.route('**/api/settings', (r) => r.fulfill({
    json: { default_season: 2026, test_mode: false, groups: [], coachee_targets, rc_mandates: {}, default_goal: 10 },
  }));

test.describe('games', () => {
  test('a flag no game carries is not a button', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
    await page.goto('/games');
    await expect(page.getByText(FREE.homeTeam).first()).toBeVisible();
    await expect(flagPill(page)).toHaveCount(0);
  });

  test('a flagged game brings the pill, and the pill filters to it', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, STARRED] }));
    await page.goto('/games');
    await flagPill(page).click();
    await expect(page.getByText(STARRED.homeTeam)).toBeVisible();
    await expect(page.getByText(FREE.homeTeam)).toHaveCount(0);
  });

  test('a flag on a game already played is not offered', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, PLAYED] }));
    await page.goto('/games');
    await expect(page.getByText(PLAYED.homeTeam)).toBeVisible();
    await expect(flagPill(page)).toHaveCount(0);
  });

  test('the focus pill goes away when the Niveau prunes nothing', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
    await page.goto('/games');
    await expect(page.getByText(FREE.homeTeam).first()).toBeVisible();
    await expect(focusPill(page)).toHaveCount(0);
  });

  test('a target that prunes brings the focus pill, and it opens the list up', async ({ page }) => {
    await stubSignedInApp(page);
    // Watched as a 2. SR only, and the fixture has them on the 1. SR line.
    await targets(page, { [COACHEE.id]: { mode: 'custom', roles: ['2SR'] } });
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
    await page.goto('/games');
    await expect(focusPill(page)).toBeVisible();
    await expect(page.getByText(FREE.homeTeam)).toHaveCount(0);

    await focusPill(page).click();
    await expect(page.getByText(FREE.homeTeam).first()).toBeVisible();
    // Switched on, it stays reachable even though nothing is out of focus now.
    await expect(focusPill(page)).toBeVisible();
  });

  // The default "needs observation" switch is a guess about the referee; a star
  // is somebody asking for that game. Under the two together every flagged
  // game of a referee already signed off, or already booked, went missing and
  // the flag pill emptied the list (2026-09-15).
  test('a flagged game stays on the default list when its referee is signed off', async ({ page }) => {
    await stubSignedInApp(page);
    await targets(page, { [COACHEE.id]: { mode: 'all' }, [COACHEE_DONE.id]: { mode: 'all' } });
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_DONE] }));
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, DONES_STARRED, DONES_PLAIN] }));
    await page.goto('/games');
    await expect(page.getByText(FREE.homeTeam).first()).toBeVisible();
    await expect(page.getByText(DONES_STARRED.homeTeam)).toBeVisible();
    // Their unflagged game is still nothing to plan around.
    await expect(page.getByText(DONES_PLAIN.homeTeam)).toHaveCount(0);

    await flagPill(page).click();
    await expect(page.getByText(DONES_STARRED.homeTeam)).toBeVisible();
    await expect(page.getByText(FREE.homeTeam)).toHaveCount(0);
  });

  test('a flagged game stays on the default list when a coach already took another of theirs', async ({ page }) => {
    await stubSignedInApp(page);
    // GAME is held by the signed-in coach with its feedback still open, which
    // books the referee and hides the rest of their games — the star excepted.
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME, FREE, STARRED] }));
    await page.goto('/games');
    await expect(page.getByText(STARRED.homeTeam)).toBeVisible();
    await expect(page.getByText(FREE.homeTeam)).toHaveCount(0);
  });
});

test.describe('coachees', () => {
  const openCoachees = async (page: Page) => {
    await page.goto('/');
    await page.getByRole('button', { name: /^Coachees$/ }).click();
    await expect(page.getByText(COACHEE_LISTED).first()).toBeVisible();
  };

  test('no flagged game, no pill', async ({ page }) => {
    await stubSignedInApp(page);
    await targets(page, { [COACHEE.id]: { mode: 'all' }, [COACHEE_TWO.id]: { mode: 'all' } });
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_TWO] }));
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, TWOS_GAME] }));
    await openCoachees(page);
    await expect(flagPill(page)).toHaveCount(0);
    await expect(focusPill(page)).toHaveCount(0);
  });

  test('the flag filter thins the list to whoever has one, and the row shows it', async ({ page }) => {
    await stubSignedInApp(page);
    await targets(page, { [COACHEE.id]: { mode: 'all' }, [COACHEE_TWO.id]: { mode: 'all' } });
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_TWO] }));
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, STARRED, TWOS_GAME] }));
    await openCoachees(page);
    await expect(page.getByText('Two, Zoe')).toBeVisible();

    await flagPill(page).click();
    await expect(page.getByText('Two, Zoe')).toHaveCount(0);
    await expect(page.getByText(COACHEE_LISTED).first()).toBeVisible();

    // Their row lists the game that put them there, and not the other one.
    await page.getByRole('button', { name: /Show details|Details anzeigen/ }).first().click();
    await expect(page.getByText(STARRED.homeTeam, { exact: true })).toBeVisible();
    await expect(page.getByText(FREE.homeTeam, { exact: true })).toHaveCount(0);
  });

  test('the focus pill reaches the Coachees tab when a Niveau prunes', async ({ page }) => {
    await stubSignedInApp(page);
    await targets(page, { [COACHEE.id]: { mode: 'custom', roles: ['2SR'] } });
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE] }));
    await openCoachees(page);
    await expect(focusPill(page)).toBeVisible();

    await page.getByRole('button', { name: /Show details|Details anzeigen/ }).first().click();
    await expect(page.getByText(FREE.homeTeam, { exact: true })).toHaveCount(0);
    await focusPill(page).click();
    await expect(page.getByText(FREE.homeTeam, { exact: true })).toBeVisible();
  });

  test('a flagged game keeps a signed-off coachee on the default list', async ({ page }) => {
    await stubSignedInApp(page);
    await targets(page, { [COACHEE.id]: { mode: 'all' }, [COACHEE_DONE.id]: { mode: 'all' } });
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_DONE] }));
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, DONES_STARRED] }));
    await openCoachees(page);
    await expect(page.getByText('Done, Nia')).toBeVisible();

    await flagPill(page).click();
    await expect(page.getByText('Done, Nia')).toBeVisible();
    await expect(page.getByText(COACHEE_LISTED)).toHaveCount(0);
  });

  test('signed off with nothing flagged, the coachee stays off the default list', async ({ page }) => {
    await stubSignedInApp(page);
    await targets(page, { [COACHEE.id]: { mode: 'all' }, [COACHEE_DONE.id]: { mode: 'all' } });
    await page.route('**/api/coachees*', (r) => r.fulfill({ json: [COACHEE, COACHEE_DONE] }));
    await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [FREE, DONES_PLAIN] }));
    await openCoachees(page);
    await expect(page.getByText('Done, Nia')).toHaveCount(0);
  });
});

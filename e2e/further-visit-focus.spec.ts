import { test, expect, type Page } from '@playwright/test';
import { stubSignedInApp, COACHEE, GAME } from './support/app';

// "Weiterer Besuch: Y, als 1SR" was written into the report and read by
// nothing: the coach who went to take the coachee's next 1. SR game was asked
// whether they really meant to watch somebody already observed this season,
// and the coachee's 2. SR games stayed in focus beside the 1. SR ones
// (2026-11-03). The role the report asked for now narrows the focus to that
// role — a flagged game aside, which is somebody asking for that very game —
// and a take in that role asks nothing. In the other role it still asks, and
// says which role the report wanted.

const observed = (furtherVisitRole: '1SR' | '2SR' | '') => ({
  ...COACHEE,
  observation_status: {
    count: 1, hasNoObservation: false, hasCompletedObservation: true,
    hasFurtherObservationNeeded: true, needsObservation: true, latestObservationAt: '2026-10-03T17:00:00Z',
    furtherVisitRole,
  },
});
/** Observed, and the report wanted no further visit. */
const SIGNED_OFF = {
  ...COACHEE,
  observation_status: {
    count: 1, hasNoObservation: false, hasCompletedObservation: true,
    hasFurtherObservationNeeded: false, needsObservation: false, latestObservationAt: '2026-10-03T17:00:00Z',
    furtherVisitRole: '',
  },
};

const free = { ...GAME, assignedRc: '', assignedRcId: '', starred: false, secondRefereeId: '' };
/** The coachee leads: the visit the report asked for. */
const AS_1SR = {
  ...free, id: 'g-1sr', matchNo: '2400101', league: '3L ♂', date: '2027-02-06T17:00:00Z',
  homeTeam: 'VBC Erstrolle', awayTeam: 'TV Gast',
  secondReferee: 'Ex Terne', secondCoacheeId: '',
};
/** The coachee as 2. SR beside a stranger: not the role asked for. */
const AS_2SR = {
  ...free, id: 'g-2sr', matchNo: '2400102', league: '2L ♂', date: '2027-02-13T17:00:00Z',
  homeTeam: 'VBC Zweitrolle', awayTeam: 'TV Gast',
  firstReferee: 'Ex Terne', firstRefereeId: '', firstCoacheeId: '',
  secondReferee: COACHEE.full_name, secondRefereeId: COACHEE.referee_id, secondCoacheeId: COACHEE.id,
};
/** The same, flagged: somebody wants this one seen. */
const FLAGGED_2SR = { ...AS_2SR, id: 'g-2sr-star', matchNo: '2400103', date: '2027-02-20T17:00:00Z', homeTeam: 'VBC Wunschspiel', starred: true };

const focusPill = (page: Page) => page.getByRole('button', { name: /In focus only|Nur im Fokus|All games|Alle Spiele/ });

async function openGames(page: Page, coachee: object): Promise<string[]> {
  const assigned: string[] = [];
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [coachee] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [AS_1SR, AS_2SR, FLAGGED_2SR] }));
  await page.route('**/api/games/*/assign-rc', async (r) => {
    assigned.push(r.request().url());
    await r.fulfill({ json: { ok: true } });
  });
  await page.goto('/games');
  await expect(page.getByText(FLAGGED_2SR.homeTeam)).toBeVisible();
  return assigned;
}

async function take(page: Page, homeTeam: string) {
  await page.getByRole('button', { name: new RegExp(homeTeam) }).first().click();
  await page.getByRole('button', { name: /Take game|Spiel übernehmen/ }).click();
}

test('a further visit asked as 1SR keeps the 1SR games in focus, and a flagged 2SR one', async ({ page }) => {
  await openGames(page, observed('1SR'));
  await expect(page.getByText(AS_1SR.homeTeam)).toBeVisible();
  await expect(page.getByText(AS_2SR.homeTeam)).toHaveCount(0);
  await expect(page.getByText(FLAGGED_2SR.homeTeam)).toBeVisible();
  // Only hidden: "All games" brings it back, marked as outside the focus.
  await focusPill(page).click();
  await expect(page.getByText(AS_2SR.homeTeam)).toBeVisible();
  await expect(page.getByText(/Coachee · .*(nicht im Fokus|out of focus)/)).toHaveCount(1);
});

test('taking a game in the role the report asked for asks nothing', async ({ page }) => {
  const assigned = await openGames(page, observed('1SR'));
  await take(page, AS_1SR.homeTeam);
  await expect.poll(() => assigned.length).toBe(1);
  expect(assigned[0]).toContain(`/api/games/${AS_1SR.id}/assign-rc`);
  await expect(page.getByTestId('take-notice')).toHaveCount(0);
});

test('in the other role the notice says which role the report wanted', async ({ page }) => {
  const assigned = await openGames(page, observed('1SR'));
  await take(page, FLAGGED_2SR.homeTeam);
  const notice = page.getByTestId('take-notice');
  await expect(notice).toContainText(/already been observed this season|diese Saison bereits beobachtet/);
  await expect(notice).toContainText(/further visit as 1SR; here as 2SR|weiteren Besuch als 1SR, hier als 2SR/);
  expect(assigned).toHaveLength(0);
});

test('a plain Y narrows nothing and asks nothing, in either role', async ({ page }) => {
  const assigned = await openGames(page, observed(''));
  await expect(page.getByText(AS_2SR.homeTeam)).toBeVisible();
  await take(page, AS_2SR.homeTeam);
  await expect.poll(() => assigned.length).toBe(1);
  await expect(page.getByTestId('take-notice')).toHaveCount(0);
});

test('a report that wanted no further visit still asks before a take', async ({ page }) => {
  await openGames(page, SIGNED_OFF);
  // Signed off, the coachee's games leave "Beobachtung nötig" — the flagged
  // one stays, and is where the second look would be taken.
  await take(page, FLAGGED_2SR.homeTeam);
  const notice = page.getByTestId('take-notice');
  await expect(notice).toContainText(/already been observed this season|diese Saison bereits beobachtet/);
  await expect(notice).not.toContainText(/further visit as|weiteren Besuch als/);
});

test('the coachee\'s own list keeps the played 2SR game the report was filed on', async ({ page }) => {
  const PLAYED_2SR = { ...AS_2SR, id: 'g-played', matchNo: '2400100', date: '2026-10-03T15:00:00Z', homeTeam: 'VBC Gespielt' };
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: [observed('1SR')] }));
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [AS_1SR, AS_2SR] }));
  await page.route('**/api/coachees/*/games', (r) => r.fulfill({
    json: [
      { ...AS_1SR, assignedRoles: ['1. SR'] },
      { ...AS_2SR, assignedRoles: ['2. SR'] },
      { ...PLAYED_2SR, assignedRoles: ['2. SR'] },
    ],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^Coachees$/ }).click();
  await page.getByRole('button', { name: /Show details|Details anzeigen/ }).first().click();
  await page.getByRole('button', { name: /^(Games|Spiele)$/ }).last().click();

  await expect(page.getByText(/Upcoming Games \(1\)|Bevorstehende Spiele \(1\)/)).toBeVisible();
  await expect(page.getByText(/1 game\(s\) outside the focus hidden\. Further visit wanted as 1SR\.|1 Spiel\(e\) ausserhalb des Fokus ausgeblendet\. Weiterer Besuch als 1SR gewünscht\./)).toBeVisible();
  await expect(page.getByText(/Past Games \(1\)|Vergangene Spiele \(1\)/)).toBeVisible();
});

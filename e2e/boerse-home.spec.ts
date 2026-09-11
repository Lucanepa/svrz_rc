import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

/**
 * What the SR-Börse marks look like on Home.
 *
 * The rules themselves are covered exhaustively in boerse-rules.spec.ts; this is
 * about the half that truth table cannot see — whether the verdict survives the
 * trip into the DOM, and whether the WORD arrives with the colour.
 *
 * That second one is the point. `crewChips` only opened its MarkRow when the
 * crew was "mixed" — a coachee beside a non-coachee — so in the case this
 * feature exists for (two coachees, one of them in the börse) neither chip had a
 * row for the warning to sit in. The chip would have gone red and said nothing,
 * and a red chip with no text is exactly the failure the marks exist to avoid.
 */

const asOf = new Date(Date.now() - 12 * 60_000).toISOString();

const game = (over: Record<string, unknown> = {}) => ({
  gameId: 'g1',
  gameDate: '2026-12-20T19:30:00Z',
  league: '3L ♂ A',
  teams: 'Heim vs Gast',
  refereeName: 'Coachee Eins',
  refereeRole: '1. SR',
  crew: [
    { name: 'Coachee Eins', role: '1. SR', coachee: true },
    { name: 'Coachee Zwei', role: '2. SR', coachee: true },
  ],
  result: '',
  ...over,
});

async function homeWith(page: import('@playwright/test').Page, g: Record<string, unknown>) {
  await stubSignedInApp(page);
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 1 }],
  }));
  // Regex, not a glob: "?" is a single-character wildcard in Playwright's glob
  // syntax, so '**/api/rc-overview?*' never matches the query string.
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Coachee Eins',
      doneFeedbacks: [], outstandingGames: [], plannedGames: [g],
    }],
  }));
  await page.goto('/');
}

test('a coachee in the börse says so in words, not only in colour', async ({ page }) => {
  await homeWith(page, game({
    boerse: { level: 'red', reason: 'only-coachee-offered', markedSlots: ['1'], asOf },
  }));
  // the flag under the row
  await expect(page.getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();
  // and the mark beside the name — the WORD, not just the glyph
  await expect(page.getByText('In Börse').first()).toBeVisible();
});

// The regression this file exists for.
test('both referees are coachees and one is offered — the word still appears', async ({ page }) => {
  await homeWith(page, game({
    boerse: { level: 'amber', reason: 'one-of-mine-remains', markedSlots: ['2'], asOf },
  }));
  await expect(page.getByText(/1 von 2 Coachees in der Börse|1 of 2 coachees in the Börse/)).toBeVisible();
  await expect(page.getByText('In Börse').first()).toBeVisible();
});

test('the mark lands on the offered referee and not the other one', async ({ page }) => {
  await homeWith(page, game({
    boerse: { level: 'amber', reason: 'one-of-mine-remains', markedSlots: ['2'], asOf },
  }));
  // Exactly one chip carries it, and it is the one holding the 2. SR name.
  await expect(page.getByText('In Börse')).toHaveCount(1);
  const marked = page.locator('span', { hasText: 'In Börse' }).last();
  await expect(marked).toBeVisible();
  await expect(page.getByText('Coachee Zwei').first()).toBeVisible();
});

test('a non-coachee in the börse is marked, but the row is not', async ({ page }) => {
  await homeWith(page, game({
    crew: [
      { name: 'Coachee Eins', role: '1. SR', coachee: true },
      { name: 'Fremder Sven', role: '2. SR', coachee: false },
    ],
    boerse: { level: 'none', reason: 'not-my-concern', markedSlots: ['2'], asOf },
  }));
  await expect(page.getByText('In Börse').first()).toBeVisible();
  // ...and no flag line, because nothing about the observation changed
  await expect(page.getByText(/in der Börse$|in the Börse$/)).toHaveCount(0);
});

test('an untouched game carries no börse marking at all', async ({ page }) => {
  await homeWith(page, game({
    boerse: { level: 'none', reason: 'no-open-offers', markedSlots: [], asOf },
  }));
  await expect(page.getByText('In Börse')).toHaveCount(0);
  await expect(page.getByText(/Coachee-Einsatz in der Börse/)).toHaveCount(0);
});

// An API older than the feature sends no `boerse` at all. The frontend ships on
// push to main while the API is copied to the host by hand, so that window is
// real — and its silent version looks exactly like "nothing is wrong".
test('a payload with no börse field renders nothing rather than a false all-clear', async ({ page }) => {
  await homeWith(page, game());
  await expect(page.getByText('In Börse')).toHaveCount(0);
  await expect(page.getByText(/in der Börse/)).toHaveCount(0);
});

/**
 * The Games tab — the list an UNASSIGNED game lives in, which is where most
 * börse offers actually sit, because nobody has taken those games yet.
 *
 * It renders through `gameCard`/`refChip`, a different pair from the Home rows
 * above, and was the last surface still unwired: every one of the eleven red
 * games live on production was unassigned, so the feature was invisible in the
 * one list its data was in.
 */
test.describe('the Games tab', () => {
  const listGame = (over: Record<string, unknown> = {}) => ({
    id: 'eg1', matchNo: '408178', league: 'DU23 3. Liga',
    date: '2026-09-22T18:15:00Z', location: 'Zwingert, Buchs ZH',
    homeTeam: 'VBC Furttal', awayTeam: 'KSC Wiedikon DU23-1',
    firstReferee: 'Coachee Eins', secondReferee: '',
    assignedRc: '', feedbackClosedRoles: [], starred: false, vmFlagged: false,
    ...over,
  });

  test('an offered slot on an unassigned game is marked in the list', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [listGame({ boerse: { level: 'red', reason: 'only-coachee-offered', markedSlots: ['1'], asOf } })],
    }));
    await page.goto('/');
    await page.getByRole('button', { name: /^(Spiele|Games)$/ }).first().click();
    await expect(page.getByText('In Börse').first()).toBeVisible();
    await expect(page.getByText(/Coachee-Einsatz in der Börse|Coachee's slot is in the Börse/)).toBeVisible();
  });

  test('a game nobody has offered carries nothing', async ({ page }) => {
    await stubSignedInApp(page);
    await page.route('**/api/eligible-games*', (r) => r.fulfill({
      json: [listGame({ boerse: { level: 'none', reason: 'no-open-offers', markedSlots: [], asOf } })],
    }));
    await page.goto('/');
    await page.getByRole('button', { name: /^(Spiele|Games)$/ }).first().click();
    await expect(page.getByText('In Börse')).toHaveCount(0);
  });
});

/**
 * A game another coach already holds.
 *
 * The three lists that offer "Take game" each said something different when
 * somebody else had it: one printed the holder's name as a label, one a green
 * pill, and one rendered NOTHING — so the row just looked like it had no action.
 * All three now show the same greyed button that explains itself on click.
 *
 * `aria-disabled`, not `disabled`: a truly disabled button fires no click and
 * can therefore never say why it is disabled.
 */
test('a game someone else holds shows a greyed button that names the holder', async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/eligible-games*', (r) => r.fulfill({
    json: [{
      id: 'eg9', matchNo: '408178', league: 'DU23 3. Liga',
      date: '2026-12-22T18:15:00Z', location: 'Zwingert, Buchs ZH',
      homeTeam: 'VBC Furttal', awayTeam: 'KSC Wiedikon DU23-1',
      firstReferee: 'Coachee Eins', secondReferee: '',
      assignedRc: 'Jennifer Schöni', feedbackClosedRoles: [], starred: false, vmFlagged: false,
    }],
  }));
  await page.goto('/');
  await page.getByRole('button', { name: /^(Spiele|Games)$/ }).first().click();
  // Taken games are hidden by default, so the RC-assigned toggle has to be on —
  // and it lives inside the filter panel, which opens first.
  await page.getByRole('button', { name: /Filter/i }).first().click();
  await page.getByRole('button', { name: /RC zugewiesen|RC assigned/ }).first().click();

  // The row's actions live behind its expander, like every other row action here.
  await page.getByText('VBC Furttal').first().click();

  const take = page.getByRole('button', { name: /Spiel übernehmen|Take game/ }).first();
  await expect(take).toBeVisible();
  await expect(take).toHaveAttribute('aria-disabled', 'true');
  // `force`, because Playwright honours aria-disabled in its actionability
  // check — which is the right call, and exactly why a real user CAN still
  // click this: the attribute is advisory, the handler is real.
  await take.click({ force: true });
  await expect(page.getByText(/Jennifer Schöni (hat dieses Spiel bereits übernommen|already took this game)/)).toBeVisible();
});

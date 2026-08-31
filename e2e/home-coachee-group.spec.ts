import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// Home is the list an RC plans the week from, and it named the referee without
// saying which cohort they belong to — "Varia", "Beförderung?",
// "Neu-Schiedsrichter 26/27" is the reason one game is worth the drive and the
// next one is not. The games list has carried the group in its amber badge for
// as long as it has had one; this list had only the bare "Coachee" mark.

const status = { needsObservation: true, count: 0 };
const coachee = (id: string, full_name: string, groups: string) =>
  ({ id, full_name, groups, referee_level: 'N3', stage: '2', observation_status: status });

const COACHEES = [
  coachee('c1', 'Nina Adler', 'Varia'),
  coachee('c2', 'Tim Berger', 'Neu-Schiedsrichter 26/27'),
  coachee('c3', 'Urs Custer', 'Beförderung?'),
];

const game = (n: number, crew: Array<{ name: string; role: string; coachee: boolean }>) => ({
  gameId: `g${n}`,
  gameDate: `2026-10-${String(n).padStart(2, '0')}T19:30:00Z`,
  league: '3L ♂ A',
  teams: `Heim ${n} vs Gast ${n}`,
  refereeName: crew[0].name,
  refereeRole: crew[0].role,
  crew,
  result: '',
});

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  // Regexes, not globs — see e2e/home-planned-games.spec.ts.
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 2 }],
  }));
  await page.route(/\/api\/rc-overview\/[^/]+\/coachees/, (r) => r.fulfill({
    json: [{
      coacheeId: 'c1', coacheeName: 'Nina Adler',
      doneFeedbacks: [], outstandingGames: [],
      plannedGames: [
        game(1, [
          { name: 'Nina Adler', role: '1. SR', coachee: true },
          { name: 'Sven Fremd', role: '2. SR', coachee: false },
        ]),
        game(2, [
          { name: 'Tim Berger', role: '1. SR', coachee: true },
          { name: 'Urs Custer', role: '2. SR', coachee: true },
        ]),
      ],
    }],
  }));
});

test('a planned game says which group its coachees are in', async ({ page }) => {
  await page.goto('/#/home');
  await expect(page.getByText('Planned', { exact: true })).toBeVisible();

  // A mixed pair keeps the "Coachee" mark that tells the two referees apart,
  // and the group stands beside it as a chip of its own.
  await expect(page.getByText('Coachee', { exact: true })).toBeVisible();
  await expect(page.getByText('Misc', { exact: true })).toBeVisible();
  // The referee who is nobody's coachee is still listed, and still unmarked.
  await expect(page.getByText('Sven Fremd', { exact: false })).toBeVisible();

  // Both referees coachees: nothing is marked "Coachee" — highlighting
  // everything highlights nothing — but each name carries its own group, which
  // is the whole point of the line.
  await expect(page.getByText('New SR 26/27', { exact: true })).toBeVisible();
  await expect(page.getByText('Promotion?', { exact: true })).toBeVisible();
});

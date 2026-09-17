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

const game = (n: number, crew: Array<{ name: string; role: string; coachee: boolean }>, flags: Record<string, boolean> = {}) => ({
  gameId: `g${n}`,
  gameDate: `2026-10-${String(n).padStart(2, '0')}T19:30:00Z`,
  league: '3L ♂ A',
  teams: `Heim ${n} vs Gast ${n}`,
  refereeName: crew[0].name,
  refereeRole: crew[0].role,
  crew,
  result: '',
  ...flags,
});

test.beforeEach(async ({ page }) => {
  await stubSignedInApp(page);
  await page.route('**/api/coachees*', (r) => r.fulfill({ json: COACHEES }));
  // Regexes, not globs — see e2e/home-planned-games.spec.ts.
  await page.route(/\/api\/rc-overview\?/, (r) => r.fulfill({
    json: [{ id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 3 }],
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
        // A coach whistling next to a coachee: the Games tab has always
        // flagged it, the coach's own list used to draw it as any fixture.
        game(3, [
          { name: 'Nina Adler', role: '1. SR', coachee: true },
          { name: 'Max Muster', role: '2. SR', coachee: false },
        ], { isRcGame: true }),
      ],
    }],
  }));
});

test('a planned game says which group its coachees are in', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByText(/\d+ planned|\d+ geplant/)).toBeVisible();

  // Every coachee carries the "Coachee" mark — the mixed pair's Nina, and
  // BOTH referees of the second game (it used to be only the mixed pair; a
  // grey chip read as "not a coachee") — with the Niveau after it, as the
  // Games tab's mark has always had, and the group beside it as a chip of
  // its own.
  await expect(page.getByText(/^Coachee · N3-2$/)).toHaveCount(4);
  await expect(page.getByText('Misc', { exact: true }).first()).toBeVisible();
  // The referee who is nobody's coachee is still listed, and still unmarked.
  await expect(page.getByText('Sven Fremd', { exact: false })).toBeVisible();

  // Each name carries its own group, which is the whole point of the line.
  await expect(page.getByText('New SR 26/27', { exact: true })).toBeVisible();
  await expect(page.getByText('Promotion?', { exact: true })).toBeVisible();
});

test('a taken RC-Spiel wears the same chip on Home as on the Games tab', async ({ page }) => {
  await page.goto('/home');
  await expect(page.getByText(/\d+ planned|\d+ geplant/)).toBeVisible();
  // One RC game among the three planned rows — the flagged one, not the others.
  await expect(page.getByText(/^(RC Game|RC-Spiel)$/)).toHaveCount(1);
  // The row is one button whose accessible name reads the whole line; the
  // teams sit in two paragraphs, so "Heim 3 … RC Game" is the row with the chip.
  await expect(page.getByRole('button', { name: /Heim 3 Gast 3 (RC Game|RC-Spiel)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Heim 1 Gast 1 (RC Game|RC-Spiel)/ })).toHaveCount(0);
});

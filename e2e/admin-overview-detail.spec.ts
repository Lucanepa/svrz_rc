import { test, expect } from '@playwright/test';
import { stubSignedInApp, RC } from './support/app';

// Admin → Übersicht showed each coach as four numbers, and the chair read a
// "1" under Ausstehend and asked what it meant and where to find the game.
// Each row now opens on a chevron into the three lists behind its counters —
// the same detail the coach sees on their own Home — with a line under
// Ausstehend saying that these are the games still to be done.

const OVERVIEW = [
  { id: RC.id, fullName: RC.name, done: 0, outstanding: 0, planned: 0 },
  { id: 'rc2', fullName: 'Thanh Ut Nguyen', done: 0, outstanding: 1, planned: 2 },
];

const game = (gameId: string, gameDate: string, teams: string, refereeName: string, matchNo: string) =>
  ({ gameId, gameDate, league: '3L ♂', matchNo, teams, location: 'Sporthalle Utogrund', refereeName, refereeRole: '1. SR' });

/** Two coachees, one shared planned game between them — so the detail must
 *  fold what the summary hands over twice back into one row. */
const SUMMARY = [
  {
    coacheeName: 'Nina Adler', coacheeId: 'c1', doneFeedbacks: [],
    outstandingGames: [game('g-out', '2026-09-05T18:00:00Z', 'VBC Altdorf vs TV Gast', 'Nina Adler', '2500011')],
    plannedGames: [game('g-plan', '2026-10-24T18:00:00Z', 'VBC Neuheim vs TV Gast', 'Nina Adler', '2500012')],
  },
  {
    coacheeName: 'Tim Berger', coacheeId: 'c2', doneFeedbacks: [],
    outstandingGames: [],
    plannedGames: [
      { ...game('g-plan', '2026-10-24T18:00:00Z', 'VBC Neuheim vs TV Gast', 'Tim Berger', '2500012'), refereeRole: '2. SR' },
      game('g-plan-2', '2026-11-07T18:00:00Z', 'VBC Zweitheim vs TV Gast', 'Tim Berger', '2500013'),
    ],
  },
];

test('a coach\'s row opens into the games behind the counters', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  await page.route('**/api/rc-overview', (r) => r.fulfill({ json: OVERVIEW }));
  const asked: string[] = [];
  await page.route('**/api/rc-overview/*/coachees*', (r) => {
    asked.push(decodeURIComponent(new URL(r.request().url()).pathname));
    r.fulfill({ json: SUMMARY });
  });

  await page.goto('/admin/overview');
  const row = page.getByRole('row', { name: /Thanh Ut Nguyen/ });
  await expect(row).toBeVisible();
  // Closed by default: the table is the table. (GameRow prints the two teams
  // on their own lines, so the home team is what to look for.)
  await expect(page.getByText('VBC Altdorf')).toHaveCount(0);

  // The name is the button — a chevron column of its own pushed the table
  // sideways on a phone.
  const toggle = row.getByRole('button', { name: 'Thanh Ut Nguyen' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(asked.some((p) => p.includes('/Thanh Ut Nguyen/'))).toBe(true);

  // The outstanding game, under a heading that says what "outstanding" means.
  await expect(page.getByText('VBC Altdorf')).toBeVisible();
  await expect(page.getByText(/noch zu erledigen|still to be done/)).toBeVisible();
  // The shared planned game once, naming both coachees; the other one too.
  // (Nina is on the outstanding game as well, hence two of her chips.)
  await expect(page.getByText('VBC Neuheim')).toHaveCount(1);
  await expect(page.getByText('Nina Adler · 1. SR')).toHaveCount(2);
  await expect(page.getByText('Tim Berger · 2. SR')).toHaveCount(1);
  await expect(page.getByText('VBC Zweitheim')).toBeVisible();

  // And it closes again.
  await toggle.click();
  await expect(page.getByText('VBC Altdorf')).toHaveCount(0);
});

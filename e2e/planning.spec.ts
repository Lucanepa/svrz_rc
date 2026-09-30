import { test, expect } from '@playwright/test';
import { computePlanning, type PlanningGameInput, type PlanningCoacheeInput } from '../server/planning';
import { stubSignedInApp, GAME } from './support/app';

// Admin → Planung (asked 2026-09-30): the chair's board. Per coachee of the
// season: observed, booked or still open — and the games that break a rule,
// each opening in the Games tab rather than being handled a second time here.

const NOW = '2026-10-15T10:00:00.000Z';

const coachee = (over: Partial<PlanningCoacheeInput>): PlanningCoacheeInput => ({
  id: 'c', name: 'Coachee', groups: 'Varia', level: 'N3', stage: '2', observed: 0, furtherWanted: false, ...over,
});

const game = (over: Partial<PlanningGameInput>): PlanningGameInput => ({
  id: 'g', matchNo: '400000', date: '2026-11-01T19:00:00.000Z', label: 'Home – Away', rc: '',
  closedRoles: [], feedbackRoles: [], isRcGame: false, offeredRoles: [],
  slots: [{ role: '1. SR', name: 'Coachee', coacheeId: 'c' }, { role: '2. SR', name: '', coacheeId: '' }],
  ...over,
});

const plan = (coachees: PlanningCoacheeInput[], games: PlanningGameInput[]) =>
  computePlanning({ season: 2026, now: NOW, coachees, games });

test('status: booked beats everything, then never observed, then a further visit wanted, then done', () => {
  const r = plan(
    [
      coachee({ id: 'booked', name: 'A Booked', observed: 1 }),
      coachee({ id: 'never', name: 'B Never' }),
      coachee({ id: 'again', name: 'C Again', observed: 1, furtherWanted: true }),
      coachee({ id: 'done', name: 'D Done', observed: 1 }),
      coachee({ id: 'off', name: 'E Off', stage: 'inactive' }),
    ],
    [game({ id: 'g1', rc: 'Anna', slots: [{ role: '1. SR', name: 'A Booked', coacheeId: 'booked' }, { role: '2. SR', name: '', coacheeId: '' }] })],
  );
  // The ones still waiting read first.
  expect(r.coachees.map((c) => [c.id, c.status])).toEqual([
    ['never', 'needs-visit'], ['again', 'further-wanted'], ['booked', 'booked'], ['done', 'done'], ['off', 'inactive'],
  ]);
  expect(r.totals).toMatchObject({ coachees: 5, booked: 1, needsVisit: 1, furtherWanted: 1, done: 1 });
});

test('a sent report ends the booking; free games count only what can still be taken', () => {
  const r = plan([coachee({})], [
    game({ id: 'sent', rc: 'Anna', closedRoles: ['1. SR'], feedbackRoles: ['1. SR'], date: '2026-10-01T19:00:00.000Z' }),
    game({ id: 'free', matchNo: '400001' }),
    game({ id: 'past', matchNo: '400002', date: '2026-10-01T19:00:00.000Z' }),
    game({ id: 'rc', matchNo: '400003', isRcGame: true }),
  ]);
  expect(r.coachees[0].bookings).toEqual([]);
  expect(r.coachees[0].freeGames).toBe(1);
  expect(r.checks).toEqual([]);
});

test('the checks: RC game held, double booking, offered slot, overdue, held for nobody, report/closure mismatch', () => {
  const r = plan(
    [coachee({ id: 'c1', name: 'One' }), coachee({ id: 'c2', name: 'Two' })],
    [
      game({ id: 'rc', matchNo: '1', rc: 'Anna', isRcGame: true, slots: [{ role: '1. SR', name: 'One', coacheeId: 'c1' }, { role: '2. SR', name: 'A Coach', coacheeId: '' }] }),
      game({ id: 'b1', matchNo: '2', rc: 'Beat', date: '2026-11-10T19:00:00.000Z', slots: [{ role: '1. SR', name: 'Two', coacheeId: 'c2' }, { role: '2. SR', name: '', coacheeId: '' }] }),
      game({ id: 'b2', matchNo: '3', rc: 'Carla', date: '2026-12-10T19:00:00.000Z', offeredRoles: ['2. SR'], slots: [{ role: '1. SR', name: 'X', coacheeId: '' }, { role: '2. SR', name: 'Two', coacheeId: 'c2' }] }),
      game({ id: 'late', matchNo: '4', rc: 'Anna', date: '2026-10-01T19:00:00.000Z', slots: [{ role: '1. SR', name: 'One', coacheeId: 'c1' }, { role: '2. SR', name: '', coacheeId: '' }] }),
      game({ id: 'nobody', matchNo: '5', rc: 'Anna', slots: [{ role: '1. SR', name: 'Stranger', coacheeId: '' }, { role: '2. SR', name: '', coacheeId: '' }] }),
      game({ id: 'mis', matchNo: '6', rc: 'Anna', closedRoles: ['1. SR'], feedbackRoles: [], date: '2026-10-02T19:00:00.000Z', slots: [{ role: '1. SR', name: 'Old', coacheeId: '' }, { role: '2. SR', name: '', coacheeId: '' }] }),
    ],
  );
  const kinds = r.checks.map((c) => `${c.kind}:${c.games.map((g) => g.matchNo).join('+')}`);
  expect(kinds).toContain('rc-game-held:1');
  expect(kinds).toContain('double-booking:2+3');
  expect(kinds).toContain('offered-slot:3');
  expect(kinds).toContain('overdue:4');
  expect(kinds).toContain('no-coachee:5');
  expect(kinds).toContain('closed-mismatch:6');
  // One booking counted twice as a double — One has the RC game AND the late one.
  expect(kinds).toContain('double-booking:4+1');
  // Rule breaks nobody else lists, in the order they are fixed: 4.4.10 first.
  expect(r.checks[0].kind).toBe('rc-game-held');
  expect(r.checks.find((c) => c.kind === 'closed-mismatch')?.detail).toBe('closed-without-report');
});

test('the board shows one loading state, then the coachees, and a game opens in the Games tab', async ({ page }) => {
  await stubSignedInApp(page, { admin: true });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/admin/planning*', async (r) => {
    await gate;
    await r.fulfill({ json: plan(
      [coachee({ id: 'c1', name: 'Ref One' }), coachee({ id: 'c2', name: 'Ref Two', observed: 1 })],
      [
        game({ id: GAME.id, matchNo: GAME.matchNo, rc: 'Anna Muster', slots: [{ role: '1. SR', name: 'Ref One', coacheeId: 'c1' }, { role: '2. SR', name: '', coacheeId: '' }] }),
        game({ id: 'x', matchNo: '400999', rc: 'Beat', slots: [{ role: '1. SR', name: 'Ref One', coacheeId: 'c1' }, { role: '2. SR', name: '', coacheeId: '' }] }),
      ],
    ) });
  });
  await page.route('**/api/eligible-games*', (r) => r.fulfill({ json: [GAME] }));

  await page.goto('/admin/planning');
  await expect(page.getByTestId('planning')).toBeVisible();
  // Nothing of the board before its answer: no rows, no checks card.
  await expect(page.getByTestId('planning-row')).toHaveCount(0);
  await expect(page.getByTestId('planning-checks')).toHaveCount(0);

  release();
  await expect(page.getByTestId('planning-row')).toHaveCount(2);
  await expect(page.getByTestId('planning-check-double-booking')).toBeVisible();

  // A game line opens the Games tab, searched for that match number.
  await page.getByTestId('planning-row').filter({ hasText: 'Ref One' }).getByRole('button', { name: new RegExp(GAME.matchNo) }).click();
  await expect(page).toHaveURL(/\/admin\/games/);
  await expect(page.getByPlaceholder(/Spiel, Team, Liga|Search game, team/)).toHaveValue(GAME.matchNo);
  await expect(page.getByText(GAME.homeTeam).first()).toBeVisible();
});

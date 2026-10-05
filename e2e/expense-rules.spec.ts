import { test, expect } from '@playwright/test';
import { planExpenseRows, buildExpenseStatementPdf, expenseStatementFileName, rcWorkloadRule, resolvePaidCap, type ExpenseStatement } from '../server/expenses';
import { PAID_CAP } from '../src/types';

// The Spesenabrechnung's arithmetic on its own: how visits are numbered, which
// are paid, what the totals come to. The sheet the commission fills by hand
// encodes two rules a plain count does not — one game is one Einsatz however
// many referees were assessed on it, and the season's cap (Infoschreiben 6.2)
// stops the amounts, not the rows.

const visit = (gameId: string, date: string, role: string, refereeName: string) =>
  ({ gameId, matchNo: '38' + gameId, date, role, refereeName, group: 'Varia', level: 'N3-2' });

const base: ExpenseStatement = {
  rcName: 'Canepa Luca', season: 2025, visitRate: 60, paidCap: 12, meetings: [],
  issuedOn: new Date('2026-04-16T10:00:00'),
  visits: [],
};

test('visits are numbered by date, one game with two referees is 6a and 6b, paid once', () => {
  const plan = planExpenseRows({ ...base, visits: [
    visit('g2', '2025-09-18T18:00:00Z', '1. SR', 'Uhlmann Olivia'),
    visit('g1', '2025-09-16T18:00:00Z', '1. SR', 'Nogueira Catarina'),
    // The same game, the 2. SR listed first — the 1. SR still gets "a" and the amount.
    visit('g6', '2026-01-10T13:00:00Z', '2. SR', 'Saric Julija'),
    visit('g6', '2026-01-10T13:00:00Z', '1. SR', 'Gusmini Letizia'),
  ] });
  expect(plan.rows.map((r) => [r.no, r.refereeName, r.amount])).toEqual([
    ['1', 'Nogueira Catarina', 60],
    ['2', 'Uhlmann Olivia', 60],
    ['3a', 'Gusmini Letizia', 60],
    ['3b', 'Saric Julija', null],
  ]);
  expect(plan.paidGames).toBe(3);
  expect(plan.visitsTotal).toBe(180);
  expect(plan.grandTotal).toBe(180);
});

test('games past the cap stay on the sheet, unpaid and marked', () => {
  const visits = Array.from({ length: 14 }, (_, i) => visit(`g${i}`, `2025-10-${String(i + 1).padStart(2, '0')}T18:00:00Z`, '1. SR', `Ref ${i}`));
  const plan = planExpenseRows({ ...base, visits });
  expect(plan.rows).toHaveLength(14);
  expect(plan.rows[11].amount).toBe(60);
  expect(plan.rows[12].amount).toBeNull();
  expect(plan.rows[12].note).toMatch(/Obergrenze/);
  expect(plan.paidGames).toBe(12);
  expect(plan.visitsTotal).toBe(720);
  // No cap set: everything pays.
  expect(planExpenseRows({ ...base, visits, paidCap: null }).visitsTotal).toBe(840);
});

test('the RC-Sitzung is its own line on top of the visits', () => {
  const plan = planExpenseRows({ ...base, visits: [visit('g1', '2025-09-16T18:00:00Z', '1. SR', 'A B')], meetings: [{ date: '2026-04-14', title: 'RC-Sitzung', rate: 60 }] });
  expect(plan.visitsTotal).toBe(60);
  expect(plan.meetingTotal).toBe(60);
  expect(plan.grandTotal).toBe(120);
});

test('the sheet is a PDF, with Inter embedded so a Croatian name is drawn as written', async () => {
  const bytes = await buildExpenseStatementPdf({ ...base, visits: [visit('g1', '2025-09-16T18:00:00Z', '1. SR', 'Šarić Dražen')] });
  expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
});

test('the file is named by season and coach, safely', () => {
  expect(expenseStatementFileName('Canepa Luca', 2025)).toBe('Spesen_2025-26_Canepa_Luca.pdf');
  expect(expenseStatementFileName('Peña/de los Santos', 2026)).toBe('Spesen_2026-27_Pena_de_los_Santos.pdf');
});

// ── One rule for Vergütet and the sheet ──────────────────────────────
// The Übersicht's Vergütet is min(done, cap); the sheet pays the games that
// rule counts done, under the same cap. They used to disagree three ways: the
// sheet paid register-only reports and reports on other coaches' games, and
// read a never-saved cap as "none" while the screen showed 12.

test('the cap: never saved is the Infoschreiben 12, cleared is no ceiling, a number is itself', () => {
  expect(resolvePaidCap(undefined)).toBe(PAID_CAP);
  expect(resolvePaidCap(null)).toBe(PAID_CAP);
  expect(resolvePaidCap('')).toBeNull();
  expect(resolvePaidCap('0')).toBeNull();
  expect(resolvePaidCap('-3')).toBeNull();
  expect(resolvePaidCap('abc')).toBeNull();
  expect(resolvePaidCap('15')).toBe(15);
});

const now = new Date('2026-01-20T12:00:00Z');
const me = { id: 'rc-me', name: 'Luca Canepa' };
const isMe = (rcId: unknown, rcName: unknown) => rcId === me.id || (!rcId && rcName === me.name);
const g = (id: string, date: string, over: Record<string, unknown> = {}) =>
  ({ id, match_date: date, assigned_rc_id: me.id, assigned_rc: me.name, first_referee: 'Coachee One', second_referee: 'Somebody Else', ...over });
const fb = (game: string, coachee: string, over: Record<string, unknown> = {}) =>
  ({ game, coachee, rc_id: me.id, rc_name: me.name, ...over });
const coacheeNames = new Set(['Coachee One']);
const hasCoacheeSlot = (game: Record<string, unknown>) =>
  coacheeNames.has(String(game.first_referee)) || coacheeNames.has(String(game.second_referee));
const rule = (games: Record<string, unknown>[], feedbacks: Record<string, unknown>[], manual: string[] = []) =>
  rcWorkloadRule({ games, feedbacks, inSeason: () => true, now, manualIds: new Set(manual), hasCoacheeSlot })(isMe);

test('done is a coachee report on my own game — the same set the sheet pays', () => {
  const sets = rule(
    [g('a', '2025-10-01T18:00:00Z'), g('b', '2025-11-01T18:00:00Z'), g('c', '2026-03-01T18:00:00Z')],
    [fb('a', 'coachee-1')],
  );
  expect([...sets.done]).toEqual(['a']);
  expect([...sets.outstanding]).toEqual(['b']);
  expect([...sets.planned]).toEqual(['c']);
});

test('a register-only report makes nothing done, so it is never paid', () => {
  // Nobody on the game is a coachee: the game drops out altogether.
  const sets = rule([g('m', '2025-10-01T18:00:00Z', { first_referee: 'Nobody', second_referee: 'Also Nobody' })], [fb('m', '')]);
  expect(sets.done.size + sets.outstanding.size + sets.planned.size).toBe(0);
});

test("a report on the non-coachee referee does not hide the coachee's owed report (logic-01)", () => {
  // 1. SR is a coachee, 2. SR is not; only the 2. SR's register report is filed.
  const sets = rule([g('x', '2025-10-01T18:00:00Z')], [fb('x', '')]);
  expect([...sets.outstanding]).toEqual(['x']);
  expect(sets.done.size).toBe(0);
  // Once the coachee's report is in, the game is done.
  const after = rule([g('x', '2025-10-01T18:00:00Z')], [fb('x', ''), fb('x', 'coachee-1')]);
  expect([...after.done]).toEqual(['x']);
});

test("a report on another coach's game is not my done game, and not my pay", () => {
  const sets = rule([g('o', '2025-10-01T18:00:00Z', { assigned_rc_id: 'rc-other', assigned_rc: 'Other Coach' })], [fb('o', 'coachee-1')]);
  expect(sets.done.size + sets.outstanding.size + sets.planned.size).toBe(0);
});

test('a Testspiel counts nowhere, whatever was filed on it', () => {
  const sets = rule([g('t', '2025-10-01T18:00:00Z')], [fb('t', 'coachee-1')], ['t']);
  expect(sets.done.size + sets.outstanding.size + sets.planned.size).toBe(0);
});

test('Vergütet and the sheet agree: 15 done games, never-saved cap, both pay 12', () => {
  const games = Array.from({ length: 15 }, (_, i) => g(`d${i}`, `2025-10-${String(i + 1).padStart(2, '0')}T18:00:00Z`));
  const sets = rule(games, games.map((x) => fb(String(x.id), 'coachee-1')));
  const cap = resolvePaidCap(undefined);
  const vergutet = Math.min(sets.done.size, cap);
  const visits = [...sets.done].map((id, i) => visit(id, `2025-10-${String(i + 1).padStart(2, '0')}T18:00:00Z`, '1. SR', `Ref ${i}`));
  const plan = planExpenseRows({ ...base, visits, paidCap: cap });
  expect(plan.paidGames).toBe(vergutet);
  expect(plan.paidGames).toBe(12);
});

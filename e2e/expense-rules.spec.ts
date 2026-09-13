import { test, expect } from '@playwright/test';
import { planExpenseRows, buildExpenseStatementPdf, expenseStatementFileName, type ExpenseStatement } from '../server/expenses';

// The Spesenabrechnung's arithmetic on its own: how visits are numbered, which
// are paid, what the totals come to. The sheet the commission fills by hand
// encodes two rules a plain count does not — one game is one Einsatz however
// many referees were assessed on it, and the season's cap (Infoschreiben 6.2)
// stops the amounts, not the rows.

const visit = (gameId: string, date: string, role: string, refereeName: string) =>
  ({ gameId, matchNo: '38' + gameId, date, role, refereeName, group: 'Varia', level: 'N3-2' });

const base: ExpenseStatement = {
  rcName: 'Canepa Luca', season: 2025, visitRate: 60, paidCap: 12, meeting: null,
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
  const plan = planExpenseRows({ ...base, visits: [visit('g1', '2025-09-16T18:00:00Z', '1. SR', 'A B')], meeting: { date: '2026-04-14', rate: 60 } });
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

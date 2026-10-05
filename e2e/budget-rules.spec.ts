import { test, expect } from '@playwright/test';
import { computeBudget, normalizeBudget, DEFAULT_BUDGET } from '../src/lib/budget';

// The season budget on its own: what a visit costs (the Vergütet rule), what a
// meeting costs (attendees × its own rate), extras, and what is left once the
// games already taken are counted too (Luca, 2026-10-05).

const settings = (budget = 5500, extras: Array<{ id: string; label: string; amount: number }> = []) => ({ budget, extras });

test('never saved is CHF 5500 and no extras; junk is dropped', () => {
  expect(normalizeBudget(null)).toEqual({ budget: DEFAULT_BUDGET, extras: [] });
  expect(DEFAULT_BUDGET).toBe(5500);
  expect(normalizeBudget(JSON.stringify({ budget: 4800.555, extras: [
    { id: 'a', label: 'Kurs', amount: 120 }, { id: 'a', label: 'dup', amount: 1 },
    { id: 'b', label: '', amount: 5 }, { id: 'c', label: 'Neg', amount: -5 },
  ] }))).toEqual({ budget: 4800.56, extras: [{ id: 'a', label: 'Kurs', amount: 120 }] });
  expect(normalizeBudget({ budget: -1 }).budget).toBe(5500);
});

test('her example: 50 visited games at CHF 60 leave 2000 of 5000', () => {
  const sum = computeBudget({
    rows: [{ id: 'a', done: 30, outstanding: 0, planned: 0 }, { id: 'b', done: 20, outstanding: 0, planned: 0 }],
    cap: null, visitRate: 60, meetings: [], settings: settings(5000),
  });
  expect(sum.visits).toBe(3000);
  expect(sum.remaining).toBe(2000);
});

test('visits are paid up to the cap; games taken but not filed are committed too', () => {
  const sum = computeBudget({
    rows: [
      { id: 'a', done: 10, outstanding: 1, planned: 3 }, // cap 12: 10 paid, 2 still payable
      { id: 'b', done: 14, outstanding: 0, planned: 2 }, // over the cap: 12 paid, nothing more
      { id: 'c', done: 0, outstanding: 0, planned: 2 },
    ],
    cap: 12, visitRate: 60, meetings: [], settings: settings(),
  });
  expect(sum.paidGames).toBe(22);
  expect(sum.upcomingGames).toBe(4);
  expect(sum.visits).toBe(1320);
  expect(sum.upcomingVisits).toBe(240);
  expect(sum.remaining).toBe(5500 - 1320 - 240);
  expect(sum.perRc.b).toMatchObject({ paidGames: 12, upcomingGames: 0 });
});

test('a meeting costs its attendees × its own rate; extras come off too', () => {
  const sum = computeBudget({
    rows: [{ id: 'a', done: 2, outstanding: 0, planned: 0, paidAt: '2026-12-01' }, { id: 'b', done: 1, outstanding: 0, planned: 0 }],
    cap: null, visitRate: 60,
    meetings: [{ id: 'm1', rate: 60, attended: ['a', 'b', 'gone'] }, { id: 'm2', rate: 0, attended: ['a'] }],
    settings: settings(5500, [{ id: 'x', label: 'Kursmaterial', amount: 80 }]),
  });
  expect(sum.meetingAttendances).toBe(4);
  // A tick for a coach no longer on the roster is still money spent.
  expect(sum.meetings).toBe(180);
  expect(sum.extras).toBe(80);
  expect(sum.spent).toBe(180 + 180 + 80);
  expect(sum.remaining).toBe(5500 - 440);
  expect(sum.perRc.a).toMatchObject({ visits: 120, meetings: 60, claim: 180, paidOut: true });
  expect(sum.perRc.b.claim).toBe(120);
  expect(sum.paidOut).toBe(180);
  expect(sum.owed).toBe(360 - 180);
});

test('over budget goes negative rather than stopping at zero', () => {
  const sum = computeBudget({ rows: [{ id: 'a', done: 100, outstanding: 0, planned: 0 }], cap: null, visitRate: 60, meetings: [], settings: settings(5500) });
  expect(sum.remaining).toBe(-500);
});

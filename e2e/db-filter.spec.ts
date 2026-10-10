import { test, expect } from '@playwright/test';
import { filterToWhere, sortToOrderBy, FilterError, TRUE, FALSE } from '../server/db/filter';
import { COLLECTIONS } from '../server/db/collections';

// The PocketBase filter strings the server still writes, as Prisma `where`
// objects with PocketBase's own semantics (server/db/filter.ts). Each rule
// here was observed on a PocketBase 0.40.5 copy of production on 10.10.2026;
// deploy/postgres/compare-backends.ts checks the same rules end to end against
// both databases. These pin the translation without either.

const games = COLLECTIONS.games;
const coachees = COLLECTIONS.coachees;
const feedbacks = COLLECTIONS.referee_coach_feedbacks;
const rcs = COLLECTIONS.referee_coaches;
const settings = COLLECTIONS.app_settings;

test.describe('empty values', () => {
  test('text: "" and null are the empty string', () => {
    expect(filterToWhere('assigned_at = ""', games)).toEqual({ assigned_at: '' });
    expect(filterToWhere('assigned_at = null', games)).toEqual({ assigned_at: '' });
    expect(filterToWhere('assigned_rc != ""', games)).toEqual({ assigned_rc: { not: '' } });
  });

  test('a number is never empty — season = "" matched nothing in PocketBase', () => {
    expect(filterToWhere("season = ''", coachees)).toEqual(FALSE);
    expect(filterToWhere('season = null', coachees)).toEqual(FALSE);
    expect(filterToWhere("season != ''", coachees)).toEqual(TRUE);
  });

  test('a relation is empty when not set (NULL here, "" in PocketBase)', () => {
    expect(filterToWhere('game = ""', feedbacks)).toEqual({ game: null });
    expect(filterToWhere('game != ""', feedbacks)).toEqual({ game: { not: null } });
  });

  test('!= on a relation includes the rows without one, as IS NOT did', () => {
    expect(filterToWhere('game != "abc"', feedbacks)).toEqual({ OR: [{ game: null }, { game: { not: 'abc' } }] });
  });
});

test.describe('numbers and booleans', () => {
  test('a numeric string compares as a number', () => {
    expect(filterToWhere('season = "2026"', coachees)).toEqual({ season: 2026 });
    expect(filterToWhere('season = 2026', coachees)).toEqual({ season: 2026 });
  });

  test('any other string is greater than every number', () => {
    expect(filterToWhere('season > "abc"', coachees)).toEqual(FALSE);
    expect(filterToWhere('season < "abc"', coachees)).toEqual(TRUE);
  });

  test('booleans: true/false/1/0, not the text "true"', () => {
    expect(filterToWhere('active = true', rcs)).toEqual({ active: true });
    expect(filterToWhere('active = 1', rcs)).toEqual({ active: true });
    expect(filterToWhere('active = 0', rcs)).toEqual({ active: false });
    expect(filterToWhere('active = "true"', rcs)).toEqual(FALSE);
    expect(filterToWhere('active != null', rcs)).toEqual(TRUE);
  });
});

test.describe('created / updated', () => {
  test('an empty stamp was "" and sorted first: < includes it, > does not', () => {
    expect(filterToWhere('created < "2026-10-10 17:00:00.000Z"', games)).toEqual({
      OR: [{ created: null }, { created: { lt: new Date('2026-10-10T17:00:00.000Z') } }],
    });
    expect(filterToWhere('created > "2026-10-10 17:00:00.000Z"', games)).toEqual({
      created: { gt: new Date('2026-10-10T17:00:00.000Z') },
    });
    expect(filterToWhere('created = ""', games)).toEqual({ created: null });
  });

  test('a bare date compared as text: a stamp on that day is greater than it', () => {
    expect(filterToWhere('created > "2030-01-01"', games)).toEqual({ created: { gte: new Date('2030-01-01T00:00:00.000Z') } });
    expect(filterToWhere('created <= "2030-01-01"', games)).toEqual({
      OR: [{ created: null }, { created: { lt: new Date('2030-01-01T00:00:00.000Z') } }],
    });
  });

  test('any other date shape is refused rather than guessed', () => {
    expect(() => filterToWhere('created > "2026-09-01T00:00:00Z"', games)).toThrow(FilterError);
  });
});

test.describe('text', () => {
  test('~ is a case-insensitive contains', () => {
    expect(filterToWhere('key ~ "president_notes_"', settings)).toEqual({ key: { contains: 'president_notes_', mode: 'insensitive' } });
    expect(filterToWhere('key !~ "notes"', settings)).toEqual({ NOT: { key: { contains: 'notes', mode: 'insensitive' } } });
  });

  test('a ~ value with % (a raw LIKE pattern in PocketBase) is refused', () => {
    expect(() => filterToWhere('key ~ "a%b"', settings)).toThrow(FilterError);
  });

  test('ordered comparisons stay text comparisons', () => {
    expect(filterToWhere('match_date >= "2026-10-10T00:00:00Z" && match_date < "2026-10-11"', games)).toEqual({
      AND: [{ match_date: { gte: '2026-10-10T00:00:00Z' } }, { match_date: { lt: '2026-10-11' } }],
    });
  });

  test('quotes: only \\" is unescaped, as in PocketBase\'s scanner', () => {
    expect(filterToWhere('full_name = "Anna \\"Nina\\" Muster"', coachees)).toEqual({ full_name: 'Anna "Nina" Muster' });
    expect(filterToWhere("full_name = 'O\\'Brien'", coachees)).toEqual({ full_name: "O'Brien" });
    expect(filterToWhere('full_name = "a\\\\b"', coachees)).toEqual({ full_name: 'a\\\\b' });
  });
});

test.describe('grammar', () => {
  test('&& binds tighter than ||', () => {
    expect(filterToWhere('assigned_rc != "" || league = "x" && match_no = "1"', games)).toEqual({
      OR: [{ assigned_rc: { not: '' } }, { AND: [{ league: 'x' }, { match_no: '1' }] }],
    });
  });

  test('parentheses group', () => {
    expect(filterToWhere('id != "a" && (assigned_rc != "" || assigned_rc_id != "")', games)).toEqual({
      AND: [{ id: { not: 'a' } }, { OR: [{ assigned_rc: { not: '' } }, { assigned_rc_id: { not: '' } }] }],
    });
  });

  test('no filter matches everything', () => {
    expect(filterToWhere('', games)).toEqual(TRUE);
    expect(filterToWhere(undefined, games)).toEqual(TRUE);
  });

  test('unknown fields, JSON fields and any-of operators are refused', () => {
    expect(() => filterToWhere('nosuchfield = 1', games)).toThrow(FilterError);
    expect(() => filterToWhere('handed_over = null', games)).toThrow(FilterError);
    expect(() => filterToWhere('league ?= "x"', games)).toThrow(FilterError);
    expect(() => filterToWhere('league = ', games)).toThrow(FilterError);
    expect(() => filterToWhere('(league = "x"', games)).toThrow(FilterError);
  });
});

test.describe('sort', () => {
  test('ties, and no sort at all, in insertion order', () => {
    expect(sortToOrderBy('', games)).toEqual([{ seq: 'asc' }]);
    expect(sortToOrderBy('-match_date', games)).toEqual([{ match_date: 'desc' }, { seq: 'asc' }]);
    expect(sortToOrderBy('last_name,first_name', rcs)).toEqual([{ last_name: 'asc' }, { first_name: 'asc' }, { seq: 'asc' }]);
  });

  test('an empty stamp sorted before every date, both ways', () => {
    expect(sortToOrderBy('-created', games)).toEqual([{ created: { sort: 'desc', nulls: 'last' } }, { seq: 'asc' }]);
    expect(sortToOrderBy('created', games)).toEqual([{ created: { sort: 'asc', nulls: 'first' } }, { seq: 'asc' }]);
  });

  test('unknown and JSON sort fields are refused', () => {
    expect(() => sortToOrderBy('nosuch', games)).toThrow(FilterError);
    expect(() => sortToOrderBy('source_payload', games)).toThrow(FilterError);
  });
});

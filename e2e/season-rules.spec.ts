import { test, expect } from '@playwright/test';
import {
  parseSeason, coacheeRowSeason, seasonOfGame, pickSeason, seasonDateFilter, seasonWindowFilter, indexBySeason,
} from '../server/season';
import { inSeasonOrManual } from '../src/lib/season';

// The season rules on their own, without a PocketBase — the way the games
// sync's row rules are tested. The one that matters most is pickSeason: the
// admin console once asked for the overview with no season, the server read
// "no season" as "every season ever synced", and a U18 final from the March
// before was counted as this season's unfinished observation. A request that
// names no season now gets the default, and never a null.

test.describe('which season a request is about', () => {
  test('a valid parameter wins, and never asks for the default', () => {
    expect(pickSeason('2026', 2031)).toBe(2026);
    expect(pickSeason(2025, null)).toBe(2025);
  });

  test('a missing or unusable parameter is the default season', () => {
    for (const raw of [undefined, null, '', 'abc', '0', '1999', '2101', '2026.5', ' 2026 ']) {
      expect(pickSeason(raw, 2031), `raw=${JSON.stringify(raw)}`).toBe(raw === ' 2026 ' ? 2026 : 2031);
    }
  });

  test('with no default either, it is the season today falls in — never null', () => {
    expect(pickSeason(undefined, null, new Date('2026-09-13T10:00:00'))).toBe(2026);
    expect(pickSeason('abc', null, new Date('2026-03-21T10:00:00'))).toBe(2025);
  });

  test('parseSeason takes whole years in range only', () => {
    expect(parseSeason('2026')).toBe(2026);
    expect(parseSeason(2026)).toBe(2026);
    expect(parseSeason('2026.5')).toBeNull();
    expect(parseSeason('999')).toBeNull();
    expect(parseSeason('')).toBeNull();
  });

  test('a seasonless coachee row is null, not the year zero', () => {
    expect(coacheeRowSeason(null)).toBeNull();
    expect(coacheeRowSeason('')).toBeNull();
    expect(coacheeRowSeason(0)).toBe(0);
    expect(coacheeRowSeason('2025')).toBe(2025);
  });
});

test.describe('which season a date belongs to', () => {
  test('September opens a season; May–August belongs to the one just ended', () => {
    expect(seasonOfGame('2026-09-01T18:00:00')).toBe(2026);
    expect(seasonOfGame('2026-03-21T14:30:00')).toBe(2025);
    expect(seasonOfGame('2026-07-01T18:00:00')).toBe(2025);
    expect(seasonOfGame('')).toBeNull();
    expect(seasonOfGame('not a date')).toBeNull();
  });
});

test.describe('the window a list is cut to', () => {
  const in2026 = seasonDateFilter(2026);

  test('runs from 1 September to 30 April', () => {
    expect(in2026('2026-08-31T23:59:59')).toBe(false);
    expect(in2026('2026-09-01T00:00:00')).toBe(true);
    expect(in2026('2027-04-30T23:59:59')).toBe(true);
    expect(in2026('2027-05-01T00:00:00')).toBe(false);
    // The row from the screenshot.
    expect(in2026('2026-03-21T14:30:00')).toBe(false);
  });

  test('an unparseable date is kept — a data gap, not a reason to hide a game', () => {
    expect(in2026('')).toBe(true);
    expect(in2026('tbd')).toBe(true);
  });

  test('a test game passes whatever its date', () => {
    const keep = seasonWindowFilter(2026, new Set(['g-test']));
    expect(keep({ id: 'g-test', match_date: '2026-07-01T18:00:00' })).toBe(true);
    expect(keep({ id: 'g-real', match_date: '2026-07-01T18:00:00' })).toBe(false);
    expect(keep({ id: 'g-real', match_date: '2026-10-10T18:00:00' })).toBe(true);
  });

  test('the client draws the same window, in Zürich days', () => {
    // 23:59 on 31 August in Zürich is still out; half past midnight is in.
    expect(inSeasonOrManual({ date: '2026-08-31T21:59:00Z' }, 2026)).toBe(false);
    expect(inSeasonOrManual({ date: '2026-08-31T22:30:00Z' }, 2026)).toBe(true);
    expect(inSeasonOrManual({ date: '2027-04-30T12:00:00Z' }, 2026)).toBe(true);
    expect(inSeasonOrManual({ date: '2027-04-30T22:30:00Z' }, 2026)).toBe(false);
    expect(inSeasonOrManual({ date: '2026-03-21T13:30:00Z' }, 2026)).toBe(false);
    expect(inSeasonOrManual({ date: '2026-03-21T13:30:00Z' }, 2025)).toBe(true);
    expect(inSeasonOrManual({ date: '2026-07-01T18:00:00Z', isManual: true }, 2026)).toBe(true);
    expect(inSeasonOrManual({}, 2026)).toBe(true);
  });
});

test.describe('matching a game to the coachee row of its season', () => {
  const index = indexBySeason([
    { season: 2025, names: ['anna muster'], value: 'anna-2025' },
    { season: 2026, names: ['anna muster'], value: 'anna-2026' },
    { season: null, names: ['old timer'], value: 'old-any' },
    { season: 2025, names: ['last only'], value: 'last-2025' },
  ]);

  test('takes the row of the game\'s own season', () => {
    expect(index.find(2026, 'anna muster')).toBe('anna-2026');
    expect(index.find(2025, 'anna muster')).toBe('anna-2025');
  });

  test('a seasonless row answers for any season; another season\'s row does not', () => {
    expect(index.find(2027, 'old timer')).toBe('old-any');
    expect(index.find(2026, 'last only')).toBeUndefined();
  });

  test('an undated game matches any season\'s row', () => {
    expect(index.find(null, 'last only')).toBe('last-2025');
    expect(index.find(null, 'nobody')).toBeUndefined();
  });
});

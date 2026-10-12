import { test, expect } from '@playwright/test';
import {
  fileSeasonRows, fileSeasons, fileStatistics, fileStrengths, firstToLatest, seasonChange,
  type FileStatsEntry,
} from '../src/lib/coacheeFileStats';
import { gradeAvg } from '../src/lib/statistics';

// The dossier's statistics (/dossier → Statistik) on their own: what counts,
// how the averages are made, and how a season is compared with the ones
// before it. Scores arrive already folded into letters (C = 8, B = 11 …).

const g = (id: string, section: number, score: number) => ({ id, section, score });
const entry = (id: string, over: Partial<FileStatsEntry>): FileStatsEntry => ({
  id, date: '', role: '1. SR', rc: 'Anna Coach', isTest: false, season: null, ratings: [], ...over,
});

const ENTRIES: FileStatsEntry[] = [
  entry('a', { date: '2024-11-10', season: 2024, ratings: [g('p1', 0, 8), g('p2', 0, 5), g('t1', 1, 8)] }),
  entry('b', { date: '2025-02-01', season: 2024, role: '2. SR', rc: 'Max Muster', ratings: [g('x1', 0, 11)] }),
  entry('c', { date: '2025-10-05', season: 2025, rc: 'anna coach ', ratings: [g('p1', 0, 11), g('p2', 0, 8), g('t1', 1, 11)] }),
  entry('d', { date: '2026-01-20', season: 2025, rc: 'Ben Beispiel', ratings: [g('p1', 0, 11), g('p2', 0, 8), g('t1', 1, 14)] }),
  // Filed, but without a single grade.
  entry('n', { date: '2026-03-01', season: 2025 }),
  // Testspiele never count, wherever they fall.
  entry('t', { date: '2026-02-01', season: 2025, isTest: true, ratings: [g('p1', 0, 2)] }),
  entry('t0', { date: '2023-10-01', season: 2023, isTest: true, ratings: [g('p1', 0, 2)] }),
];

test.describe('the dossier statistics', () => {
  test('count every report but a Testspiel; average over every grade', () => {
    const s = fileStatistics(ENTRIES);
    expect(s).toMatchObject({ reports: 5, graded: 4, roles: { '1SR': 4, '2SR': 1 }, first: '2024-11-10', last: '2026-03-01' });
    // The same coach spelled twice is one coach.
    expect(s.coaches).toBe(3);
    // 10 grades, 95 points: a report with three grades weighs three.
    expect(s.grade).toEqual({ obs: 4, items: 10, sum: 95 });
    expect(gradeAvg(s.grade)).toBe(9.5);
    expect(s.letters).toEqual({ A: 1, B: 4, C: 4, D: 1, E: 0 });
    expect(s.timeline.map((p) => [p.id, p.avg])).toEqual([['a', 7], ['b', 11], ['c', 10], ['d', 11], ['n', null]]);
  });

  test('per section and per criterion, kept apart by role', () => {
    const s = fileStatistics(ENTRIES);
    const sec = (role: string, section: number) => s.sections.find((x) => x.role === role && x.section === section)!.grade;
    // A section counts a report once, with every grade it gave there.
    expect(sec('1SR', 0)).toEqual({ obs: 3, items: 6, sum: 51 });
    expect(gradeAvg(sec('1SR', 1))).toBe(11);
    expect(sec('2SR', 0)).toEqual({ obs: 1, items: 1, sum: 11 });
    const crit = (id: string) => gradeAvg(s.criteria.find((x) => x.id === id)!.grade);
    expect([crit('p1'), crit('p2'), crit('t1')]).toEqual([10, 7, 11]);
  });

  test('a season alone, and the seasons before it', () => {
    expect(fileSeasons(ENTRIES)).toEqual([2025, 2024]);
    const now = fileStatistics(ENTRIES, { season: 2025 });
    expect(now).toMatchObject({ reports: 3, graded: 2 });
    expect(gradeAvg(now.grade)).toBe(10.5);
    const before = fileStatistics(ENTRIES, { before: 2025 });
    expect(before.timeline.map((p) => p.id)).toEqual(['a', 'b']);
    expect(gradeAvg(before.grade)).toBe(8);
  });

  test('seasons compared: oldest first, a season against the last graded one before it', () => {
    const rows = fileSeasonRows(ENTRIES);
    expect(rows.map((r) => [r.season, r.reports])).toEqual([[2024, 2], [2025, 3]]);
    expect(seasonChange(rows, 2025)).toEqual({ season: 2025, previous: 2024, delta: 2.5, reading: 'improved' });
    expect(seasonChange(rows, 2024)).toBeNull();
    // Within a third of a letter is "the same".
    const flat = fileSeasonRows([
      entry('x', { season: 2024, ratings: [g('p1', 0, 8)] }),
      entry('y', { season: 2025, ratings: [g('p1', 0, 8), g('p2', 0, 8), g('p3', 0, 9)] }),
    ]);
    expect(seasonChange(flat, 2025)?.reading).toBe('same');
  });

  test('first report against the latest', () => {
    expect(firstToLatest(fileStatistics(ENTRIES))).toEqual({ first: 7, last: 11, reading: 'improved' });
    expect(firstToLatest(fileStatistics(ENTRIES, { before: 2025 }))).toEqual({ first: 7, last: 11, reading: 'improved' });
    expect(firstToLatest(fileStatistics([ENTRIES[0]]))).toBeNull();
  });

  test('strengths: against the referee\'s own average, from three reports and a third of a letter apart', () => {
    const sw = fileStrengths(fileStatistics(ENTRIES), '1SR');
    expect(sw.avg).toBe(9.3);
    expect(sw.strong.map((c) => c.id)).toEqual(['t1']);
    expect(sw.weak.map((c) => c.id)).toEqual(['p2']);
    // Two reports are not enough to call anything a strength.
    const thin = fileStrengths(fileStatistics(ENTRIES, { season: 2025 }), '1SR');
    expect([thin.strong, thin.weak]).toEqual([[], []]);
  });
});

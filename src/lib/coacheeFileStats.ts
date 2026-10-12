// "Meine Statistik" — the numbers on a coached referee's own dossier page.
//
// Pure, like src/lib/statistics.ts, whose scale and rules it reuses: the
// server sends each report's season and its graded criteria (already folded
// into the five letters, server/coacheeFile.ts formRatings), and everything
// here is counted in the browser from the referee's own reports alone. No
// other referee's grade ever reaches this page, so there is no "compared with
// others" — the only comparison is with the referee's own earlier seasons.
//
// The rules, the same as Admin → Statistik:
//  - an average is over every graded criterion (a report with 20 grades weighs
//    20), on the 1–15 scale, shown as its letter;
//  - below MIN_OBS_FOR_AVG reports an average is thin: shown, drawn hollow;
//  - a Testspiel does not count — it is someone trying the flow out;
//  - a season is the game's (Sept–Apr), named by its starting year.

import {
  emptyGrade, gradeAvg, isThin, strengthsAndWeaknesses, trendOf, scoreToLetter,
  type CriterionProfile, type GradeAgg, type StatLetter, type StatRole,
} from './statistics';

export type FileStatsEntry = {
  id: string;
  date: string;
  role: string;
  rc: string;
  isTest: boolean;
  season?: number | null;
  ratings?: Array<{ id: string; section: number; score: number }>;
};

export const statRoleOf = (role: string): StatRole => (/2/.test(role) ? '2SR' : '1SR');

/** The reports the statistics count: every one but a Testspiel. */
export const countedEntries = <T extends FileStatsEntry>(entries: T[]): T[] => entries.filter((e) => !e.isTest);

/** The seasons with a counted report, newest first. */
export function fileSeasons(entries: FileStatsEntry[]): number[] {
  const set = new Set<number>();
  for (const e of countedEntries(entries)) if (typeof e.season === 'number') set.add(e.season);
  return [...set].sort((a, b) => b - a);
}

export type FileTimelinePoint = { id: string; date: string; season: number | null; role: StatRole; avg: number | null; n: number };
export type FileSectionAgg = { role: StatRole; section: number; grade: GradeAgg };
export type FileCriterionAgg = { role: StatRole; section: number; id: string; grade: GradeAgg };

export type FileStats = {
  /** Counted reports in the slice, graded or not. */
  reports: number;
  /** Of those, the ones with at least one grade. */
  graded: number;
  roles: Record<StatRole, number>;
  /** Distinct coaches who wrote them. */
  coaches: number;
  /** Oldest and newest game date, YYYY-MM-DD; '' without a report. */
  first: string;
  last: string;
  grade: GradeAgg;
  byRole: Record<StatRole, GradeAgg>;
  /** Every grade given, by letter. */
  letters: Record<StatLetter, number>;
  /** Each report's own average, oldest first. */
  timeline: FileTimelinePoint[];
  sections: FileSectionAgg[];
  criteria: FileCriterionAgg[];
};

const add = (g: GradeAgg, sum: number, items: number): void => {
  if (items === 0) return;
  g.obs += 1;
  g.items += items;
  g.sum += sum;
};

/** The statistics of a slice: one season (`season`), every season before one
 *  (`before` — what a season is compared with), or everything. */
export function fileStatistics(entries: FileStatsEntry[], slice: { season?: number | null; before?: number } = {}): FileStats {
  const list = countedEntries(entries).filter((e) => {
    if (typeof slice.season === 'number') return e.season === slice.season;
    if (typeof slice.before === 'number') return typeof e.season === 'number' && e.season < slice.before;
    return true;
  });
  const out: FileStats = {
    reports: list.length,
    graded: 0,
    roles: { '1SR': 0, '2SR': 0 },
    coaches: new Set(list.map((e) => e.rc.trim().toLowerCase()).filter(Boolean)).size,
    first: '',
    last: '',
    grade: emptyGrade(),
    byRole: { '1SR': emptyGrade(), '2SR': emptyGrade() },
    letters: { A: 0, B: 0, C: 0, D: 0, E: 0 },
    timeline: [],
    sections: [],
    criteria: [],
  };
  const sections = new Map<string, FileSectionAgg>();
  const criteria = new Map<string, FileCriterionAgg>();
  const ordered = [...list].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const e of ordered) {
    const role = statRoleOf(e.role);
    out.roles[role] += 1;
    if (e.date && (!out.first || e.date < out.first)) out.first = e.date;
    if (e.date && e.date > out.last) out.last = e.date;
    const ratings = e.ratings ?? [];
    const sum = ratings.reduce((a, r) => a + r.score, 0);
    if (ratings.length) out.graded += 1;
    add(out.grade, sum, ratings.length);
    add(out.byRole[role], sum, ratings.length);
    out.timeline.push({
      id: e.id, date: e.date, season: e.season ?? null, role,
      avg: ratings.length ? Math.round((sum / ratings.length) * 10) / 10 : null,
      n: ratings.length,
    });
    // A section counts a report once, with every grade it gave there.
    const perSection = new Map<number, { sum: number; items: number }>();
    for (const r of ratings) {
      out.letters[scoreToLetter(r.score)] += 1;
      const s = perSection.get(r.section) ?? { sum: 0, items: 0 };
      s.sum += r.score;
      s.items += 1;
      perSection.set(r.section, s);
      const ck = `${role}|${r.section}|${r.id}`;
      const c = criteria.get(ck) ?? { role, section: r.section, id: r.id, grade: emptyGrade() };
      add(c.grade, r.score, 1);
      criteria.set(ck, c);
    }
    for (const [section, s] of perSection) {
      const sk = `${role}|${section}`;
      const agg = sections.get(sk) ?? { role, section, grade: emptyGrade() };
      add(agg.grade, s.sum, s.items);
      sections.set(sk, agg);
    }
  }
  const byPlace = (a: { role: StatRole; section: number }, b: { role: StatRole; section: number }) =>
    a.role.localeCompare(b.role) || a.section - b.section;
  out.sections = [...sections.values()].sort(byPlace);
  // Within a section, in the order first met; the page lays them out in the
  // form's own order anyway.
  out.criteria = [...criteria.values()].sort(byPlace);
  return out;
}

export type FileSeasonRow = {
  season: number;
  reports: number;
  roles: Record<StatRole, number>;
  grade: GradeAgg;
  byRole: Record<StatRole, GradeAgg>;
};

/** One row per season with a counted report, oldest first. */
export function fileSeasonRows(entries: FileStatsEntry[]): FileSeasonRow[] {
  return fileSeasons(entries).reverse().map((season) => {
    const s = fileStatistics(entries, { season });
    return { season, reports: s.reports, roles: s.roles, grade: s.grade, byRole: s.byRole };
  });
}

export type SeasonChange = { season: number; previous: number; delta: number; reading: 'improved' | 'same' | 'worse' };

/** A season's average against the latest season before it that has grades —
 *  how the page says "better than last season". Null when either side has
 *  no grade. A third of a letter (TREND_SAME_BAND) or less is "the same". */
export function seasonChange(rows: FileSeasonRow[], season: number): SeasonChange | null {
  const at = rows.findIndex((r) => r.season === season);
  if (at < 0) return null;
  const now = gradeAvg(rows[at].grade);
  if (now === null) return null;
  for (let i = at - 1; i >= 0; i -= 1) {
    const before = gradeAvg(rows[i].grade);
    if (before === null) continue;
    const delta = Math.round((now - before) * 10) / 10;
    return { season, previous: rows[i].season, delta, reading: trendOf(delta) };
  }
  return null;
}

/** First graded report against the latest one — the "since the first visit"
 *  line. Null under two graded reports. */
export function firstToLatest(stats: FileStats): { first: number; last: number; reading: 'improved' | 'same' | 'worse' } | null {
  const graded = stats.timeline.filter((p) => p.avg !== null);
  if (graded.length < 2) return null;
  const first = graded[0].avg!;
  const last = graded[graded.length - 1].avg!;
  return { first, last, reading: trendOf(last - first) };
}

/** Where this referee is strongest and weakest in one role: each criterion
 *  against their OWN average in that role, from three reports up — the same
 *  rule as the commission's strengths & weaknesses. */
export function fileStrengths(stats: FileStats, role: StatRole, k = 3): { avg: number | null; strong: CriterionProfile[]; weak: CriterionProfile[] } {
  const avg = gradeAvg(stats.byRole[role]);
  const criteria: CriterionProfile[] = stats.criteria.filter((c) => c.role === role).map((c) => {
    const a = gradeAvg(c.grade);
    return {
      id: c.id, section: c.section, avg: a, n: c.grade.obs,
      diff: a !== null && avg !== null && !isThin(c.grade.obs) ? Math.round((a - avg) * 10) / 10 : null,
    };
  });
  return { avg, ...strengthsAndWeaknesses({ role, avg, n: stats.byRole[role].obs, criteria }, k) };
}

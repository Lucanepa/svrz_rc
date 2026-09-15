// The season statistics — the shape the server's aggregator answers with and
// the small helpers both sides read it through (Admin → Statistik, the deck
// exporters). Pure: no fetch, no DOM, so server/statistics.ts imports it too.
//
// Every number here is a COUNT or a SUM. The coach's remarks are counted on the
// server and only their word and character counts travel; the text itself is
// about a named referee and stays where it was filed.

export type StatRole = '1SR' | '2SR';
export const STAT_ROLES: StatRole[] = ['1SR', '2SR'];

// ── Grades ───────────────────────────────────────────────────────────────────
// The same 1–15 scale the server writes into observations.grades: E- = 1 …
// C = 8 (the "Normalfall") … A+ = 15. An average is a point on this scale and
// is shown as both the number and the letter nearest to it.
export const GRADE_SCALE: Record<string, number> = {
  'E-': 1, E: 2, 'E+': 3, 'D-': 4, D: 5, 'D+': 6, 'C-': 7, C: 8, 'C+': 9,
  'B-': 10, B: 11, 'B+': 12, 'A-': 13, A: 14, 'A+': 15,
};
/** Best first — the order a histogram reads them in. */
export const GRADE_ORDER = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'E+', 'E', 'E-'];
export const GRADE_LETTERS = ['A', 'B', 'C', 'D', 'E'];
export const NORMAL_SCORE = GRADE_SCALE.C;

export function gradeToScore(rating: string): number | null {
  const score = GRADE_SCALE[String(rating ?? '').trim().toUpperCase()];
  return typeof score === 'number' ? score : null;
}

/** The letter nearest a score: 8.4 → "C", 8.6 → "C+", 11.5 → "B+". */
export function scoreToLetter(score: number): string {
  const n = Math.min(15, Math.max(1, Math.round(score)));
  return GRADE_ORDER.find((g) => GRADE_SCALE[g] === n) ?? 'C';
}

/** A grade aggregate: how many observations fed it, how many rated criteria
 *  they held, and the sum of their scores. Kept as sums so sections can be
 *  built from their criteria and seasons compared without re-reading rows. */
export type GradeAgg = { obs: number; items: number; sum: number };
export const emptyGrade = (): GradeAgg => ({ obs: 0, items: 0, sum: 0 });

/** The minimum observations behind an average before it is shown. One visit
 *  is a fact about one evening; three are the start of a pattern. */
export const MIN_OBS_FOR_AVG = 3;

export function gradeAvg(g: GradeAgg | undefined, minObs = MIN_OBS_FOR_AVG): number | null {
  if (!g || g.obs < minObs || g.items === 0) return null;
  return Math.round((g.sum / g.items) * 10) / 10;
}

export function mergeGrade(into: GradeAgg, add: GradeAgg): GradeAgg {
  return { obs: into.obs + add.obs, items: into.items + add.items, sum: into.sum + add.sum };
}

// ── Writing ──────────────────────────────────────────────────────────────────
export function countWords(plain: string): number {
  const t = String(plain ?? '').trim();
  return t ? t.split(/\s+/).length : 0;
}
export function countChars(plain: string): number {
  return String(plain ?? '').replace(/\s+/g, '').length;
}
/** Words on a typed A4 page — the slide's "how many pages was that". */
export const WORDS_PER_A4 = 500;
/** Minutes a set takes, for the "hours in the hall" estimate. */
export const MINUTES_PER_SET = 25;

// ── Result shape ─────────────────────────────────────────────────────────────
export type Dist = Record<string, number>;

export type StatBucket = {
  key: string;
  label: string;
  observations: number;
  /** Distinct coachees observed. */
  coachees: number;
  /** Distinct games — a game with both referees assessed counts once. */
  games: number;
  /** Sets and points, per distinct game. */
  sets: number;
  points: number;
  words: number;
  roles: Record<StatRole, number>;
  grade: GradeAgg;
};

export type RcBucket = StatBucket & {
  /** The season goal (Pensum) and the Übersicht's planned / outstanding games. */
  goal: number;
  planned: number;
  outstanding: number;
};

export type SectionAgg = { role: StatRole; section: number; grade: GradeAgg };
export type CriterionAgg = { role: StatRole; section: number; id: string; grade: GradeAgg };

export type StatTotals = {
  observations: number;
  games: number;
  coachees: number;
  /** Coachees on the season's roster (active), after the filters. */
  roster: number;
  rcsActive: number;
  rcsTotal: number;
  /** Sum of every RC's Pensum, and observations against it. */
  goal: number;
  sets: number;
  points: number;
  deciders: number;
  longestGame: { label: string; sets: number; points: number } | null;
  halls: number;
  teams: number;
  words: number;
  chars: number;
  wordsMedian: number | null;
  longestRemark: number;
  filledHighlights: number;
  filledImprovements: number;
  filledGoals: number;
  /** Rated criteria and the criteria the forms offered — completeness. */
  ratedItems: number;
  offeredItems: number;
  grade: GradeAgg;
  /** Ratings exactly C, and B- or better. */
  ratingsC: number;
  ratingsBPlus: number;
  ratingsAll: number;
  signedReferee: number;
  signedRc: number;
  langDE: number;
  langEN: number;
  /** Days between the game and the filing: median, filed the same day, 8+ days. */
  filingMedianDays: number | null;
  filedSameDay: number;
  filedLate: number;
};

export type StatFun = {
  busiestDay: { key: string; count: number } | null;
  topHall: { name: string; count: number } | null;
  topCoachee: { name: string; count: number } | null;
  topWriter: { name: string; words: number } | null;
  first: string | null;
  last: string | null;
};

export type StatFilters = {
  rc?: string;
  group?: string;
  /** "N3" for the whole Niveau, "N3-2" for one Stufe. */
  level?: string;
  role?: StatRole;
};

export type SeasonStatisticsCore = {
  season: number;
  generatedAt: string;
  filters: StatFilters;
  totals: StatTotals;
  byRole: StatBucket[];
  /** Sep → Apr, keyed YYYY-MM; a month outside the window appears only when it has an observation. */
  byMonth: StatBucket[];
  byRc: RcBucket[];
  byGroup: StatBucket[];
  /** N1 … N4. */
  byLevel: StatBucket[];
  /** N4-3 … N1, the official rows. */
  byStufe: StatBucket[];
  byLeague: StatBucket[];
  /** H / D / J / '' (unparsed). */
  byCategory: StatBucket[];
  /** NL, 1 … 5. */
  byDivision: StatBucket[];
  /** 1 (Monday) … 7 (Sunday). */
  byWeekday: StatBucket[];
  /** Kick-off hour, Europe/Zurich. */
  byHour: StatBucket[];
  /** Every rating given, A+ … E-. */
  histogram: Dist;
  sections: SectionAgg[];
  criteria: CriterionAgg[];
  /** Coachees by visits: '0' | '1' | '2' | '3+'. */
  coacheeVisits: Dist;
  outcomes: {
    einstufung: Dist;
    motivation: Dist;
    spielniveau: Dist;
    secondBesuch: Dist;
    srZiel: Dist;
  };
  fun: StatFun;
};

export type SeasonStatistics = SeasonStatisticsCore & {
  /** The season before, same filters — null when it holds no observation. */
  previous: SeasonStatisticsCore | null;
};

/** The options the filter row offers — read off the unfiltered season. */
export type StatOptions = {
  rcs: Array<{ id: string; name: string }>;
  groups: string[];
  levels: string[];
  seasons: number[];
};

export type StatisticsResponse = { stats: SeasonStatistics; options: StatOptions };

// ── Derived readings ─────────────────────────────────────────────────────────
export const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

export function estimatedHours(sets: number): number {
  return Math.round((sets * MINUTES_PER_SET) / 60);
}

export function a4Pages(words: number): number {
  return Math.round((words / WORDS_PER_A4) * 10) / 10;
}

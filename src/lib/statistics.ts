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

// ── What the statistics show: the letter, never its ± ─────────────────────
// The form grades in fifteen steps (A+ … E−); the + and − are the coach's
// internal nuance. Everything the statistics show — the page, its charts, the
// deck, the coachee export — speaks in the five letters, and a C− or a C+
// COUNTS as a C: the server folds each rating into its letter before it
// averages (server/statistics.ts), and every label goes through here.
export const STAT_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;
export type StatLetter = typeof STAT_LETTERS[number];
/** The centre of each letter on the 1–15 scale: E = 2 … A = 14. */
export const LETTER_SCORE: Record<StatLetter, number> = { A: 14, B: 11, C: 8, D: 5, E: 2 };

/** The letter a score or an average falls in — A to E, no ±. The bands are
 *  halfway between the letters' centres: 9.4 → C, 9.5 → B, 9 (C+) → C. */
export function scoreToLetter(score: number): StatLetter {
  const s = Math.min(15, Math.max(1, score));
  return s >= 12.5 ? 'A' : s >= 9.5 ? 'B' : s >= 6.5 ? 'C' : s >= 3.5 ? 'D' : 'E';
}

/** A single rating folded into its letter: C− and C+ score as C (8). */
export const letterScore = (score: number): number => LETTER_SCORE[scoreToLetter(score)];

/** A histogram in the five letters, whatever it was counted in — an API that
 *  still sends A+ … E− is folded here, so nothing downstream sees a ±. */
export function foldHistogram(h: Dist): Record<StatLetter, number> {
  const out: Record<StatLetter, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const [grade, n] of Object.entries(h)) {
    const letter = grade.trim().charAt(0).toUpperCase() as StatLetter;
    if (letter in out) out[letter] += n;
  }
  return out;
}

/** A grade aggregate: how many observations fed it, how many rated criteria
 *  they held, and the sum of their scores. Kept as sums so sections can be
 *  built from their criteria and seasons compared without re-reading rows. */
export type GradeAgg = { obs: number; items: number; sum: number };
export const emptyGrade = (): GradeAgg => ({ obs: 0, items: 0, sum: 0 });

/** Below this many observations an average is THIN: still shown — one visit's
 *  grades are real grades — but drawn hollow and labelled with its n, so one
 *  evening is never mistaken for a pattern. */
export const MIN_OBS_FOR_AVG = 3;
export const isThin = (n: number): boolean => n < MIN_OBS_FOR_AVG;

export function gradeAvg(g: GradeAgg | undefined, minObs = 1): number | null {
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
  /** Answered criteria (grades + N/A) and the criteria the forms offered — completeness. */
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
  /** Absent from an API older than the trend. */
  trend?: StatTrend;
};

// ── Trend ────────────────────────────────────────────────────────────────────
// A coachee seen more than once this season: their first observation's
// average grade against their latest one. Only the two ends count, so a
// coachee with two visits and one with three read the same way — did the
// grade go up, stay, or go down since the first visit. Less than half a step
// on the 1–15 scale (a third of a letter) is "the same".
export const TREND_SAME_BAND = 0.5;
export type TrendAgg = {
  /** Coachees with two or more graded observations. */
  coachees: number;
  improved: number;
  same: number;
  worse: number;
  /** Sum of (latest − first) over those coachees, in scale points. */
  deltaSum: number;
};
export type TrendRow = TrendAgg & { key: string };
export type StatTrend = TrendAgg & {
  /** By the Niveau of the coachee's latest observation. */
  byLevel: TrendRow[];
  /** By every group the coachee's latest observation carried. */
  byGroup: TrendRow[];
};
export const emptyTrend = (): TrendAgg => ({ coachees: 0, improved: 0, same: 0, worse: 0, deltaSum: 0 });
export function trendOf(delta: number): 'improved' | 'same' | 'worse' {
  return delta >= TREND_SAME_BAND ? 'improved' : delta <= -TREND_SAME_BAND ? 'worse' : 'same';
}
export const trendAvgDelta = (t: TrendAgg | undefined): number | null =>
  t && t.coachees > 0 ? Math.round((t.deltaSum / t.coachees) * 10) / 10 : null;

// ── Breakdowns ───────────────────────────────────────────────────────────────
/** One slice of the season (a Niveau, a Stufe, a group), computed with the
 *  same filters plus that slice's. Sent with `breakdown=1`. */
export type StatSlice = { key: string; stats: SeasonStatisticsCore };
export type StatBreakdowns = { level: StatSlice[]; stufe: StatSlice[]; group: StatSlice[] };

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

export type StatisticsResponse = { stats: SeasonStatistics; options: StatOptions; breakdowns?: StatBreakdowns };

// ── Per-coachee summary (Admin → Coachees → export) ──────────────────────────
export type CoacheeSummary = {
  coacheeId: string;
  observations: number;
  obs1SR: number;
  obs2SR: number;
  /** Average grade over every rated criterion, and per role. */
  grade: GradeAgg;
  grade1SR: GradeAgg;
  grade2SR: GradeAgg;
  firstDate: string;
  lastDate: string;
  /** First and latest observation's own average; delta and its reading when there are two. */
  firstAvg: number | null;
  lastAvg: number | null;
  trend: 'improved' | 'same' | 'worse' | '';
  /** Einstufung counts over the season, and the latest one. */
  einstufungUp: number;
  einstufungSame: number;
  einstufungDown: number;
  lastEinstufung: string;
  lastMotivation: string;
  lastSpielniveau: string;
  lastSecondBesuch: string;
  lastSecondBesuchRole: string;
  lastSrZiel: string;
  /** Ticked on any observation this season. */
  wantsPromotion: boolean;
  wantsCandidate: boolean;
  rcs: string[];
};
export type CoacheeSummaryResponse = { season: number; summaries: CoacheeSummary[] };

// ── Derived readings ─────────────────────────────────────────────────────────
export const pct = (part: number, whole: number): number | null =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

export function estimatedHours(sets: number): number {
  return Math.round((sets * MINUTES_PER_SET) / 60);
}

export function a4Pages(words: number): number {
  return Math.round((words / WORDS_PER_A4) * 10) / 10;
}

// ── RC names ────────────────────────────────────────────────────────────────
// The statistics name coaches by first name — "Anna", not "Anna Amsler". Two
// coaches sharing one get their last name's initial ("Luca C." / "Luca M."),
// and only a pair that still collides keeps the full name. The server labels
// rows with the full name; this relabels a response on the client from the
// RC records, which carry the first name as its own field (splitting the full
// name at the first space makes "Thanh Ut Nguyen" a "Thanh"). A name with no
// record behind it — an older observation filed under a spelling nobody has
// any more — falls back to that split.
export type RcNameRecord = { id: string; first_name?: string; last_name?: string };

const normName = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

export function rcFirstNamer(people: RcNameRecord[], extraFullNames: string[] = []): (key: { id?: string; name: string }) => string {
  type Entry = { first: string; last: string; full: string };
  const byId = new Map<string, Entry>();
  const byFull = new Map<string, Entry>();
  const entries: Entry[] = [];
  const add = (e: Entry, id?: string) => {
    entries.push(e);
    if (id) byId.set(id, e);
    if (e.full && !byFull.has(normName(e.full))) byFull.set(normName(e.full), e); // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
  };
  for (const p of people) {
    const first = (p.first_name ?? '').trim();
    const last = (p.last_name ?? '').trim();
    if (!first && !last) continue;
    add({ first: first || last, last: first ? last : '', full: `${first} ${last}`.trim() }, p.id);
  }
  for (const raw of extraFullNames) {
    const full = raw.trim().replace(/\s+/g, ' ');
    if (!full || byFull.has(normName(full))) continue; // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
    const [first, ...rest] = full.split(' ');
    add({ first, last: rest.join(' '), full });
  }
  const firstCount = new Map<string, number>();
  for (const e of entries) firstCount.set(normName(e.first), (firstCount.get(normName(e.first)) ?? 0) + 1); // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
  const initialOf = (e: Entry) => `${e.first} ${e.last ? `${e.last[0]}.` : ''}`.trim();
  const initialCount = new Map<string, number>();
  for (const e of entries) {
    if ((firstCount.get(normName(e.first)) ?? 0) > 1) initialCount.set(normName(initialOf(e)), (initialCount.get(normName(initialOf(e))) ?? 0) + 1); // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
  }
  const display = (e: Entry): string => {
    if ((firstCount.get(normName(e.first)) ?? 0) <= 1) return e.first; // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
    return (initialCount.get(normName(initialOf(e))) ?? 0) <= 1 ? initialOf(e) : e.full; // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
  };
  return ({ id, name }) => {
    const e = (id ? byId.get(id) : undefined) ?? byFull.get(normName(name)); // identity:display — picks the first name a label shows; ids are tried first and nothing is merged
    if (e) return display(e);
    return name.trim().split(/\s+/)[0] || name;
  };
}

/** The response with every coach named by first name (rows, top writer, the
 *  RC filter). Keys and ids are untouched, so filters and exports still work. */
export function withRcFirstNames(resp: StatisticsResponse, people: RcNameRecord[]): StatisticsResponse {
  const cores = [resp.stats, resp.stats.previous].filter((c): c is SeasonStatisticsCore => !!c);
  const fullNames = [
    ...resp.options.rcs.map((r) => r.name),
    ...cores.flatMap((c) => [...c.byRc.map((r) => r.label), ...(c.fun.topWriter ? [c.fun.topWriter.name] : [])]),
  ];
  const nameOf = rcFirstNamer(people, fullNames);
  const relabel = <C extends SeasonStatisticsCore>(c: C): C => ({
    ...c,
    byRc: c.byRc.map((r) => ({ ...r, label: nameOf({ id: r.key.startsWith('name:') ? undefined : r.key, name: r.label }) })),
    fun: { ...c.fun, topWriter: c.fun.topWriter ? { ...c.fun.topWriter, name: nameOf({ name: c.fun.topWriter.name }) } : null },
  });
  return {
    ...resp,
    stats: { ...relabel(resp.stats), previous: resp.stats.previous ? relabel(resp.stats.previous) : null },
    options: {
      ...resp.options,
      rcs: resp.options.rcs
        .map((r) => ({ id: r.id, name: nameOf({ id: r.id, name: r.name }) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'de')),
    },
  };
}

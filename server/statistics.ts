// The season statistics — Admin → Statistik and the deck it exports.
//
// Pure, like expenses.ts: index.ts reads the season's feedbacks, games,
// coachees and coaches out of PocketBase, turns each feedback into a
// StatObservation with observationFromFeedback(), and hands the lot to
// computeStatistics(). Nothing here touches a database, so the counting rules
// are tested on fixtures (e2e/statistics-rules.spec.ts).
//
// The rules the numbers encode:
//  - a season is the GAME's date (Sept–Apr, named by its starting year), as in
//    the Übersicht — never the date the form was filed;
//  - a test game (no coachee) is not an observation;
//  - sets and points are counted once per distinct game, however many
//    referees were assessed on it — the same rule the Spesenabrechnung uses;
//  - the level and group are what the form recorded at the time of the visit,
//    the roster only fills in what the form left empty;
//  - the coach's remarks are counted here and only the counts leave.

import { zonedParts, dayKey } from '../src/lib/appTime.ts';
import { parseLeague } from '../src/lib/niveauTargets.ts';
import { parseResult, isSetComplete } from '../src/lib/matchResult.ts';
import { splitCoacheeGroups } from '../src/lib/coacheeGroup.ts';
import { richToPlain } from '../src/lib/richText.ts';
import {
  countChars, countWords, emptyGrade, GRADE_SCALE, gradeToScore, mergeGrade, NORMAL_SCORE,
  type CriterionAgg, type Dist, type GradeAgg, type RcBucket, type SeasonStatisticsCore,
  type SectionAgg, type StatBucket, type StatFilters, type StatFun, type StatOptions,
  type StatRole, type StatTotals,
} from '../src/lib/statistics.ts';

export type StatObservation = {
  id: string;
  gameId: string;
  /** VolleyManager's number for the game — how a human names it. Optional:
   *  the fixtures the rules spec builds by hand predate it. */
  matchNo?: string;
  /** Filed on a manual (test) fixture. A manual game is exempt from the
   *  season window, so the observation counts in every season; the mark is
   *  carried so a reader can tell, and nothing here excludes it — whether a
   *  Testspiel counts is the commission's call, not the projection's. */
  isManual?: boolean;
  /** The stored game date — ISO or PocketBase's "YYYY-MM-DD HH:mm:ss.sssZ". */
  gameDate: string;
  league: string;
  location: string;
  homeTeam: string;
  awayTeam: string;
  /** The match result, either of the two shapes parseResult reads. */
  result: string;
  role: StatRole;
  lang: string;
  rcId: string;
  rcName: string;
  coacheeId: string;
  coacheeName: string;
  /** "N3-2" as filed, "N3" when the Stufe is unknown, "" when nothing is. */
  level: string;
  groups: string[];
  /** Every rated criterion: its id, the index of the form section it sits in, its score. */
  ratings: Array<{ id: string; section: number; score: number }>;
  /** Criteria the form offered — the denominator of completeness. */
  offered: number;
  /** Criteria the coach answered: every grade plus every N/A. N/A says the
   *  thing never came up (no sanction to give), so it completes the form
   *  without being a grade — completeness counts it, the averages do not. */
  answered: number;
  einstufung: string;
  motivation: string;
  spielniveau: string;
  secondBesuch: string;
  srZiel: string;
  words: number;
  chars: number;
  filled: { highlights: boolean; improvements: boolean; goals: boolean };
  signed: boolean;
  rcSigned: boolean;
  submittedAt: string;
};

export type StatRcInput = { id: string; name: string; goal: number; planned: number; outstanding: number };
export type StatCoacheeInput = { id: string; name: string; level: string; groups: string[]; active: boolean };

export type StatisticsInput = {
  season: number;
  /** Already cut to the season. */
  observations: StatObservation[];
  rcs: StatRcInput[];
  roster: StatCoacheeInput[];
  filters: StatFilters;
  now: Date;
};

// ── From a feedback record to an observation ─────────────────────────────────

type Plain = Record<string, unknown>;
const text = (v: unknown): string => (v == null ? '' : String(v)).trim();

/** "N3-2" / "N3 - 2" / "n3" → "N3-2" / "N3"; anything that is not a Niveau → "". */
export function normalizeLevel(raw: string): string {
  const compact = text(raw).toUpperCase().replace(/\s+/g, '');
  const m = /^N([1-4])(?:-([1-3]))?/.exec(compact);
  if (!m) return '';
  return m[2] ? `N${m[1]}-${m[2]}` : `N${m[1]}`;
}

export const niveauOf = (level: string): string => level.split('-')[0];

/** The observation a feedback record describes, or null when it is not one:
 *  no game, or no coachee (a test game filed against the register). */
export function observationFromFeedback(args: {
  feedback: Plain;
  game: Plain | undefined;
  coachee: Plain | undefined;
  rc: { id: string; name: string } | null;
  /** The manual-game set, when the caller has one. */
  manualIds?: Set<string>;
}): StatObservation | null {
  const { feedback, game, coachee, rc } = args;
  if (!game || !coachee) return null;
  const json = (feedback.feedback_json && typeof feedback.feedback_json === 'object' ? feedback.feedback_json : {}) as Plain;
  const meta = (json.meta && typeof json.meta === 'object' ? json.meta : {}) as Plain;
  const results = (json.results && typeof json.results === 'object' ? json.results : {}) as Plain;
  const sections = Array.isArray(json.sections) ? json.sections as Array<Plain> : [];

  const ratings: StatObservation['ratings'] = [];
  let offered = 0;
  let answered = 0;
  sections.forEach((section, index) => {
    const items = Array.isArray(section.items) ? section.items as Array<Plain> : [];
    for (const item of items) {
      offered += 1;
      const score = gradeToScore(text(item.rating));
      if (score !== null || text(item.rating).trim().toUpperCase() === 'N/A') answered += 1;
      if (score === null) continue;
      ratings.push({ id: text(item.id), section: index, score });
    }
  });

  const roleText = text(feedback.role_assessed) || text(json.role);
  const role: StatRole = /2/.test(roleText) ? '2SR' : '1SR';

  // As filed first; the roster row fills what the form left empty.
  const rosterStage = text(coachee.stage);
  const rosterLevel = text(coachee.referee_level)
    ? (/^\d$/.test(rosterStage) ? `${text(coachee.referee_level)}-${rosterStage}` : text(coachee.referee_level))
    : '';
  const level = normalizeLevel(text(meta.srNiveau)) || normalizeLevel(rosterLevel);
  const groups = splitCoacheeGroups(text(meta.gruppe) || text(coachee.groups));

  const plain = (v: unknown) => richToPlain(text(v));
  const blocks = {
    bemerkungen: plain(results.bemerkungen),
    highlights: plain(results.highlights),
    improvements: plain(results.improvements),
    goals: plain(results.goals),
  };
  const all = Object.values(blocks).join('\n');

  return {
    id: text(feedback.id),
    gameId: text(game.id),
    matchNo: text(game.match_no) || text(meta.spielNr),
    isManual: Boolean(args.manualIds?.has(text(game.id))),
    gameDate: text(game.match_date) || text(meta.datum),
    league: text(game.league) || text(meta.liga),
    location: text(game.location) || text(meta.ort),
    homeTeam: text(game.home_team),
    awayTeam: text(game.away_team),
    result: text(meta.ergebnis) || text(game.game_result),
    role,
    lang: text(json.lang).toUpperCase() === 'EN' ? 'EN' : 'DE',
    rcId: rc?.id ?? '',
    rcName: rc?.name ?? (text(feedback.rc_name) || text(meta.rc)),
    coacheeId: text(coachee.id),
    coacheeName: text(coachee.full_name) || text(meta.srName),
    level,
    groups,
    ratings,
    offered,
    answered,
    einstufung: text(results.einstufung),
    motivation: text(results.motivation),
    spielniveau: text(results.spielniveau),
    secondBesuch: text(results.secondBesuch).toUpperCase(),
    srZiel: text(results.srZiel),
    words: countWords(all),
    chars: countChars(all),
    filled: {
      highlights: blocks.highlights.length > 0,
      improvements: blocks.improvements.length > 0,
      goals: blocks.goals.length > 0,
    },
    signed: text(json.signature).length > 0,
    rcSigned: text(json.rcSignature).length > 0,
    submittedAt: text(feedback.submitted_at),
  };
}

// ── The games behind the observations ────────────────────────────────────────

type GameFacts = { sets: number; points: number; decider: boolean };

/** Sets and points of one result string; a result nobody typed is 0 / 0. */
export function gameFacts(result: string): GameFacts {
  const parsed = parseResult(result);
  const complete = parsed.sets.filter(isSetComplete);
  const points = complete.reduce((acc, s) => acc + Number(s.h) + Number(s.a), 0);
  // A fifth set is always a decider; a third one is when it was played to 15
  // (the best-of-three the junior competitions play).
  const third = complete[2];
  const decider = complete.length === 5
    || (complete.length === 3 && !!third && Math.max(Number(third.h), Number(third.a)) < 25);
  return { sets: complete.length, points, decider };
}

// ── Aggregation ──────────────────────────────────────────────────────────────

class Acc {
  observations = 0;
  coachees = new Set<string>();
  games = new Map<string, GameFacts>();
  words = 0;
  roles: Record<StatRole, number> = { '1SR': 0, '2SR': 0 };
  grade: GradeAgg = emptyGrade();
  add(o: StatObservation) {
    this.observations += 1;
    if (o.coacheeId) this.coachees.add(o.coacheeId);
    if (o.gameId && !this.games.has(o.gameId)) this.games.set(o.gameId, gameFacts(o.result));
    this.words += o.words;
    this.roles[o.role] += 1;
    this.grade = mergeGrade(this.grade, {
      obs: 1, items: o.ratings.length, sum: o.ratings.reduce((acc, r) => acc + r.score, 0),
    });
  }
  bucket(key: string, label: string): StatBucket {
    let sets = 0;
    let points = 0;
    for (const g of this.games.values()) { sets += g.sets; points += g.points; }
    return {
      key, label,
      observations: this.observations,
      coachees: this.coachees.size,
      games: this.games.size,
      sets, points,
      words: this.words,
      roles: { ...this.roles },
      grade: { ...this.grade },
    };
  }
}

function bucketize(
  observations: StatObservation[],
  keysOf: (o: StatObservation) => string[],
  labelOf: (key: string) => string,
  order?: (a: StatBucket, b: StatBucket) => number,
  seed: string[] = [],
): StatBucket[] {
  const accs = new Map<string, Acc>();
  for (const key of seed) accs.set(key, new Acc());
  for (const o of observations) {
    for (const key of keysOf(o)) {
      if (!accs.has(key)) accs.set(key, new Acc());
      accs.get(key)!.add(o);
    }
  }
  const out = [...accs.entries()].map(([key, acc]) => acc.bucket(key, labelOf(key)));
  return order ? out.sort(order) : out;
}

const byCount = (a: StatBucket, b: StatBucket) => b.observations - a.observations || a.label.localeCompare(b.label, 'de');
const byKey = (a: StatBucket, b: StatBucket) => a.key.localeCompare(b.key);
const inOrder = (list: string[]) => (a: StatBucket, b: StatBucket) => {
  const ia = list.indexOf(a.key); const ib = list.indexOf(b.key);
  return (ia < 0 ? list.length : ia) - (ib < 0 ? list.length : ib) || a.key.localeCompare(b.key);
};

const STUFE_ORDER = ['N1', 'N2-1', 'N2-2', 'N3-1', 'N3-2', 'N3-3', 'N4-1', 'N4-2', 'N4-3'];
const LEVEL_ORDER = ['N1', 'N2', 'N3', 'N4'];
const DIVISION_ORDER = ['NL', '1', '2', '3', '4', '5', ''];
const CATEGORY_ORDER = ['H', 'D', ''];
/** Men or women for the Statistik. A U23 game is a men's or a women's game
 *  like any other — the prefix says which (HU23/MU23 men, DU23 women) — so it
 *  is counted under its gender, not as a third kind. A bare "U23" that names
 *  no gender falls under Other. */
function genderOf(league: string): string {
  const p = parseLeague(league);
  if (p.category === 'J') return p.juniorColumn === 'JH' ? 'H' : p.juniorColumn === 'JD' ? 'D' : '';
  return p.category;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/** "YYYY-MM" of the Zürich day the game was played. */
function monthKey(date: string): string {
  const p = zonedParts(date);
  return p.valid ? `${p.year}-${pad2(p.month)}` : '';
}

/** 1 = Monday … 7 = Sunday, of the Zürich day. */
function weekdayOf(date: string): string {
  const p = zonedParts(date);
  if (!p.valid) return '';
  const day = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return String(day === 0 ? 7 : day);
}

function hourOf(date: string): string {
  const p = zonedParts(date);
  return p.valid && p.timed ? pad2(p.hour) : '';
}

/** Whole Zürich days between the game and the filing; null when either is undated. */
export function filingDelayDays(gameDate: string, submittedAt: string): number | null {
  const g = dayKey(gameDate);
  const s = dayKey(submittedAt);
  if (!g || !s) return null;
  const at = (k: string) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.max(0, Math.round((at(s) - at(g)) / 86_400_000));
}

function applyFilters(observations: StatObservation[], filters: StatFilters): StatObservation[] {
  const group = text(filters.group).toLowerCase();
  const level = normalizeLevel(text(filters.level));
  return observations.filter((o) => {
    if (filters.rc && o.rcId !== filters.rc) return false;
    if (filters.role && o.role !== filters.role) return false;
    if (group && !o.groups.some((g) => g.toLowerCase() === group)) return false; // identity:display — a group label filter, not a name
    if (level) {
      if (level.includes('-') ? o.level !== level : niveauOf(o.level) !== level) return false;
    }
    return true;
  });
}

function rosterFilter(roster: StatCoacheeInput[], filters: StatFilters): StatCoacheeInput[] {
  const group = text(filters.group).toLowerCase();
  const level = normalizeLevel(text(filters.level));
  return roster.filter((c) => {
    if (!c.active) return false;
    if (group && !c.groups.some((g) => g.toLowerCase() === group)) return false; // identity:display — a group label filter, not a name
    if (level) {
      const own = normalizeLevel(c.level);
      if (level.includes('-') ? own !== level : niveauOf(own) !== level) return false;
    }
    return true;
  });
}

function top<T extends { count: number }>(map: Map<string, number>, make: (name: string, count: number) => T): T | null {
  let best: T | null = null;
  for (const [name, count] of map) {
    if (!name) continue;
    if (!best || count > best.count) best = make(name, count);
  }
  return best;
}

export function computeStatistics(input: StatisticsInput): SeasonStatisticsCore {
  const { season, filters, now } = input;
  const observations = applyFilters(input.observations, filters);
  const roster = rosterFilter(input.roster, filters);
  const rcs = filters.rc ? input.rcs.filter((r) => r.id === filters.rc) : input.rcs;

  // ── totals ──
  const all = new Acc();
  for (const o of observations) all.add(o);
  const whole = all.bucket('all', 'all');

  const halls = new Set<string>();
  const teams = new Set<string>();
  const gameLabel = new Map<string, string>();
  for (const o of observations) {
    if (o.location) halls.add(o.location.toLowerCase());
    if (o.homeTeam) teams.add(o.homeTeam.toLowerCase());
    if (o.awayTeam) teams.add(o.awayTeam.toLowerCase());
    if (!gameLabel.has(o.gameId)) {
      const teams = [o.homeTeam, o.awayTeam].filter(Boolean).join(' – ') || o.league;
      gameLabel.set(o.gameId, o.matchNo ? `#${o.matchNo} · ${teams}` : teams);
    }
  }
  let deciders = 0;
  let longestGame: StatTotals['longestGame'] = null;
  for (const [gameId, facts] of all.games) {
    if (facts.decider) deciders += 1;
    if (facts.points > 0 && (!longestGame || facts.points > longestGame.points)) {
      longestGame = { label: gameLabel.get(gameId) ?? '', sets: facts.sets, points: facts.points };
    }
  }

  const histogram: Dist = {};
  let ratingsC = 0;
  let ratingsBPlus = 0;
  let ratingsAll = 0;
  let ratedItems = 0;
  let offeredItems = 0;
  const criteriaAcc = new Map<string, CriterionAgg>();
  const sectionAcc = new Map<string, SectionAgg>();
  // The exact rating back from its score — the histogram counts what was given.
  const scoreLetter = (score: number) => Object.entries(GRADE_SCALE).find(([, s]) => s === score)?.[0] ?? '';
  for (const o of observations) {
    offeredItems += o.offered;
    ratedItems += o.answered;
    const seenSections = new Set<number>();
    for (const r of o.ratings) {
      ratingsAll += 1;
      if (r.score === NORMAL_SCORE) ratingsC += 1;
      if (r.score >= 10) ratingsBPlus += 1;
      const letter = scoreLetter(r.score);
      if (letter) histogram[letter] = (histogram[letter] ?? 0) + 1;

      const ck = `${o.role}|${r.id || `${r.section}`}`;
      const c = criteriaAcc.get(ck) ?? { role: o.role, section: r.section, id: r.id, grade: emptyGrade() };
      c.grade = mergeGrade(c.grade, { obs: 1, items: 1, sum: r.score });
      criteriaAcc.set(ck, c);

      const sk = `${o.role}|${r.section}`;
      const s = sectionAcc.get(sk) ?? { role: o.role, section: r.section, grade: emptyGrade() };
      s.grade = mergeGrade(s.grade, { obs: seenSections.has(r.section) ? 0 : 1, items: 1, sum: r.score });
      seenSections.add(r.section);
      sectionAcc.set(sk, s);
    }
  }

  const wordsList = observations.map((o) => o.words);
  const delays: number[] = [];
  let filedSameDay = 0;
  let filedLate = 0;
  for (const o of observations) {
    const d = filingDelayDays(o.gameDate, o.submittedAt);
    if (d === null) continue;
    delays.push(d);
    if (d === 0) filedSameDay += 1;
    if (d >= 8) filedLate += 1;
  }

  const activeRcIds = new Set(observations.map((o) => o.rcId).filter(Boolean));
  const totals: StatTotals = {
    observations: whole.observations,
    games: whole.games,
    coachees: whole.coachees,
    roster: roster.length,
    rcsActive: rcs.filter((r) => activeRcIds.has(r.id)).length,
    rcsTotal: rcs.length,
    goal: rcs.reduce((acc, r) => acc + r.goal, 0),
    sets: whole.sets,
    points: whole.points,
    deciders,
    longestGame,
    halls: halls.size,
    teams: teams.size,
    words: whole.words,
    chars: observations.reduce((acc, o) => acc + o.chars, 0),
    wordsMedian: median(wordsList),
    longestRemark: wordsList.reduce((acc, w) => Math.max(acc, w), 0),
    filledHighlights: observations.filter((o) => o.filled.highlights).length,
    filledImprovements: observations.filter((o) => o.filled.improvements).length,
    filledGoals: observations.filter((o) => o.filled.goals).length,
    ratedItems,
    offeredItems,
    grade: whole.grade,
    ratingsC,
    ratingsBPlus,
    ratingsAll,
    signedReferee: observations.filter((o) => o.signed).length,
    signedRc: observations.filter((o) => o.rcSigned).length,
    langDE: observations.filter((o) => o.lang !== 'EN').length,
    langEN: observations.filter((o) => o.lang === 'EN').length,
    filingMedianDays: median(delays),
    filedSameDay,
    filedLate,
  };

  // ── breakdowns ──
  const seasonMonths: string[] = [];
  for (let m = 9; m <= 12; m += 1) seasonMonths.push(`${season}-${pad2(m)}`);
  for (let m = 1; m <= 4; m += 1) seasonMonths.push(`${season + 1}-${pad2(m)}`);

  const rcById = new Map(rcs.map((r) => [r.id, r]));
  const rcNameOf = new Map<string, string>();
  for (const o of observations) if (o.rcId && !rcNameOf.has(o.rcId)) rcNameOf.set(o.rcId, o.rcName);
  const byRc: RcBucket[] = bucketize(
    observations,
    (o) => [o.rcId || `name:${o.rcName}`],
    (key) => rcById.get(key)?.name ?? rcNameOf.get(key) ?? key.replace(/^name:/, ''),
    byCount,
    rcs.map((r) => r.id),
  ).map((b) => {
    const rc = rcById.get(b.key);
    return { ...b, goal: rc?.goal ?? 0, planned: rc?.planned ?? 0, outstanding: rc?.outstanding ?? 0 };
  });

  const criteria = [...criteriaAcc.values()].sort((a, b) => a.role.localeCompare(b.role) || a.section - b.section || a.id.localeCompare(b.id));
  const sections = [...sectionAcc.values()].sort((a, b) => a.role.localeCompare(b.role) || a.section - b.section);

  // ── coverage ──
  const visitsByCoachee = new Map<string, number>();
  for (const c of roster) visitsByCoachee.set(c.id, 0);
  for (const o of observations) if (o.coacheeId) visitsByCoachee.set(o.coacheeId, (visitsByCoachee.get(o.coacheeId) ?? 0) + 1);
  const coacheeVisits: Dist = { '0': 0, '1': 0, '2': 0, '3+': 0 };
  for (const n of visitsByCoachee.values()) coacheeVisits[n >= 3 ? '3+' : String(n)] += 1;

  // ── outcomes ──
  const dist = (pick: (o: StatObservation) => string): Dist => {
    const out: Dist = {};
    for (const o of observations) { const k = pick(o); if (k) out[k] = (out[k] ?? 0) + 1; }
    return out;
  };

  // ── fun ──
  const dayCounts = new Map<string, number>();
  const hallCounts = new Map<string, number>();
  const coacheeCounts = new Map<string, number>();
  const writerWords = new Map<string, number>();
  let first: string | null = null;
  let last: string | null = null;
  for (const o of observations) {
    const day = dayKey(o.gameDate);
    if (day) {
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
      if (!first || day < first) first = day;
      if (!last || day > last) last = day;
    }
    if (o.location) hallCounts.set(o.location, (hallCounts.get(o.location) ?? 0) + 1);
    if (o.coacheeName) coacheeCounts.set(o.coacheeName, (coacheeCounts.get(o.coacheeName) ?? 0) + 1);
    if (o.rcName) writerWords.set(o.rcName, (writerWords.get(o.rcName) ?? 0) + o.words);
  }
  const topWriterEntry = top(writerWords, (name, count) => ({ name, count }));
  const fun: StatFun = {
    busiestDay: top(dayCounts, (key, count) => ({ key, count })),
    topHall: top(hallCounts, (name, count) => ({ name, count })),
    topCoachee: top(coacheeCounts, (name, count) => ({ name, count })),
    topWriter: topWriterEntry ? { name: topWriterEntry.name, words: topWriterEntry.count } : null,
    first,
    last,
  };

  return {
    season,
    generatedAt: now.toISOString(),
    filters,
    totals,
    byRole: bucketize(observations, (o) => [o.role], (k) => k, inOrder(['1SR', '2SR']), ['1SR', '2SR']),
    byMonth: bucketize(observations, (o) => [monthKey(o.gameDate)].filter(Boolean), (k) => k, byKey, seasonMonths),
    byRc,
    byGroup: bucketize(observations, (o) => (o.groups.length ? o.groups : ['']), (k) => k, byCount),
    byLevel: bucketize(observations, (o) => [niveauOf(o.level)], (k) => k, inOrder(LEVEL_ORDER)),
    byStufe: bucketize(observations, (o) => [o.level], (k) => k, inOrder(STUFE_ORDER)),
    byLeague: bucketize(observations, (o) => [o.league], (k) => k, byCount),
    byCategory: bucketize(observations, (o) => [genderOf(o.league)], (k) => k, inOrder(CATEGORY_ORDER)),
    byDivision: bucketize(observations, (o) => [parseLeague(o.league).division], (k) => k, inOrder(DIVISION_ORDER)),
    byWeekday: bucketize(observations, (o) => [weekdayOf(o.gameDate)].filter(Boolean), (k) => k, byKey),
    byHour: bucketize(observations, (o) => [hourOf(o.gameDate)].filter(Boolean), (k) => k, byKey),
    histogram,
    sections,
    criteria,
    coacheeVisits,
    outcomes: {
      einstufung: dist((o) => o.einstufung),
      motivation: dist((o) => o.motivation),
      spielniveau: dist((o) => o.spielniveau),
      secondBesuch: dist((o) => o.secondBesuch),
      srZiel: dist((o) => o.srZiel),
    },
    fun,
  };
}

/** What the filter row can offer: read off the UNFILTERED season, so a filter
 *  never hides the other values it could be changed to. */
export function statOptions(args: {
  observations: StatObservation[];
  rcs: StatRcInput[];
  roster: StatCoacheeInput[];
  seasons: number[];
}): StatOptions {
  const groups = new Set<string>();
  const levels = new Set<string>();
  for (const o of args.observations) {
    for (const g of o.groups) groups.add(g);
    if (o.level) { levels.add(niveauOf(o.level)); levels.add(o.level); }
  }
  for (const c of args.roster) {
    if (!c.active) continue;
    for (const g of c.groups) groups.add(g);
    const lv = normalizeLevel(c.level);
    if (lv) { levels.add(niveauOf(lv)); levels.add(lv); }
  }
  const levelOrder = ['N1', 'N2', 'N2-1', 'N2-2', 'N3', 'N3-1', 'N3-2', 'N3-3', 'N4', 'N4-1', 'N4-2', 'N4-3'];
  return {
    rcs: [...args.rcs].sort((a, b) => a.name.localeCompare(b.name, 'de')).map((r) => ({ id: r.id, name: r.name })),
    groups: [...groups].sort((a, b) => a.localeCompare(b, 'de')),
    levels: [...levels].sort((a, b) => levelOrder.indexOf(a) - levelOrder.indexOf(b)),
    seasons: [...new Set(args.seasons)].sort((a, b) => b - a),
  };
}

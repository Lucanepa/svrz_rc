import { test, expect } from '@playwright/test';
import {
  computeStatistics, observationFromFeedback, gameFacts, filingDelayDays, normalizeLevel, statOptions,
  computeTrend, coacheeSummaries, computeBreakdowns,
  type StatObservation, type StatRcInput, type StatCoacheeInput,
} from '../server/statistics';
import { foldHistogram, gradeAvg, isThin, letterScore, scoreToLetter, countWords, STAT_LETTERS } from '../src/lib/statistics';

// The counting rules of Admin → Statistik on their own, without a database:
// what is an observation, how a game with two referees counts, where the
// season boundary falls, how grades average, what a word is.

const RC_A = { id: 'rc-a', name: 'Anna Coach' };
const RC_B = { id: 'rc-b', name: 'Beat Coach' };

function feedback(over: Record<string, unknown> = {}) {
  return {
    id: 'fb-1', rc_id: RC_A.id, rc_name: RC_A.name, role_assessed: '1. SR',
    submitted_at: '2025-10-03T20:15:00Z',
    feedback_json: {
      role: '1. SR', lang: 'DE',
      meta: { srNiveau: 'N3-2', gruppe: 'Beförderung?', ergebnis: '3:1 | 25:20, 22:25, 25:18, 25:22', datum: '2025-10-03' },
      sections: [
        { title: 'Spielvorbereitung', items: [
          { id: '1sr-prep-1', label: 'Pünktlichkeit', rating: 'B' },
          { id: '1sr-prep-2', label: 'Kontrollen', rating: 'C' },
          { id: '1sr-prep-3', label: 'Absprache', rating: '' },
        ] },
        { title: 'Spielleitung', items: [
          { id: '1sr-lead-1', label: 'Pfiffe', rating: 'A-' },
        ] },
      ],
      results: {
        motivation: 'up', einstufung: 'check', spielniveau: 'normal', secondBesuch: 'N', srZiel: '2L',
        bemerkungen: 'Sehr <b>gute</b> Leistung, ruhig und klar.', highlights: 'Netzfehler sicher.', improvements: '', goals: '',
      },
      signature: 'data:image/png;base64,xx', rcSignature: '',
    },
    ...over,
  };
}
const GAME = { id: 'g-1', match_date: '2025-10-03 18:30:00.000Z', league: '3L ♂ A', location: 'Halle Nord', home_team: 'VBC Nord', away_team: 'VBC Süd' };
const COACHEE = { id: 'c-1', full_name: 'Zoe Zwei', referee_level: 'N3', stage: '1', groups: 'Referee Coaching' };

test('a feedback becomes an observation: grades scored, level and group as filed, words counted without markup', () => {
  const o = observationFromFeedback({ feedback: feedback(), game: GAME, coachee: COACHEE, rc: RC_A })!;
  expect(o).not.toBeNull();
  expect(o.role).toBe('1SR');
  expect(o.level).toBe('N3-2');           // the form's own copy, not the roster's N3-1
  expect(o.groups).toEqual(['Beförderung?']);
  // Each rating folded into its letter: the A− scores as an A (14).
  expect(o.ratings.map((r) => [r.id, r.section, r.score])).toEqual([['1sr-prep-1', 0, 11], ['1sr-prep-2', 0, 8], ['1sr-lead-1', 1, 14]]);
  expect(o.offered).toBe(4);
  expect(o.answered).toBe(3);             // the blank "Absprache" is the one unanswered
  expect(o.words).toBe(8);                 // "Sehr gute Leistung, ruhig und klar." + "Netzfehler sicher."
  expect(o.filled).toEqual({ highlights: true, improvements: false, goals: false });
  expect(o.signed).toBe(true);
  expect(o.rcSigned).toBe(false);
  expect(o.secondBesuch).toBe('N');
});

test('N/A answers a criterion without grading it: completeness counts it, the grades do not', () => {
  const base = feedback().feedback_json as { sections: Array<{ items: Array<Record<string, string>> }> };
  const sections = base.sections.map((sec) => ({ ...sec, items: sec.items.map((it) => (it.rating === '' ? { ...it, rating: 'N/A' } : it)) }));
  const o = observationFromFeedback({ feedback: feedback({ feedback_json: { ...base, sections } }), game: GAME, coachee: COACHEE, rc: RC_A })!;
  expect(o.ratings).toHaveLength(3);
  expect(o.answered).toBe(4);
  expect(o.offered).toBe(4);
});

test('a test game — no coachee — is not an observation; the roster fills an empty level', () => {
  expect(observationFromFeedback({ feedback: feedback(), game: GAME, coachee: undefined, rc: RC_A })).toBeNull();
  const fb = feedback({ feedback_json: { ...feedback().feedback_json as object, meta: { srNiveau: '', gruppe: '' } } });
  const o = observationFromFeedback({ feedback: fb, game: GAME, coachee: COACHEE, rc: RC_A })!;
  expect(o.level).toBe('N3-1');
  expect(o.groups).toEqual(['Referee Coaching']);
});

test('sets and points come from either result shape; deciders are the fifth set or a third played to 15', () => {
  expect(gameFacts('3:1 | 25:20, 22:25, 25:18, 25:22')).toEqual({ sets: 4, points: 182, decider: false });
  expect(gameFacts('3:2 (25:20 / 22:25 / 25:18 / 20:25 / 15:13)')).toEqual({ sets: 5, points: 208, decider: true });
  expect(gameFacts('2:1 (25:20 / 22:25 / 15:13)')).toEqual({ sets: 3, points: 120, decider: true });
  expect(gameFacts('3:0 (25:20 / 25:22 / 25:18)')).toEqual({ sets: 3, points: 135, decider: false });
  expect(gameFacts('')).toEqual({ sets: 0, points: 0, decider: false });
});

test('levels normalise to the official spelling', () => {
  expect(normalizeLevel('N3-2')).toBe('N3-2');
  expect(normalizeLevel('n3 - 2')).toBe('N3-2');
  expect(normalizeLevel('N1')).toBe('N1');
  expect(normalizeLevel('Kader')).toBe('');
});

test('the filing delay is whole Zürich days, never negative', () => {
  expect(filingDelayDays('2025-10-03 18:30:00.000Z', '2025-10-03T21:00:00Z')).toBe(0);
  expect(filingDelayDays('2025-10-03 18:30:00.000Z', '2025-10-05T06:00:00Z')).toBe(2);
  // Late evening game in Zürich, filed after midnight local time — one day.
  expect(filingDelayDays('2025-10-03 18:30:00.000Z', '2025-10-03T22:30:00Z')).toBe(1);
  expect(filingDelayDays('', '2025-10-03T21:00:00Z')).toBeNull();
});

// ── Aggregation ──────────────────────────────────────────────────────────────

function obs(over: Partial<StatObservation>): StatObservation {
  return {
    id: 'o', gameId: 'g', gameDate: '2025-10-03 18:30:00.000Z', league: '3L ♂ A', location: 'Halle Nord',
    homeTeam: 'A', awayTeam: 'B', result: '3:0 (25:20 / 25:22 / 25:18)', role: '1SR', lang: 'DE',
    rcId: RC_A.id, rcName: RC_A.name, coacheeId: 'c-1', coacheeName: 'Zoe Zwei', level: 'N3-2', groups: ['Beförderung?'],
    ratings: [{ id: '1sr-prep-1', section: 0, score: 8 }, { id: '1sr-prep-2', section: 0, score: 11 }],
    offered: 4, answered: 4, einstufung: 'check', motivation: 'up', spielniveau: 'normal', secondBesuch: 'N', srZiel: '',
    words: 10, chars: 50, filled: { highlights: true, improvements: false, goals: false },
    signed: true, rcSigned: true, submittedAt: '2025-10-03T21:00:00Z',
    ...over,
  };
}
const RCS: StatRcInput[] = [
  { ...RC_A, goal: 10, planned: 2, outstanding: 1 },
  { ...RC_B, goal: 5, planned: 0, outstanding: 0 },
];
const ROSTER: StatCoacheeInput[] = [
  { id: 'c-1', name: 'Zoe Zwei', level: 'N3-2', groups: ['Beförderung?'], active: true },
  { id: 'c-2', name: 'Yves Eins', level: 'N4-1', groups: ['Varia'], active: true },
  { id: 'c-3', name: 'Xena Null', level: 'N2-1', groups: [], active: true },
  { id: 'c-9', name: 'Gone Away', level: 'N3-1', groups: [], active: false },
];

test('one game with both referees assessed is two observations but one game — sets and points counted once', () => {
  const stats = computeStatistics({
    season: 2025, filters: {}, now: new Date('2026-04-16T10:00:00Z'), rcs: RCS, roster: ROSTER,
    observations: [
      obs({ id: 'o1', gameId: 'g1', role: '1SR', coacheeId: 'c-1' }),
      obs({ id: 'o2', gameId: 'g1', role: '2SR', coacheeId: 'c-2', coacheeName: 'Yves Eins', level: 'N4-1', groups: ['Varia'] }),
      obs({ id: 'o3', gameId: 'g2', rcId: RC_B.id, rcName: RC_B.name, coacheeId: 'c-1', result: '3:2 (25:20 / 22:25 / 25:18 / 20:25 / 15:13)', gameDate: '2025-11-08 14:00:00.000Z' }),
    ],
  });
  expect(stats.totals.observations).toBe(3);
  expect(stats.totals.games).toBe(2);
  expect(stats.totals.sets).toBe(8);
  expect(stats.totals.points).toBe(135 + 208);
  expect(stats.totals.deciders).toBe(1);
  expect(stats.totals.coachees).toBe(2);
  expect(stats.totals.roster).toBe(3);       // the inactive one is not on it
  expect(stats.coacheeVisits).toEqual({ '0': 1, '1': 1, '2': 1, '3+': 0 });
  expect(stats.totals.rcsActive).toBe(2);
  expect(stats.totals.goal).toBe(15);
  expect(stats.byRole.map((b) => [b.key, b.observations])).toEqual([['1SR', 2], ['2SR', 1]]);
  const rcA = stats.byRc.find((b) => b.key === RC_A.id)!;
  expect([rcA.observations, rcA.games, rcA.sets, rcA.goal, rcA.planned, rcA.outstanding]).toEqual([2, 1, 3, 10, 2, 1]);
  expect(stats.byMonth.map((b) => b.key)).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
  expect(stats.byMonth.find((b) => b.key === '2025-10')!.observations).toBe(2);
  expect(stats.byLevel.map((b) => [b.key, b.observations])).toEqual([['N3', 2], ['N4', 1]]);
  expect(stats.byGroup.map((b) => [b.key, b.observations])).toEqual([['Beförderung?', 2], ['Varia', 1]]);
  expect(stats.byCategory.map((b) => [b.key, b.observations])).toEqual([['H', 3]]);
  expect(stats.byDivision.map((b) => [b.key, b.observations])).toEqual([['3', 3]]);
  expect(stats.byWeekday.map((b) => [b.key, b.observations])).toEqual([['5', 2], ['6', 1]]);
  expect(stats.byHour.map((b) => [b.key, b.observations])).toEqual([['15', 1], ['20', 2]]);
  expect(stats.fun.busiestDay).toEqual({ key: '2025-10-03', count: 2 });
  expect(stats.fun.first).toBe('2025-10-03');
  expect(stats.fun.last).toBe('2025-11-08');
  expect(stats.totals.longestGame).toEqual({ label: 'A – B', sets: 5, points: 208 });
});

test('grades: the histogram counts what was given, thin averages are marked, sections sum their criteria', () => {
  const three = [
    obs({ id: 'o1', gameId: 'g1', ratings: [{ id: 'x', section: 0, score: 8 }, { id: 'y', section: 1, score: 11 }] }),
    obs({ id: 'o2', gameId: 'g2', ratings: [{ id: 'x', section: 0, score: 9 }, { id: 'y', section: 1, score: 8 }] }),
    obs({ id: 'o3', gameId: 'g3', ratings: [{ id: 'x', section: 0, score: 7 }] }),
  ];
  const stats = computeStatistics({ season: 2025, filters: {}, now: new Date(), rcs: RCS, roster: ROSTER, observations: three });
  expect(stats.histogram).toEqual({ C: 2, 'C+': 1, 'C-': 1, B: 1 });
  expect(stats.totals.ratingsAll).toBe(5);
  expect(stats.totals.ratingsC).toBe(2);
  expect(stats.totals.ratingsBPlus).toBe(1);
  expect(gradeAvg(stats.totals.grade)).toBe(8.6);
  expect(scoreToLetter(8.6)).toBe('C');
  const x = stats.criteria.find((c) => c.id === 'x')!;
  expect(x.grade).toEqual({ obs: 3, items: 3, sum: 24 });
  const y = stats.criteria.find((c) => c.id === 'y')!;
  // Two observations: the average is real but THIN — shown hollow, with its n.
  expect(gradeAvg(y.grade)).toBe(9.5);
  expect(isThin(y.grade.obs)).toBe(true);
  expect(isThin(x.grade.obs)).toBe(false);
  expect(gradeAvg(y.grade, 3)).toBeNull();
  expect(stats.sections.map((s) => [s.section, s.grade.obs, s.grade.items])).toEqual([[0, 3, 3], [1, 2, 2]]);
  // Nothing rated at all: no average to show.
  const none = computeStatistics({ season: 2025, filters: {}, now: new Date(), rcs: RCS, roster: ROSTER, observations: [obs({ ratings: [] })] });
  expect(gradeAvg(none.totals.grade)).toBeNull();
});

test('filters cut the observations, the roster and the coaches together', () => {
  const observations = [
    obs({ id: 'o1', gameId: 'g1', level: 'N3-2', groups: ['Beförderung?'] }),
    obs({ id: 'o2', gameId: 'g2', level: 'N3-1', groups: ['Varia'], coacheeId: 'c-2', rcId: RC_B.id, rcName: RC_B.name, role: '2SR' }),
    obs({ id: 'o3', gameId: 'g3', level: 'N4-1', groups: ['Varia', 'Beförderung?'], coacheeId: 'c-2' }),
  ];
  const base = { season: 2025, now: new Date(), rcs: RCS, roster: ROSTER, observations };
  expect(computeStatistics({ ...base, filters: { level: 'N3' } }).totals.observations).toBe(2);
  expect(computeStatistics({ ...base, filters: { level: 'N3-1' } }).totals.observations).toBe(1);
  expect(computeStatistics({ ...base, filters: { group: 'beförderung?' } }).totals.observations).toBe(2);
  expect(computeStatistics({ ...base, filters: { group: 'Varia' } }).totals.roster).toBe(1);
  expect(computeStatistics({ ...base, filters: { role: '2SR' } }).totals.observations).toBe(1);
  const rcB = computeStatistics({ ...base, filters: { rc: RC_B.id } });
  expect(rcB.totals.observations).toBe(1);
  expect(rcB.totals.rcsTotal).toBe(1);
  expect(rcB.totals.goal).toBe(5);
  expect(rcB.byRc.map((b) => b.key)).toEqual([RC_B.id]);
});

test('writing and process totals', () => {
  const observations = [
    obs({ id: 'o1', gameId: 'g1', words: 100, chars: 500, submittedAt: '2025-10-03T21:00:00Z' }),
    obs({ id: 'o2', gameId: 'g2', words: 20, chars: 90, submittedAt: '2025-10-15T21:00:00Z', lang: 'EN', signed: false }),
    obs({ id: 'o3', gameId: 'g3', words: 60, chars: 300, submittedAt: '2025-10-05T21:00:00Z', filled: { highlights: false, improvements: true, goals: true } }),
  ];
  const stats = computeStatistics({ season: 2025, filters: {}, now: new Date(), rcs: RCS, roster: ROSTER, observations });
  expect(stats.totals.words).toBe(180);
  expect(stats.totals.chars).toBe(890);
  expect(stats.totals.wordsMedian).toBe(60);
  expect(stats.totals.longestRemark).toBe(100);
  expect([stats.totals.filledHighlights, stats.totals.filledImprovements, stats.totals.filledGoals]).toEqual([2, 1, 1]);
  expect(stats.totals.filingMedianDays).toBe(2);
  expect(stats.totals.filedSameDay).toBe(1);
  expect(stats.totals.filedLate).toBe(1);
  expect([stats.totals.langDE, stats.totals.langEN]).toEqual([2, 1]);
  expect([stats.totals.signedReferee, stats.totals.signedRc]).toEqual([2, 3]);
  expect(stats.fun.topWriter).toEqual({ name: RC_A.name, words: 180 });
});

test('the filter options come from the whole season, levels in table order', () => {
  const options = statOptions({
    observations: [obs({ level: 'N3-2', groups: ['Varia'] })],
    rcs: RCS,
    roster: ROSTER,
    seasons: [2025, 2024, 2025],
  });
  expect(options.levels).toEqual(['N2', 'N2-1', 'N3', 'N3-2', 'N4', 'N4-1']);
  expect(options.groups).toEqual(['Beförderung?', 'Varia']);
  expect(options.rcs.map((r) => r.name)).toEqual(['Anna Coach', 'Beat Coach']);
  expect(options.seasons).toEqual([2025, 2024]);
});

test('words: whitespace-split, markup-free', () => {
  expect(countWords('  Sehr gute\nLeistung  ')).toBe(3);
  expect(countWords('')).toBe(0);
});

test('a U23 game counts under its gender — DU23 women, HU23 men — and the league by its number', () => {
  const leagues = ['DU23 3. Liga', 'HU23 2. Liga', '5L ♀ B', 'U23'];
  const stats = computeStatistics({
    season: 2025, filters: {}, now: new Date(), rcs: RCS, roster: ROSTER,
    observations: leagues.map((league, i) => obs({ id: `o-${i}`, gameId: `g-${i}`, league })),
  });
  // A bare "U23" names no gender: Other, never a third kind of its own.
  expect(stats.byCategory.map((b) => [b.key, b.observations])).toEqual([['H', 1], ['D', 2], ['', 1]]);
  expect(stats.byDivision.map((b) => [b.key, b.observations])).toEqual([['2', 1], ['3', 1], ['5', 1], ['', 1]]);
});

// ── Trend: first visit against the latest ────────────────────────────────────

const graded = (score: number) => [{ id: '1sr-prep-1', section: 0, score }, { id: '1sr-prep-2', section: 0, score }];

test('trend: only the first and the latest visit count, so two and three visits read alike', () => {
  const tr = computeTrend([
    // c-1: C → B (8 → 11), with a dip in between that does not count.
    obs({ id: 'a1', coacheeId: 'c-1', gameDate: '2025-10-01 18:00:00.000Z', ratings: graded(8) }),
    obs({ id: 'a2', coacheeId: 'c-1', gameDate: '2025-11-01 18:00:00.000Z', ratings: graded(5) }),
    obs({ id: 'a3', coacheeId: 'c-1', gameDate: '2025-12-01 18:00:00.000Z', ratings: graded(11) }),
    // c-2: two visits, B → C: worse. Filed out of order — the game date decides.
    obs({ id: 'b2', coacheeId: 'c-2', level: 'N4-1', groups: ['Varia'], gameDate: '2025-12-01 18:00:00.000Z', ratings: graded(8) }),
    obs({ id: 'b1', coacheeId: 'c-2', level: 'N4-1', groups: ['Varia'], gameDate: '2025-10-01 18:00:00.000Z', ratings: graded(11) }),
    // c-3: a change under half a step is the same.
    obs({ id: 'c1', coacheeId: 'c-3', level: 'N2-1', groups: [], gameDate: '2025-10-01 18:00:00.000Z', ratings: [{ id: 'x', section: 0, score: 8 }, { id: 'y', section: 0, score: 9 }] }),
    obs({ id: 'c2', coacheeId: 'c-3', level: 'N2-1', groups: [], gameDate: '2025-11-01 18:00:00.000Z', ratings: [{ id: 'x', section: 0, score: 8 }, { id: 'y', section: 0, score: 9 }, { id: 'z', section: 0, score: 8 }] }),
    // c-4: one visit — no trend. c-5: a visit with no grades does not count as one.
    obs({ id: 'd1', coacheeId: 'c-4' }),
    obs({ id: 'e1', coacheeId: 'c-5', ratings: graded(8) }),
    obs({ id: 'e2', coacheeId: 'c-5', ratings: [] }),
  ]);
  expect(tr).toMatchObject({ coachees: 3, improved: 1, same: 1, worse: 1 });
  expect(tr.deltaSum).toBeCloseTo(3 - 3 - 1 / 6, 2);
  expect(tr.byLevel.map((r) => [r.key, r.improved, r.same, r.worse])).toEqual([['N2', 0, 1, 0], ['N3', 1, 0, 0], ['N4', 0, 0, 1]]);
  expect(tr.byGroup.find((r) => r.key === 'Varia')).toMatchObject({ coachees: 1, worse: 1 });
  expect(tr.byGroup.find((r) => r.key === '')).toMatchObject({ coachees: 1, same: 1 });
});

test('the season statistics carry the trend, and a filter cuts it', () => {
  const list = [
    obs({ id: 'a1', coacheeId: 'c-1', gameDate: '2025-10-01 18:00:00.000Z', ratings: graded(8) }),
    obs({ id: 'a2', coacheeId: 'c-1', gameDate: '2025-11-01 18:00:00.000Z', ratings: graded(11) }),
  ];
  const all = computeStatistics({ season: 2025, observations: list, rcs: RCS, roster: ROSTER, filters: {}, now: new Date('2026-01-01') });
  expect(all.trend).toMatchObject({ coachees: 1, improved: 1 });
  const other = computeStatistics({ season: 2025, observations: list, rcs: RCS, roster: ROSTER, filters: { group: 'Varia' }, now: new Date('2026-01-01') });
  expect(other.trend?.coachees).toBe(0);
});

test('per-coachee summary: counts, averages per role, the latest answers and the ticks', () => {
  const [s] = coacheeSummaries([
    obs({ id: 'a1', gameDate: '2025-10-01 18:00:00.000Z', ratings: graded(8), einstufung: 'check', secondBesuch: 'Y', secondBesuchRole: '2SR', wantsPromotion: true }),
    obs({ id: 'a2', role: '2SR', gameDate: '2025-11-01 18:00:00.000Z', ratings: graded(11), einstufung: 'up', secondBesuch: 'N', srZiel: '2L' }),
  ]);
  expect(s).toMatchObject({
    coacheeId: 'c-1', observations: 2, obs1SR: 1, obs2SR: 1, firstAvg: 8, lastAvg: 11, trend: 'improved',
    einstufungUp: 1, einstufungSame: 1, lastEinstufung: 'up', lastSecondBesuch: 'N', lastSrZiel: '2L',
    wantsPromotion: true, wantsCandidate: false, firstDate: '2025-10-01', lastDate: '2025-11-01',
  });
  expect(gradeAvg(s.grade)).toBe(9.5);
  expect(gradeAvg(s.grade1SR)).toBe(8);
  expect(gradeAvg(s.grade2SR)).toBe(11);
});

test('breakdowns: one slice per Niveau, Stufe and group, empty ones left out', () => {
  const list = [
    obs({ id: 'a1', coacheeId: 'c-1' }),
    obs({ id: 'b1', coacheeId: 'c-2', level: 'N4-1', groups: ['Varia'] }),
  ];
  const input = { season: 2025, observations: list, rcs: RCS, roster: ROSTER, filters: { level: 'N3' }, now: new Date('2026-01-01') };
  const options = statOptions({ observations: list, rcs: RCS, roster: ROSTER, seasons: [2025] });
  const b = computeBreakdowns(input, options);
  // The slice replaces the caller's level filter rather than stacking on it.
  expect(b.level.map((x) => [x.key, x.stats.totals.observations])).toEqual([['N2', 0], ['N3', 1], ['N4', 1]]);
  expect(b.stufe.map((x) => x.key)).toEqual(['N2-1', 'N3-1', 'N3-2', 'N4-1'].filter((k) => k !== 'N3-1'));
  expect(b.group.map((x) => x.key).sort()).toEqual(['Beförderung?', 'Varia']);
});

// ── Letters only: + and − are the form's nuance, statistics speak A to E ─────

test('a score or an average reads as its letter — never with a + or −', () => {
  // Every point on the 1–15 scale, and the halves between them.
  for (let v = 1; v <= 15; v += 0.5) expect(STAT_LETTERS).toContain(scoreToLetter(v));
  // A ± belongs to its letter: C− 7, C 8, C+ 9 are all C; B− 10 is B.
  expect([7, 8, 9].map(scoreToLetter)).toEqual(['C', 'C', 'C']);
  expect(scoreToLetter(10)).toBe('B');
  // An average takes the letter whose band it lies in (halfway between centres).
  expect(scoreToLetter(9.49)).toBe('C');
  expect(scoreToLetter(9.5)).toBe('B');
  expect(scoreToLetter(12.5)).toBe('A');
  expect(scoreToLetter(3.49)).toBe('E');
  // Folded ratings sit on the letters' centres.
  expect([13, 14, 15, 7, 9, 1, 3].map(letterScore)).toEqual([14, 14, 14, 8, 8, 2, 2]);
});

test('a histogram in fifteen grades folds into five letters', () => {
  expect(foldHistogram({ 'A+': 1, A: 2, 'A-': 3, 'C-': 4, C: 5, 'C+': 6, E: 7 })).toEqual({ A: 6, B: 0, C: 15, D: 0, E: 7 });
  expect(foldHistogram({})).toEqual({ A: 0, B: 0, C: 0, D: 0, E: 0 });
});

test('the server folds each rating before it counts: a C− and a C+ are two Cs', () => {
  const f = feedback();
  (f.feedback_json as { sections: Array<{ items: Array<{ rating: string }> }> }).sections[0].items.forEach((it, i) => { it.rating = ['C-', 'C+', 'C', ''][i] ?? ''; });
  const o = observationFromFeedback({ feedback: f, game: GAME, coachee: COACHEE, rc: RC_A })!;
  expect(o.ratings.filter((r) => r.section === 0).map((r) => r.score)).toEqual([8, 8, 8]);
  const stats = computeStatistics({ season: 2025, filters: {}, now: new Date(), rcs: RCS, roster: ROSTER, observations: [o] });
  // Only plain letters in the histogram the page and the deck read.
  expect(Object.keys(stats.histogram).every((k) => (STAT_LETTERS as readonly string[]).includes(k))).toBe(true);
});

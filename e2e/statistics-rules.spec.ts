import { test, expect } from '@playwright/test';
import {
  computeStatistics, observationFromFeedback, gameFacts, filingDelayDays, normalizeLevel, statOptions,
  type StatObservation, type StatRcInput, type StatCoacheeInput,
} from '../server/statistics';
import { gradeAvg, isThin, scoreToLetter, countWords } from '../src/lib/statistics';

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
  expect(o.ratings.map((r) => [r.id, r.section, r.score])).toEqual([['1sr-prep-1', 0, 11], ['1sr-prep-2', 0, 8], ['1sr-lead-1', 1, 13]]);
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
  expect(scoreToLetter(8.6)).toBe('C+');
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

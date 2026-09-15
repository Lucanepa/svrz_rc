// A synthetic season for Admin → Statistik: forty-odd observations across
// three coaches, four groups, three levels and eight months, aggregated by the
// real server code so the fixture can never drift from the shape the tab reads.
import { computeStatistics, statOptions, type StatObservation, type StatRcInput, type StatCoacheeInput } from '../../server/statistics';
import type { StatFilters, StatisticsResponse } from '../../src/lib/statistics';

export const STAT_RCS: StatRcInput[] = [
  { id: 'rc-anna', name: 'Anna Amsler', goal: 10, planned: 2, outstanding: 1 },
  { id: 'rc-beat', name: 'Beat Brunner', goal: 10, planned: 0, outstanding: 0 },
  { id: 'rc-cla', name: 'Claudia Casanova', goal: 5, planned: 1, outstanding: 0 },
];

const COACHEES = [
  { id: 'c1', name: 'Zoe Zwei', level: 'N3-2', groups: ['Beförderung?'] },
  { id: 'c2', name: 'Yves Eins', level: 'N4-1', groups: ['Varia'] },
  { id: 'c3', name: 'Xena Drei', level: 'N2-1', groups: ['Referee Coaching'] },
  { id: 'c4', name: 'Willi Vier', level: 'N3-1', groups: ['Neu-Schiedsrichter 26/27'] },
  { id: 'c5', name: 'Vera Fünf', level: 'N4-2', groups: ['Varia', 'Beförderung?'] },
  { id: 'c6', name: 'Urs Sechs', level: 'N3-3', groups: ['2. Schiedsrichter'] },
];
export const STAT_ROSTER: StatCoacheeInput[] = [
  ...COACHEES.map((c) => ({ ...c, active: true })),
  { id: 'c7', name: 'Tina Sieben', level: 'N4-3', groups: ['Varia'], active: true },
  { id: 'c8', name: 'Silvan Acht', level: 'N3-2', groups: [], active: true },
];

const RESULTS = [
  '3:0 (25:20 / 25:22 / 25:18)',
  '3:1 (25:20 / 22:25 / 25:18 / 25:22)',
  '3:2 (25:20 / 22:25 / 25:18 / 20:25 / 15:13)',
  '1:3 (20:25 / 25:23 / 19:25 / 21:25)',
];
const LEAGUES = ['3L ♂ A', '2L ♀', '4L ♂', 'NLB ♀', 'DU23 1. Liga', '3L ♀ B'];
const HALLS = ['Halle Nord', 'Sporthalle Utogrund', 'Turnhalle Süd', 'Halle Nord'];
const CRITERIA_1SR = ['1sr-prep-1', '1sr-prep-2', '1sr-prep-3', '1sr-prep-4', '1sr-tech-1', '1sr-tech-2', '1sr-rule-1', '1sr-lead-1', '1sr-pers-1'];
const CRITERIA_2SR = ['2sr-prep-1', '2sr-prep-2', '2sr-prep-3', '2sr-prep-4', '2sr-tech-1', '2sr-tech-2', '2sr-rule-1', '2sr-lead-1', '2sr-pers-1'];

export function statObservations(season: number, count = 44): StatObservation[] {
  const out: StatObservation[] = [];
  for (let i = 0; i < count; i += 1) {
    const coachee = COACHEES[i % COACHEES.length];
    const rc = STAT_RCS[i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : 2];
    const role = i % 4 === 3 ? '2SR' : '1SR';
    const monthOffset = i % 8; // Sep .. Apr
    const month = monthOffset < 4 ? 9 + monthOffset : monthOffset - 3;
    const year = monthOffset < 4 ? season : season + 1;
    const day = 3 + ((i * 7) % 24);
    const hour = 14 + (i % 4) * 2;
    const gameDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour - 2).padStart(2, '0')}:00:00.000Z`;
    const ids = role === '2SR' ? CRITERIA_2SR : CRITERIA_1SR;
    const base = 7 + (i % 5); // C- .. B
    const ratings = ids.map((id, k) => ({ id, section: k < 4 ? 0 : k < 6 ? 1 : k < 7 ? 2 : k < 8 ? 3 : 4, score: Math.min(15, base + ((i + k) % 3)) }));
    // The same game for two consecutive observations every ninth pair —
    // both referees of one game, which must count as one game.
    const gameId = i % 9 === 1 ? `g-${i - 1}` : `g-${i}`;
    out.push({
      id: `o-${i}`, gameId, gameDate, league: LEAGUES[i % LEAGUES.length], location: HALLS[i % HALLS.length],
      homeTeam: `VBC ${['Nord', 'Süd', 'West', 'Ost'][i % 4]}`, awayTeam: `TV ${['Gast', 'Fern', 'Weit'][i % 3]}`,
      result: RESULTS[i % RESULTS.length], role, lang: i % 11 === 0 ? 'EN' : 'DE',
      rcId: rc.id, rcName: rc.name, coacheeId: coachee.id, coacheeName: coachee.name, level: coachee.level, groups: coachee.groups,
      ratings, offered: ids.length,
      einstufung: ['check', 'check', 'up', 'check', 'down'][i % 5], motivation: ['up', 'check', 'check'][i % 3],
      spielniveau: ['normal', 'leicht', 'schwierig', 'normal'][i % 4], secondBesuch: i % 6 === 0 ? 'Y' : 'N', srZiel: ['2L', '3L', 'Verbleib', ''][i % 4],
      words: 60 + (i * 37) % 200, chars: 350 + (i * 211) % 1100,
      filled: { highlights: i % 2 === 0, improvements: i % 3 !== 0, goals: i % 4 === 0 },
      signed: i % 7 !== 0, rcSigned: true,
      submittedAt: `${year}-${String(month).padStart(2, '0')}-${String(Math.min(28, day + (i % 4))).padStart(2, '0')}T21:00:00Z`,
    });
  }
  // One lone N1 visit — a level with fewer observations than an average needs.
  out.push({
    ...out[0], id: 'o-n1', gameId: 'g-n1', coacheeId: 'c-n1', coacheeName: 'Nora Eins', level: 'N1', groups: ['Varia'],
    league: 'NLA ♂', gameDate: `${season}-12-20 18:00:00.000Z`, submittedAt: `${season}-12-20T22:00:00Z`,
  });
  return out;
}

export function statsResponse(season = 2026, filters: StatFilters = {}, compare = true): StatisticsResponse {
  const now = new Date(`${season + 1}-04-16T10:00:00Z`);
  const current = statObservations(season);
  const stats = computeStatistics({ season, observations: current, rcs: STAT_RCS, roster: STAT_ROSTER, filters, now });
  const before = statObservations(season - 1, 31);
  const previous = compare ? computeStatistics({ season: season - 1, observations: before, rcs: STAT_RCS, roster: STAT_ROSTER, filters, now }) : null;
  return {
    stats: { ...stats, previous },
    options: statOptions({ observations: current, rcs: STAT_RCS, roster: STAT_ROSTER, seasons: [season, season - 1] }),
  };
}

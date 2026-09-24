// Admin → Coachees → export: every coachee of a season, one row each, with
// the roster's own fields and what the season's observations say about them
// (counts, averages, the latest assessment, the ticks under the SR goal).
// One row model, two files: an XLSX for working with, a landscape PDF for
// handing round. Both are built in the browser; the figures come from
// GET /api/admin/coachee-summaries and the rest from the coachee list.
// This file is the table alone (pure, unit-tested); coacheeExportFiles.ts
// draws it into the two files.
import type { Lang } from './appTime';
import { dayLabel } from './appTime';
import type { Coachee } from './pocketbase';
import { gradeAvg, scoreToLetter, type CoacheeSummary, type GradeAgg } from './statistics';
import { groupKeyLabel, outcomeLabel } from './statsLabels';
import { seasonLabel } from './season';
import { splitCoacheeGroups } from './coacheeGroup';

type Cell = string | number | null;
export type ExportColumn = { key: string; label: string; /** Relative width in the PDF. */ w: number };
export type ExportTable = { columns: ExportColumn[]; rows: Cell[][] };

export const COACHEE_EXPORT_STR = {
  DE: {
    lastName: 'Nachname', firstName: 'Vorname', email: 'E-Mail', phone: 'Telefon', sv: 'SV-Nr.',
    level: 'Niveau', stage: 'Stufe', groups: 'Gruppe', notes: 'Notizen', season: 'Saison',
    obs: 'Beob.', obs1: 'Beob. 1SR', obs2: 'Beob. 2SR',
    avg: 'Ø Note', avgNum: 'Ø Note (Zahl)', avg1: 'Ø 1SR', avg2: 'Ø 2SR',
    first: 'Erste Beob.', last: 'Letzte Beob.', firstAvg: 'Ø erste', lastAvg: 'Ø letzte', trend: 'Trend',
    up: 'Einstufung ↑', same: 'Einstufung =', down: 'Einstufung ↓', lastEinst: 'Letzte Einstufung',
    motivation: 'Motivation (letzte)', level2: 'Spielniveau (letztes)', further: 'Weiterer Besuch (letzter)',
    goal: 'SR-Ziel (letztes)', wantsPromotion: 'Will befördert werden', wantsCandidate: 'Kandidat:in nächste Saison',
    rcs: 'Referee Coaches', yes: 'Ja', no: 'Nein',
    improved: 'Besser', sameT: 'Gleich', worse: 'Schlechter',
    title: (s: string) => `Coachees ${s}`, generated: 'Stand',
  },
  EN: {
    lastName: 'Last name', firstName: 'First name', email: 'Email', phone: 'Phone', sv: 'SV no.',
    level: 'Level', stage: 'Stufe', groups: 'Group', notes: 'Notes', season: 'Season',
    obs: 'Obs.', obs1: 'Obs. 1SR', obs2: 'Obs. 2SR',
    avg: 'Avg. grade', avgNum: 'Avg. grade (number)', avg1: 'Avg. 1SR', avg2: 'Avg. 2SR',
    first: 'First obs.', last: 'Latest obs.', firstAvg: 'Avg. first', lastAvg: 'Avg. latest', trend: 'Trend',
    up: 'Rated ↑', same: 'Rated =', down: 'Rated ↓', lastEinst: 'Latest rating',
    motivation: 'Motivation (latest)', level2: 'Match level (latest)', further: 'Further visit (latest)',
    goal: 'SR goal (latest)', wantsPromotion: 'Wants to be promoted', wantsCandidate: "Next year's candidate",
    rcs: 'Referee coaches', yes: 'Yes', no: 'No',
    improved: 'Better', sameT: 'Same', worse: 'Worse',
    title: (s: string) => `Coachees ${s}`, generated: 'As of',
  },
};

const surname = (c: Coachee) => (c.last_name || '').trim() || c.full_name.split(' ').slice(1).join(' ');
const given = (c: Coachee) => (c.first_name || '').trim() || c.full_name.split(' ')[0] || '';
const grade = (g: GradeAgg | undefined): string => { const a = gradeAvg(g); return a === null ? '' : `${scoreToLetter(a)} (${a.toFixed(1)})`; };
const date = (d: string) => (d ? dayLabel(d, { year: true }) : '');

/** The table both files draw. Surname order; a coachee without observations
 *  keeps the roster columns and leaves the figures empty. */
export function coacheeExportTable(coachees: Coachee[], summaries: CoacheeSummary[] | null, season: number, lang: Lang): ExportTable {
  const t = COACHEE_EXPORT_STR[lang];
  const by = new Map((summaries ?? []).map((s) => [s.coacheeId, s]));
  const withFigures = summaries !== null;
  const columns: ExportColumn[] = [
    { key: 'lastName', label: t.lastName, w: 1.4 },
    { key: 'firstName', label: t.firstName, w: 1.2 },
    { key: 'email', label: t.email, w: 2 },
    { key: 'phone', label: t.phone, w: 1.3 },
    { key: 'sv', label: t.sv, w: 0.9 },
    { key: 'level', label: t.level, w: 0.7 },
    { key: 'stage', label: t.stage, w: 0.6 },
    { key: 'groups', label: t.groups, w: 1.5 },
    { key: 'notes', label: t.notes, w: 1.5 },
    { key: 'season', label: t.season, w: 0.8 },
    ...(withFigures ? [
      { key: 'obs', label: t.obs, w: 0.6 },
      { key: 'obs1', label: t.obs1, w: 0.6 },
      { key: 'obs2', label: t.obs2, w: 0.6 },
      { key: 'avg', label: t.avg, w: 0.9 },
      { key: 'avg1', label: t.avg1, w: 0.9 },
      { key: 'avg2', label: t.avg2, w: 0.9 },
      { key: 'first', label: t.first, w: 1 },
      { key: 'last', label: t.last, w: 1 },
      { key: 'firstAvg', label: t.firstAvg, w: 0.7 },
      { key: 'lastAvg', label: t.lastAvg, w: 0.7 },
      { key: 'trend', label: t.trend, w: 0.9 },
      { key: 'up', label: t.up, w: 0.7 },
      { key: 'same', label: t.same, w: 0.7 },
      { key: 'down', label: t.down, w: 0.7 },
      { key: 'lastEinst', label: t.lastEinst, w: 1 },
      { key: 'motivation', label: t.motivation, w: 1 },
      { key: 'level2', label: t.level2, w: 1 },
      { key: 'further', label: t.further, w: 1 },
      { key: 'goal', label: t.goal, w: 1.3 },
      { key: 'wantsPromotion', label: t.wantsPromotion, w: 0.9 },
      { key: 'wantsCandidate', label: t.wantsCandidate, w: 0.9 },
      { key: 'rcs', label: t.rcs, w: 1.6 },
    ] : []),
  ];
  const trendText = (s: CoacheeSummary) => (s.trend === 'improved' ? t.improved : s.trend === 'same' ? t.sameT : s.trend === 'worse' ? t.worse : '');
  const outcome = (kind: 'einstufung' | 'motivation' | 'spielniveau', v: string) => (v ? outcomeLabel(kind, v, lang) || v : '');
  const rows = [...coachees]
    .sort((a, b) => surname(a).localeCompare(surname(b), 'de') || given(a).localeCompare(given(b), 'de'))
    .map((c): Cell[] => {
      const s = by.get(c.id);
      const base: Cell[] = [
        surname(c), given(c), c.email || '', c.phone || '', c.referee_id || '',
        c.referee_level || '', c.stage || '',
        splitCoacheeGroups(c.groups).map((g) => groupKeyLabel(g, lang)).join(', '),
        c.notes || '', typeof c.season === 'number' ? seasonLabel(c.season) : seasonLabel(season),
      ];
      if (!withFigures) return base;
      if (!s) return [...base, 0, 0, 0, ...Array(columns.length - base.length - 3).fill('')];
      return [
        ...base,
        s.observations, s.obs1SR, s.obs2SR,
        grade(s.grade), grade(s.grade1SR), grade(s.grade2SR),
        date(s.firstDate), date(s.lastDate),
        s.firstAvg, s.observations > 1 ? s.lastAvg : null,
        trendText(s),
        s.einstufungUp, s.einstufungSame, s.einstufungDown,
        outcome('einstufung', s.lastEinstufung),
        outcome('motivation', s.lastMotivation),
        outcome('spielniveau', s.lastSpielniveau),
        s.lastSecondBesuch ? `${s.lastSecondBesuch}${s.lastSecondBesuch === 'Y' && s.lastSecondBesuchRole ? ` (${s.lastSecondBesuchRole})` : ''}` : '',
        s.lastSrZiel,
        s.wantsPromotion ? t.yes : '',
        s.wantsCandidate ? t.yes : '',
        s.rcs.join(', '),
      ];
    });
  return { columns, rows };
}

export const coacheeExportName = (season: number, ext: 'xlsx' | 'pdf') =>
  `svrz-rc-coachees-${seasonLabel(season).replace('/', '-')}-${new Date().toISOString().slice(0, 10)}.${ext}`;

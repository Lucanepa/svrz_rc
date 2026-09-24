// The deck — one model, two renderers. buildDeck() turns a SeasonStatistics
// into slides of tiles, charts, tables and bullets; statsPptx.ts draws them as
// native PowerPoint charts, statsPdf.ts as vector pages. Neither computes a
// number of its own, so the two files can never disagree with each other or
// with the dashboard.
import type { Lang } from './appTime';
import { dayLabel } from './appTime';
import {
  a4Pages, estimatedHours, gradeAvg, isThin, pct, scoreToLetter, GRADE_ORDER,
  type SeasonStatistics, type SeasonStatisticsCore, type StatBucket, type StatRole,
} from './statistics';
import {
  categoryLabel, criterionLabel, divisionLabel, groupKeyLabel, levelKeyLabel, monthLabel, OUTCOME_ORDER,
  outcomeColor, outcomeLabel, roleLabel, sectionTitle, seasonName, statStrings, type StatStrings,
} from './statsLabels';

export type DeckTile = { label: string; value: string; sub?: string };
export type DeckChart =
  | { kind: 'columns'; series: string[]; categories: string[]; values: number[][]; grouping: 'stacked' | 'clustered' }
  | { kind: 'bars'; categories: string[]; values: number[] }
  | { kind: 'grade'; categories: string[]; values: Array<number | null>; ns: number[] }
  | { kind: 'donut'; categories: string[]; values: number[]; colors?: string[] };
export type DeckFigure = { title: string; chart: DeckChart };
export type DeckTable = {
  head: string[];
  rows: string[][];
  /** Column widths as fractions of the table; even when absent. */
  widths?: number[];
  /** Per column; text columns left, numbers right. Default: first left, rest right. */
  align?: Array<'l' | 'r'>;
};
export type DeckSlide = {
  title: string;
  subtitle?: string;
  tiles?: DeckTile[];
  figures?: DeckFigure[];
  table?: DeckTable;
  bullets?: string[];
  note?: string;
};
export type Deck = {
  title: string;
  subtitle: string;
  /** Season · Stand · filters — the footer of every slide. */
  footer: string;
  lang: Lang;
  slides: DeckSlide[];
};

export type DeckOptions = { lang: Lang; includeRcGrades: boolean; includeLeagues: boolean; rcNames?: Record<string, string> };

const int = (n: number) => new Intl.NumberFormat('de-CH').format(Math.round(n));
const dec = (n: number, d = 1) => new Intl.NumberFormat('de-CH', { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const pctText = (p: number | null) => (p === null ? '–' : `${dec(p, 0)} %`);
/** "C+ · 8.6", with "(n = 2)" appended while the average is thin. */
export const gradeText = (avg: number | null, t: StatStrings, n?: number) =>
  avg === null ? '–' : `${scoreToLetter(avg)} · ${dec(avg)}${n !== undefined && isThin(n) ? ` (${t.tooFew(n)})` : ''}`;

export function filtersLine(stats: SeasonStatisticsCore, t: StatStrings, lang: Lang, rcNames: Record<string, string> = {}): string {
  const f = stats.filters;
  const parts: string[] = [];
  if (f.rc) parts.push(`${t.rc}: ${rcNames[f.rc] ?? f.rc}`);
  if (f.group) parts.push(`${t.group}: ${groupKeyLabel(f.group, lang)}`);
  if (f.level) parts.push(`${t.level}: ${f.level}`);
  if (f.role) parts.push(`${t.role}: ${roleLabel(f.role, lang)}`);
  return parts.join(' · ');
}

function delta(cur: number, prev: number | undefined, unit = ''): string | undefined {
  if (prev === undefined) return undefined;
  const d = cur - prev;
  return `${d > 0 ? '+' : d < 0 ? '-' : '±'}${int(Math.abs(d))}${unit}`;
}

export function buildDeck(stats: SeasonStatistics, opts: DeckOptions): Deck {
  const { lang } = opts;
  const t = statStrings(lang);
  const T = stats.totals;
  const prev = stats.previous;
  const season = seasonName(stats.season);
  const filters = filtersLine(stats, t, lang, opts.rcNames);
  const footer = [`${t.season} ${season}`, `${t.stand} ${dayLabel(stats.generatedAt, { year: true })}`, filters].filter(Boolean).join(' · ');
  const slides: DeckSlide[] = [];

  // 1 — title
  slides.push({
    title: t.deckTitle,
    subtitle: t.deckSubtitle(season),
    bullets: [
      `${t.stand}: ${dayLabel(stats.generatedAt, { year: true })}`,
      ...(filters ? [`${t.filtersLine}: ${filters}`] : []),
    ],
  });

  // 2 — the season in numbers
  const avg = gradeAvg(T.grade);
  slides.push({
    title: t.deckNumbers,
    tiles: [
      { label: t.observations, value: int(T.observations), sub: prev ? `${delta(T.observations, prev.totals.observations)} ${t.deltaVs(seasonName(prev.season))}` : undefined },
      { label: t.coacheesVisited, value: `${int(T.coachees)} / ${int(T.roster)}`, sub: pctText(pct(T.coachees, T.roster)) },
      { label: t.activeRcs, value: `${int(T.rcsActive)} / ${int(T.rcsTotal)}`, sub: `${t.pensum} ${pctText(pct(T.observations, T.goal))}` },
      { label: t.avgGrade, value: gradeText(avg, t, T.grade.obs), sub: t.normalCase },
      { label: t.sets, value: int(T.sets), sub: t.games(T.games) },
      { label: t.points, value: int(T.points), sub: t.hours(estimatedHours(T.sets)) },
      { label: t.words, value: int(T.words), sub: T.observations ? `${t.perObs} ${int(T.words / T.observations)}` : undefined },
    ],
  });

  // 3 — per month, by role
  slides.push({
    title: t.perMonth,
    figures: [{
      title: t.perMonth,
      chart: {
        kind: 'columns',
        grouping: 'stacked',
        series: [t.role1, t.role2],
        categories: stats.byMonth.map((b) => monthLabel(b.key, lang)),
        values: [stats.byMonth.map((b) => b.roles['1SR']), stats.byMonth.map((b) => b.roles['2SR'])],
      },
    }],
  });

  // 4 — coverage
  slides.push({
    title: t.coverage,
    figures: [
      {
        title: t.coverageHint,
        chart: { kind: 'bars', categories: ['0', '1', '2', '3+'].map((k) => t.visits(k)), values: ['0', '1', '2', '3+'].map((k) => stats.coacheeVisits[k] ?? 0) },
      },
      {
        title: `${t.pensum} — ${t.perRc}`,
        chart: {
          kind: 'bars',
          categories: stats.byRc.filter((r) => r.observations > 0 || r.goal > 0).map((r) => r.label),
          values: stats.byRc.filter((r) => r.observations > 0 || r.goal > 0).map((r) => r.observations),
        },
      },
    ],
    note: `${t.coacheesVisited}: ${int(T.coachees)} / ${int(T.roster)} (${pctText(pct(T.coachees, T.roster))}) · ${t.pensum}: ${int(T.observations)} / ${int(T.goal)}`,
  });

  // 5 — how we graded
  slides.push({
    title: t.histogram,
    figures: [{
      title: t.histogramHint,
      chart: { kind: 'bars', categories: GRADE_ORDER, values: GRADE_ORDER.map((g) => stats.histogram[g] ?? 0) },
    }],
    tiles: [
      { label: t.avgGrade, value: gradeText(avg, t, T.grade.obs) },
      { label: t.shareC, value: pctText(pct(T.ratingsC, T.ratingsAll)) },
      { label: t.shareB, value: pctText(pct(T.ratingsBPlus, T.ratingsAll)) },
    ],
  });

  // 6 — per section
  const sectionFigure = (role: StatRole): DeckFigure => {
    const rows = stats.sections.filter((s) => s.role === role);
    return {
      title: roleLabel(role, lang),
      chart: {
        kind: 'grade',
        categories: rows.map((s) => sectionTitle(role, s.section, lang)),
        values: rows.map((s) => gradeAvg(s.grade)),
        ns: rows.map((s) => s.grade.obs),
      },
    };
  };
  slides.push({ title: t.sections, figures: [sectionFigure('1SR'), sectionFigure('2SR')], note: `${t.normalCase} · ${t.thinNote}` });

  // 7 — strongest / weakest criteria
  const ranked = (role: StatRole) => stats.criteria
    .filter((c) => c.role === role && gradeAvg(c.grade) !== null)
    .map((c) => ({ label: criterionLabel(role, c.id, lang), avg: gradeAvg(c.grade)!, n: c.grade.obs }))
    .sort((a, b) => b.avg - a.avg);
  // One slide per form that has data: five strongest, five weakest.
  for (const role of ['1SR', '2SR'] as StatRole[]) {
    const list = ranked(role);
    if (list.length === 0) continue;
    const top = list.slice(0, 5);
    const bottom = list.slice(-5).reverse().filter((x) => !top.includes(x));
    slides.push({
      title: t.deckStrongWeak,
      subtitle: roleLabel(role, lang),
      table: {
        head: ['', t.criteria, t.gradeCol, 'n'],
        widths: [0.14, 0.6, 0.16, 0.1],
        align: ['l', 'l', 'r', 'r'],
        rows: [
          ...top.map((x) => [t.deckStrong, x.label, gradeText(x.avg, t), String(x.n)]),
          ...bottom.map((x) => [t.deckWeak, x.label, gradeText(x.avg, t), String(x.n)]),
        ],
      },
    });
  }

  // 8 — by level and group
  const gradeFigure = (title: string, rows: StatBucket[], label: (b: StatBucket) => string): DeckFigure => ({
    title,
    chart: { kind: 'grade', categories: rows.map(label), values: rows.map((b) => gradeAvg(b.grade)), ns: rows.map((b) => b.observations) },
  });
  slides.push({
    title: t.deckLevelGroup,
    figures: [
      gradeFigure(t.perLevel, stats.byLevel, (b) => levelKeyLabel(b.key, lang)),
      gradeFigure(t.perGroup, stats.byGroup.slice(0, 8), (b) => groupKeyLabel(b.key, lang)),
    ],
    note: t.normalCase,
  });

  // 9 — assessments
  const donut = (title: string, kind: keyof typeof OUTCOME_ORDER): DeckFigure => ({
    title,
    chart: {
      kind: 'donut',
      categories: OUTCOME_ORDER[kind].map((k) => outcomeLabel(kind, k, lang)),
      values: OUTCOME_ORDER[kind].map((k) => stats.outcomes[kind][k] ?? 0),
      colors: OUTCOME_ORDER[kind].map((k) => outcomeColor(kind, k)),
    },
  });
  slides.push({
    title: t.outcomes,
    figures: [donut(t.einstufung, 'einstufung'), donut(t.motivation, 'motivation'), donut(t.difficulty, 'spielniveau'), donut(t.secondVisit, 'secondBesuch')],
  });

  // 10 — per RC
  slides.push({
    title: t.perRc,
    table: {
      widths: [0.28, 0.12, 0.12, 0.12, 0.12, 0.12, 0.12],
      head: [t.rc, t.observations, t.coacheesCol, t.gamesCol, t.setsCol, t.wordsCol, t.goalCol],
      rows: stats.byRc.filter((r) => r.observations > 0 || r.goal > 0).map((r) => [
        r.label, int(r.observations), int(r.coachees), int(r.games), int(r.sets), int(r.words),
        r.goal ? `${int(r.observations)} / ${int(r.goal)}` : '–',
      ]),
    },
  });

  // 11 — games watched
  slides.push({
    title: t.gamesBlock,
    tiles: [
      { label: t.sets, value: int(T.sets), sub: t.games(T.games) },
      { label: t.points, value: int(T.points) },
      { label: t.setsPerGame, value: T.games ? dec(T.sets / T.games) : '–' },
      { label: t.deciders, value: `${int(T.deciders)} (${pctText(pct(T.deciders, T.games))})` },
      { label: t.longestGame, value: T.longestGame ? `${int(T.longestGame.points)}` : '–', sub: T.longestGame ? `${T.longestGame.label} · ${T.longestGame.sets} ${t.sets}` : undefined },
      { label: t.estHours, value: `≈ ${int(estimatedHours(T.sets))} h` },
      { label: t.hallsSeen, value: int(T.halls) },
      { label: t.teamsSeen, value: int(T.teams) },
    ],
  });

  // 12 — writing
  slides.push({
    title: t.writing,
    tiles: [
      { label: t.words, value: int(T.words) },
      { label: t.chars, value: int(T.chars) },
      { label: t.perObs, value: T.observations ? int(T.words / T.observations) : '–', sub: T.wordsMedian !== null ? `${t.wordsMedian} ${int(T.wordsMedian)}` : undefined },
      { label: t.longestRemark, value: `${int(T.longestRemark)} ${t.words}` },
      { label: t.pagesA4, value: dec(a4Pages(T.words)) },
      { label: `${t.filled}: ${t.highlights}`, value: pctText(pct(T.filledHighlights, T.observations)) },
      { label: `${t.filled}: ${t.improvements}`, value: pctText(pct(T.filledImprovements, T.observations)) },
      { label: `${t.filled}: ${t.goals}`, value: pctText(pct(T.filledGoals, T.observations)) },
    ],
    figures: [{
      title: `${t.words} — ${t.perRc}`,
      chart: {
        kind: 'bars',
        categories: stats.byRc.filter((r) => r.words > 0).slice(0, 10).map((r) => r.label),
        values: stats.byRc.filter((r) => r.words > 0).slice(0, 10).map((r) => r.words),
      },
    }],
  });

  // 13 — compared with last season
  if (prev) {
    const P = prev.totals;
    const prevAvg = gradeAvg(P.grade);
    slides.push({
      title: t.deckCompare,
      subtitle: `${seasonName(prev.season)} → ${season}`,
      table: {
        head: ['', seasonName(prev.season), season, 'Diff.'],
        rows: [
          [t.observations, int(P.observations), int(T.observations), delta(T.observations, P.observations) ?? ''],
          [t.coacheesVisited, `${int(P.coachees)} / ${int(P.roster)}`, `${int(T.coachees)} / ${int(T.roster)}`, delta(pct(T.coachees, T.roster) ?? 0, pct(P.coachees, P.roster) ?? 0, ' %') ?? ''],
          [t.activeRcs, int(P.rcsActive), int(T.rcsActive), delta(T.rcsActive, P.rcsActive) ?? ''],
          [t.avgGrade, gradeText(prevAvg, t, P.grade.obs), gradeText(avg, t, T.grade.obs), avg !== null && prevAvg !== null ? `${avg - prevAvg > 0 ? '+' : ''}${dec(avg - prevAvg)}` : ''],
          [t.sets, int(P.sets), int(T.sets), delta(T.sets, P.sets) ?? ''],
          [t.points, int(P.points), int(T.points), delta(T.points, P.points) ?? ''],
          [t.words, int(P.words), int(T.words), delta(T.words, P.words) ?? ''],
        ],
      },
      figures: [{
        title: t.perMonth,
        chart: {
          kind: 'columns',
          grouping: 'clustered',
          series: [seasonName(prev.season), season],
          categories: stats.byMonth.map((b) => monthLabel(b.key, lang)),
          values: [
            stats.byMonth.map((b) => prev.byMonth.find((p) => p.key.slice(5) === b.key.slice(5))?.observations ?? 0),
            stats.byMonth.map((b) => b.observations),
          ],
        },
      }],
    });
  }

  // 14 — fun facts
  const F = stats.fun;
  slides.push({
    title: t.fun,
    tiles: [
      { label: t.busiestDay, value: F.busiestDay ? int(F.busiestDay.count) : '–', sub: F.busiestDay ? dayLabel(F.busiestDay.key, { year: true }) : undefined },
      { label: t.topHall, value: F.topHall ? int(F.topHall.count) : '–', sub: F.topHall?.name },
      { label: t.topCoachee, value: F.topCoachee ? int(F.topCoachee.count) : '–', sub: F.topCoachee?.name },
      { label: t.topWriter, value: F.topWriter ? int(F.topWriter.words) : '–', sub: F.topWriter?.name },
      { label: t.firstLast, value: F.first ? dayLabel(F.first, { year: true }) : '–', sub: F.last ? dayLabel(F.last, { year: true }) : undefined },
      { label: t.filingMedian, value: T.filingMedianDays !== null ? t.days(Math.round(T.filingMedianDays)) : '–', sub: `${t.sameDay} ${pctText(pct(T.filedSameDay, T.observations))}` },
    ],
  });

  // optional — grades per coach
  if (opts.includeRcGrades) {
    const rows = stats.byRc.filter((r) => r.observations > 0);
    slides.push({
      title: t.deckRcGrades,
      subtitle: t.deckRcGradesHint,
      figures: [{
        title: t.avgGrade,
        chart: { kind: 'grade', categories: rows.map((r) => r.label), values: rows.map((r) => gradeAvg(r.grade)), ns: rows.map((r) => r.observations) },
      }],
      note: `${t.normalCase} · ${t.thinNote}`,
    });
  }

  // optional — leagues
  if (opts.includeLeagues) {
    slides.push({
      title: t.perLeague,
      figures: [
        { title: t.perLeague, chart: { kind: 'bars', categories: stats.byLeague.slice(0, 12).map((b) => b.label || '–'), values: stats.byLeague.slice(0, 12).map((b) => b.observations) } },
        { title: `${categoryLabel('H', lang)} / ${categoryLabel('D', lang)}`, chart: { kind: 'donut', categories: stats.byCategory.map((b) => categoryLabel(b.key, lang)), values: stats.byCategory.map((b) => b.observations) } },
      ],
      table: { head: [t.perLeague, t.observations], rows: stats.byDivision.map((b) => [divisionLabel(b.key, lang), int(b.observations)]) },
    });
  }

  // last — method
  slides.push({ title: t.method, bullets: t.methodLines });

  return { title: t.deckTitle, subtitle: t.deckSubtitle(season), footer, lang, slides };
}

export function deckFileName(stats: SeasonStatistics, ext: 'pptx' | 'pdf'): string {
  return `svrz-rc-statistik-${seasonName(stats.season).replace('/', '-')}-${stats.generatedAt.slice(0, 10)}.${ext}`;
}

// The deck — one model, two renderers. buildDeck() turns a SeasonStatistics
// into slides of tiles, charts, tables and bullets; statsPptx.ts draws them as
// native PowerPoint charts, statsPdf.ts as vector pages. Neither computes a
// number of its own, so the two files can never disagree with each other or
// with the dashboard.
import type { Lang } from './appTime';
import { dayLabel } from './appTime';
import {
  a4Pages, estimatedHours, gradeAvg, isThin, pct, scoreToLetter, trendAvgDelta, GRADE_ORDER,
  type SeasonStatistics, type SeasonStatisticsCore, type StatBreakdowns, type StatBucket, type StatRole, type StatSlice, type TrendAgg,
} from './statistics';
import {
  categoryLabel, criterionLabel, divisionLabel, groupKeyLabel, levelKeyLabel, monthLabel, OUTCOME_ORDER,
  outcomeColor, outcomeLabel, NEUTRAL, SEQ_BLUE, roleLabel, sectionTitle, seasonName, statStrings, type StatStrings,
} from './statsLabels';

export type DeckTile = { label: string; value: string; sub?: string };
export type DeckChart =
  | { kind: 'columns'; series: string[]; categories: string[]; values: number[][]; grouping: 'stacked' | 'clustered' }
  | { kind: 'bars'; categories: string[]; values: number[] }
  | { kind: 'grade'; categories: string[]; values: Array<number | null>; ns: number[] }
  | { kind: 'donut'; categories: string[]; values: number[]; colors?: string[] }
  /** One 100 % bar: the parts of a whole, counts and shares in the legend. */
  | { kind: 'stack'; categories: string[]; values: number[]; colors: string[] }
  /** Rows centred on a neutral middle: negative left, positive right, in shares. */
  | { kind: 'diverging'; categories: string[]; neg: number[]; mid: number[]; pos: number[]; labels: { neg: string; mid: string; pos: string }; colors: { neg: string; mid: string; pos: string } }
  /** Averages on the grade scale over time, C as the reference; null = no grade that month. */
  | { kind: 'line'; categories: string[]; values: Array<number | null>; ns: number[] };
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

export type DeckOptions = {
  lang: Lang;
  includeRcGrades: boolean;
  includeLeagues: boolean;
  rcNames?: Record<string, string>;
  /** The per-level and per-group slices. With them, the deck gets a set of
   *  slides per Niveau and per group after the aggregate one. */
  breakdowns?: StatBreakdowns | null;
  /** Leave the per-slice sets out even when the slices are there. */
  skipSlices?: boolean;
};

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
        chart: { kind: 'stack', categories: ['0', '1', '2', '3+'].map((k) => t.visits(k)), values: ['0', '1', '2', '3+'].map((k) => stats.coacheeVisits[k] ?? 0), colors: [...SEQ_BLUE] },
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
  const monthGrades = stats.byMonth.map((b) => gradeAvg(b.grade));
  slides.push({
    title: t.histogram,
    figures: [
      {
        title: t.histogramHint,
        chart: { kind: 'bars', categories: GRADE_ORDER, values: GRADE_ORDER.map((g) => stats.histogram[g] ?? 0) },
      },
      ...(monthGrades.some((v) => v !== null) ? [{
        title: t.gradePerMonth,
        chart: { kind: 'line' as const, categories: stats.byMonth.map((b) => monthLabel(b.key, lang)), values: monthGrades, ns: stats.byMonth.map((b) => b.observations) },
      }] : []),
    ],
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
  slides.push({ title: t.outcomes, figures: outcomeFigures(stats, t, lang, false) });

  // 9b — trend: first visit against the latest
  const trendSlide = trendSlideOf(stats, t, lang);
  if (trendSlide) slides.push(trendSlide);

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
        { title: `${categoryLabel('H', lang)} / ${categoryLabel('D', lang)}`, chart: { kind: 'stack', categories: stats.byCategory.map((b) => categoryLabel(b.key, lang)), values: stats.byCategory.map((b) => b.observations), colors: stats.byCategory.map((_, i) => ['#2a78d6', '#e2001a', '#eda100'][i % 3]) } },
      ],
      table: { head: [t.perLeague, t.observations], rows: stats.byDivision.map((b) => [divisionLabel(b.key, lang), int(b.observations)]) },
    });
  }

  // the per-level and per-group sets
  if (opts.breakdowns && !opts.skipSlices) {
    slides.push(...sliceSets(opts.breakdowns.level, 'level', t, lang, opts.breakdowns.stufe));
    slides.push(...sliceSets(opts.breakdowns.group, 'group', t, lang));
  }

  // last — method
  slides.push({ title: t.method, bullets: t.methodLines });

  return { title: t.deckTitle, subtitle: t.deckSubtitle(season), footer, lang, slides };
}

const sumOf = (d: Record<string, number>) => Object.values(d).reduce((a, n) => a + n, 0);

/** The assessments as the dashboard draws them: Einstufung and motivation as
 *  rows centred on ✓, difficulty and the further visit as one 100 % bar
 *  each. `dropEmpty` leaves out a figure (and a part) with nothing in it. */
function outcomeFigures(stats: SeasonStatisticsCore, t: StatStrings, lang: Lang, dropEmpty: boolean): DeckFigure[] {
  const o = stats.outcomes;
  const out: DeckFigure[] = [];
  const updown = (['einstufung', 'motivation'] as const).filter((k) => !dropEmpty || sumOf(o[k]) > 0);
  if (updown.length) {
    out.push({
      title: `${t.einstufung} · ${t.motivation}`,
      chart: {
        kind: 'diverging',
        categories: updown.map((k) => (k === 'einstufung' ? t.einstufung : t.motivation)),
        neg: updown.map((k) => o[k].down ?? 0), mid: updown.map((k) => o[k].check ?? 0), pos: updown.map((k) => o[k].up ?? 0),
        labels: { neg: '↓', mid: '✓', pos: '↑' },
        colors: { neg: outcomeColor('einstufung', 'down'), mid: NEUTRAL, pos: outcomeColor('einstufung', 'up') },
      },
    });
  }
  const bar = (kind: 'spielniveau' | 'secondBesuch', title: string, colors: string[]) => {
    const keys = OUTCOME_ORDER[kind].map((k, i) => ({ k, c: colors[i] })).filter((x) => !dropEmpty || (o[kind][x.k] ?? 0) > 0);
    if (dropEmpty && keys.length === 0) return;
    out.push({ title, chart: { kind: 'stack', categories: keys.map((x) => outcomeLabel(kind, x.k, lang)), values: keys.map((x) => o[kind][x.k] ?? 0), colors: keys.map((x) => x.c) } });
  };
  bar('spielniveau', t.difficulty, [SEQ_BLUE[0], SEQ_BLUE[2], SEQ_BLUE[3]]);
  bar('secondBesuch', t.secondVisit, ['#2a78d6', NEUTRAL]);
  return out;
}
const trendCounts = (tr: TrendAgg | undefined) => (tr && tr.coachees > 0 ? `↑${tr.improved} =${tr.same} ↓${tr.worse}` : '–');
const trendAvgText = (tr: TrendAgg | undefined) => {
  const d = trendAvgDelta(tr);
  return d === null ? '–' : `${d > 0 ? '+' : ''}${dec(d)}`;
};

/** The trend slide for one core (the season or a slice); null with no coachee seen twice. */
function trendSlideOf(stats: SeasonStatisticsCore, t: StatStrings, lang: Lang, title = t.trendTitle, subtitle?: string): DeckSlide | null {
  const tr = stats.trend;
  if (!tr || tr.coachees === 0) return null;
  const byLevel = tr.byLevel.filter((r) => r.coachees > 0);
  const byGroup = tr.byGroup.filter((r) => r.coachees > 0);
  // Worse left, same in the middle, better right — all coachees first, then
  // each level (the table beside it carries the groups and the mean change).
  const rowsOf = [{ label: t.trendCoachees, r: tr }, ...(byLevel.length > 1 ? byLevel.map((r) => ({ label: levelKeyLabel(r.key, lang), r })) : [])];
  const figures: DeckFigure[] = [{
    title: t.trendTitle,
    chart: {
      kind: 'diverging',
      categories: rowsOf.map((x) => x.label),
      neg: rowsOf.map((x) => x.r.worse), mid: rowsOf.map((x) => x.r.same), pos: rowsOf.map((x) => x.r.improved),
      labels: { neg: t.trendWorse, mid: t.trendSame, pos: t.trendImproved },
      colors: { neg: outcomeColor('einstufung', 'down'), mid: NEUTRAL, pos: outcomeColor('einstufung', 'up') },
    },
  }];
  const table = byLevel.length + byGroup.length > 1 ? {
    head: ['', t.trendCoachees, t.trendImproved, t.trendSame, t.trendWorse, t.trendAvg],
    widths: [0.34, 0.16, 0.12, 0.12, 0.12, 0.14],
    rows: [
      ...(byLevel.length > 1 ? byLevel.map((r) => [levelKeyLabel(r.key, lang), int(r.coachees), int(r.improved), int(r.same), int(r.worse), trendAvgText(r)]) : []),
      ...(byGroup.length > 1 ? byGroup.map((r) => [groupKeyLabel(r.key, lang), int(r.coachees), int(r.improved), int(r.same), int(r.worse), trendAvgText(r)]) : []),
    ],
  } : undefined;
  return {
    title,
    subtitle: subtitle ?? t.trendHint,
    // Four tiles, one row: the count of coachees rides on the mean change.
    tiles: [
      { label: t.trendImproved, value: int(tr.improved), sub: pctText(pct(tr.improved, tr.coachees)) },
      { label: t.trendSame, value: int(tr.same), sub: pctText(pct(tr.same, tr.coachees)) },
      { label: t.trendWorse, value: int(tr.worse), sub: pctText(pct(tr.worse, tr.coachees)) },
      { label: t.trendAvg, value: trendAvgText(tr), sub: `${t.trendCoachees}: ${int(tr.coachees)}` },
    ],
    figures,
    table,
    note: t.trendBand,
  };
}

/** One set of slides per slice with observations: an overview table first,
 *  then per slice its numbers, its grades and its assessments. A figure with
 *  nothing in it is left off, and a slide left with nothing is not made. */
function sliceSets(slices: StatSlice[], dim: 'level' | 'group', t: StatStrings, lang: Lang, subSlices: StatSlice[] = []): DeckSlide[] {
  const withObs = slices.filter((x) => x.stats.totals.observations > 0);
  if (withObs.length === 0) return [];
  const label = (key: string) => (dim === 'level' ? levelKeyLabel(key, lang) : groupKeyLabel(key, lang));
  const titleOf = (key: string) => (dim === 'level' ? t.deckSetLevel(label(key)) : t.deckSetGroup(label(key)));
  const row = (x: StatSlice) => {
    const T = x.stats.totals;
    const o = x.stats.outcomes;
    return [
      label(x.key), int(T.observations), `${int(T.coachees)} / ${int(T.roster)}`,
      gradeText(gradeAvg(T.grade), t, T.grade.obs),
      pctText(pct(o.einstufung.up ?? 0, sumOf(o.einstufung))),
      pctText(pct(o.secondBesuch.Y ?? 0, sumOf(o.secondBesuch))),
      trendCounts(x.stats.trend),
    ];
  };
  const head = [dim === 'level' ? t.byLevel : t.byGroup, t.observations, t.compareCoverage, t.gradeCol, t.comparePromotionHint, t.compareFurther, t.trendCol];
  const widths = [0.2, 0.12, 0.13, 0.15, 0.14, 0.13, 0.13];
  const out: DeckSlide[] = [{
    title: dim === 'level' ? t.deckSetsLevel : t.deckSetsGroup,
    subtitle: t.deckSetsHint,
    table: { head, widths, rows: slices.filter((x) => x.stats.totals.observations > 0 || x.stats.totals.roster > 0).map(row) },
  }];
  for (const x of withObs) {
    const S = x.stats;
    const T = S.totals;
    const title = titleOf(x.key);
    const avg = gradeAvg(T.grade);
    const o = S.outcomes;
    // 1 — the numbers
    const subs = dim === 'level' ? subSlices.filter((y) => y.key.startsWith(`${x.key}-`) && y.stats.totals.observations > 0) : [];
    out.push({
      title,
      subtitle: t.deckNumbers,
      tiles: [
        { label: t.observations, value: int(T.observations), sub: T.games ? t.games(T.games) : undefined },
        { label: t.coacheesVisited, value: `${int(T.coachees)} / ${int(T.roster)}`, sub: pctText(pct(T.coachees, T.roster)) },
        { label: t.avgGrade, value: gradeText(avg, t, T.grade.obs), sub: t.normalCase },
        { label: t.comparePromotionHint, value: pctText(pct(o.einstufung.up ?? 0, sumOf(o.einstufung))) },
        { label: t.compareFurtherHint, value: pctText(pct(o.secondBesuch.Y ?? 0, sumOf(o.secondBesuch))) },
        ...(S.trend && S.trend.coachees > 0 ? [{ label: t.trendTitle, value: trendCounts(S.trend), sub: `${t.trendAvg} ${trendAvgText(S.trend)}` }] : []),
      ],
      table: subs.length > 1 ? { head, widths, rows: subs.map(row) } : undefined,
    });
    // 2 — the grades
    const gradeFigures: DeckFigure[] = [];
    if (sumOf(S.histogram) > 0) {
      gradeFigures.push({ title: t.histogram, chart: { kind: 'bars', categories: GRADE_ORDER, values: GRADE_ORDER.map((g) => S.histogram[g] ?? 0) } });
    }
    for (const role of ['1SR', '2SR'] as StatRole[]) {
      const rows = S.sections.filter((sec) => sec.role === role && gradeAvg(sec.grade) !== null);
      if (!rows.length) continue;
      gradeFigures.push({
        title: `${t.sections} · ${roleLabel(role, lang)}`,
        chart: { kind: 'grade', categories: rows.map((sec) => sectionTitle(role, sec.section, lang)), values: rows.map((sec) => gradeAvg(sec.grade)), ns: rows.map((sec) => sec.grade.obs) },
      });
    }
    if (gradeFigures.length) out.push({ title, subtitle: t.secGrades, figures: gradeFigures.slice(0, 3), note: `${t.normalCase} · ${t.thinNote}` });
    // 3 — the assessments
    const donuts = outcomeFigures(S, t, lang, true);
    if (donuts.length) out.push({ title, subtitle: t.outcomes, figures: donuts });
    // 4 — the trend, when a coachee in it was seen twice
    const tr = trendSlideOf(S, t, lang, title, t.trendTitle);
    if (tr) out.push(tr);
  }
  return out;
}

export function deckFileName(stats: SeasonStatistics, ext: 'pptx' | 'pdf'): string {
  return `svrz-rc-statistik-${seasonName(stats.season).replace('/', '-')}-${stats.generatedAt.slice(0, 10)}.${ext}`;
}

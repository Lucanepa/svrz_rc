// Admin → Statistik: the season in numbers. One request per season + filter
// slice (the server aggregates, src/lib/statistics.ts is the shape), tiles
// and charts from it, and an export that turns the same numbers into a
// PowerPoint deck or a PDF (src/lib/statsDeck.ts).
import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, FileText, Loader2, Presentation } from 'lucide-react';
import { cn } from '../lib/utils';
import { importFresh } from '../lib/freshImport';
import type { Lang } from '../lib/appTime';
import { dayLabel } from '../lib/appTime';
import { listRcPeopleFull, loadStatistics, type RcPerson } from '../lib/pocketbase';
import {
  a4Pages, estimatedHours, gradeAvg, isThin, pct, scoreToLetter, trendAvgDelta, withRcFirstNames, GRADE_ORDER, GRADE_LETTERS,
  type SeasonStatistics, type TrendAgg, type StatBucket, type StatFilters, type StatRole, type StatisticsResponse,
} from '../lib/statistics';
import {
  categoryLabel, criterionLabel, divisionLabel, groupKeyLabel, levelKeyLabel, monthLabel, OUTCOME_ORDER, outcomeColor, outcomeLabel,
  roleLabel, sectionCount, sectionTitle, seasonName, statStrings, weekdayKeyLabel,
} from '../lib/statsLabels';
import { SECTIONS_1SR_DE, SECTIONS_2SR_DE } from '../types';
import { buildDeck, deckFileName } from '../lib/statsDeck';
import { BarList, ColumnChart, DivergingBars, GradeLine, GradeScale, HBarChart, SEQ_BLUE, SERIES, Sparkline, StackBar, StatTile, fmtDec, fmtInt, type BarRow, type ScaleRow } from './StatsCharts';

const select = 'h-9 px-2.5 text-sm rounded-lg border border-stone-300 bg-white focus:outline-none focus:ring-2 focus:ring-red-500 max-w-full';
const btn = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-40 transition-colors';

function Card({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <div data-testid={testId} className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">{children}</div>;
}

/** One group of related figures: a card with its own heading, the blocks inside. */
function Section({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section data-testid={testId} className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 className="text-sm font-semibold text-stone-800">{title}</h2>
        {hint && <p className="text-xs text-stone-400">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

/** Twelve columns from lg up, one below — every block names its span. */
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-stretch">{children}</div>;
}

/** One figure: a tinted panel with a heading, and an optional control beside it. */
function Block({ title, hint, children, testId, span, aside }: { title: string; hint?: string; children: React.ReactNode; testId?: string; span?: string; aside?: React.ReactNode; key?: React.Key }) {
  return (
    <div data-testid={testId} className={cn('rounded-xl border border-stone-200/70 bg-stone-50/60 p-3.5 min-w-0 flex flex-col', span)}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-stone-700">{title}</h3>
          {hint && <p className="text-[11px] text-stone-400">{hint}</p>}
        </div>
        {aside}
      </div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function SubHead({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold text-stone-500 mb-1.5">{children}</div>;
}

/** A small figure inside a block — label over value, no chrome of its own. */
function MiniStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-white border border-stone-200/70 px-2.5 py-2 min-w-0">
      <div className="text-[10px] text-stone-400 leading-tight">{label}</div>
      <div className="text-sm font-semibold text-stone-800 tabular-nums leading-tight mt-0.5">{value}</div>
    </div>
  );
}

function KV({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-stone-500 leading-snug">{k}</dt>
          <dd className="text-stone-800 font-medium tabular-nums text-right leading-snug">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

const pctText = (p: number | null) => (p === null ? '–' : `${fmtDec(p, 0)} %`);
const delta = (cur: number, prev: number | undefined): string | null => {
  if (prev === undefined) return null;
  const d = cur - prev;
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmtInt(Math.abs(d))}`;
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function StatisticsAdmin({ lang, defaultSeason, settingsLoading, active }: { lang: Lang; defaultSeason: number; settingsLoading: boolean; active: boolean }) {
  const t = statStrings(lang);
  const [season, setSeason] = useState<number | null>(null);
  const [filters, setFilters] = useState<StatFilters>({});
  const [compare, setCompare] = useState(true);
  const [data, setData] = useState<StatisticsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [criteriaRole, setCriteriaRole] = useState<StatRole>('1SR');
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<'pptx' | 'pdf' | null>(null);
  const [includeRcGrades, setIncludeRcGrades] = useState(false);
  const [includeLeagues, setIncludeLeagues] = useState(false);
  const [includeSlices, setIncludeSlices] = useState(true);
  // The deck's language is chosen at export time; it starts as the console's.
  const [exportLang, setExportLang] = useState<Lang>(lang);
  useEffect(() => { setExportLang(lang); }, [lang]);
  // The request is heavier than the other tabs' (four full lists on the
  // server), so it waits for the first time the tab is actually opened —
  // and then stays loaded across tab switches.
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (active) setArmed(true); }, [active]);
  // The RC records, for first names (withRcFirstNames). A failure only costs
  // the precision: the names then fall back to the first word of the full one.
  const [people, setPeople] = useState<RcPerson[] | null>(null);
  useEffect(() => {
    if (!armed || people) return;
    listRcPeopleFull().then(setPeople).catch(() => setPeople([]));
  }, [armed, people]);
  // The bottom bar: no filter, or a slice by level (N3, then N3-2) or by group.
  const [dim, setDim] = useState<'none' | 'level' | 'group'>('none');

  const effectiveSeason = season ?? defaultSeason;
  useEffect(() => {
    if (settingsLoading || !armed) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    // breakdown=1: the per-level and per-group slices ride along (the
    // comparison table and the deck read them). An older API ignores it.
    loadStatistics(effectiveSeason, filters, compare, true)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [settingsLoading, armed, effectiveSeason, filters, compare]);

  const view = useMemo(() => (data ? withRcFirstNames(data, people ?? []) : null), [data, people]);
  const stats = view?.stats ?? null;
  const options = view?.options ?? null;
  const rcNames = useMemo(() => Object.fromEntries((options?.rcs ?? []).map((r) => [r.id, r.name])), [options]);

  const runExport = async (kind: 'pptx' | 'pdf') => {
    if (!stats) return;
    setExporting(kind);
    try {
      const deck = buildDeck(stats, { lang: exportLang, includeRcGrades, includeLeagues, rcNames, breakdowns: view?.breakdowns, skipSlices: !includeSlices });
      if (kind === 'pptx') {
        const { buildDeckPptx } = await importFresh(() => import('../lib/statsPptx'));
        download(await buildDeckPptx(deck), deckFileName(stats, 'pptx'));
      } else {
        const { buildDeckPdf } = await importFresh(() => import('../lib/statsPdf'));
        download(buildDeckPdf(deck), deckFileName(stats, 'pdf'));
      }
    } catch (e) {
      setError(`${t.exportFailed}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(null);
    }
  };

  const setFilter = (key: keyof StatFilters, value: string) => {
    setFilters((f) => {
      const next = { ...f };
      if (value) (next as Record<string, string>)[key] = value; else delete next[key];
      return next;
    });
  };

  const chooseDim = (d: 'none' | 'level' | 'group') => {
    setDim(d);
    setFilters((f) => {
      if (!f.level && !f.group) return f;
      const next = { ...f };
      delete next.level;
      delete next.group;
      return next;
    });
  };
  const allLevels = options?.levels ?? [];
  const niveaus = allLevels.filter((l) => !l.includes('-'));
  const selNiv = filters.level ? filters.level.split('-')[0] : '';
  const stufen = selNiv ? allLevels.filter((l) => l.startsWith(`${selNiv}-`)) : [];
  // The slices the comparison table lines up: the Niveaus, or the Stufen of
  // the one picked; or every group.
  const cmpValues = useMemo(() => (
    dim === 'level' ? (selNiv ? (stufen.length ? stufen : [selNiv]) : niveaus)
      : dim === 'group' ? (options?.groups ?? [])
        : []
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [dim, selNiv, allLevels.join('|'), (options?.groups ?? []).join('|')]);
  const cmpSig = JSON.stringify([effectiveSeason, filters.rc ?? '', filters.role ?? '', dim, cmpValues]);
  const [cmp, setCmp] = useState<{ sig: string; rows: Array<{ key: string; stats: SeasonStatistics }> } | null>(null);
  const [cmpLoading, setCmpLoading] = useState(false);
  const breakdowns = view?.breakdowns ?? null;
  useEffect(() => {
    // The server sent the slices with the main answer: nothing to fetch.
    if (breakdowns) return;
    if (dim === 'none' || !armed || settingsLoading || cmpValues.length === 0) return;
    let cancelled = false;
    setCmpLoading(true);
    // One request per slice, the rest of the filters kept: the server's rows
    // are cached for a minute, so this is a handful of cheap counts.
    const base: StatFilters = { ...(filters.rc ? { rc: filters.rc } : {}), ...(filters.role ? { role: filters.role } : {}) };
    Promise.all(cmpValues.map((v) => loadStatistics(effectiveSeason, { ...base, [dim]: v }, false).then((r) => ({ key: v, stats: r.stats }))))
      .then((rows) => { if (!cancelled) setCmp({ sig: cmpSig, rows }); })
      .catch(() => { if (!cancelled) setCmp({ sig: cmpSig, rows: [] }); })
      .finally(() => { if (!cancelled) setCmpLoading(false); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpSig, armed, settingsLoading, !!breakdowns]);
  const cmpRows = (() => {
    if (breakdowns) {
      const list = dim === 'group' ? breakdowns.group
        : dim === 'level' ? (selNiv
          ? (breakdowns.stufe.some((x) => x.key.startsWith(`${selNiv}-`)) ? breakdowns.stufe.filter((x) => x.key.startsWith(`${selNiv}-`)) : breakdowns.level.filter((x) => x.key === selNiv))
          : breakdowns.level)
          : [];
      return list.map((x) => ({ key: x.key, stats: x.stats as SeasonStatistics }));
    }
    return cmp && cmp.sig === cmpSig ? cmp.rows : null;
  })();

  const seasons = options?.seasons ?? [effectiveSeason];
  const T = stats?.totals;
  const P = stats?.previous?.totals;
  const prevName = stats?.previous ? seasonName(stats.previous.season) : '';
  const avg = T ? gradeAvg(T.grade) : null;

  // With a filter on, a figure with nothing in it is left out rather than
  // drawn as an empty chart or a row of zeros — and a section with nothing
  // left in it goes too.
  const filtered = !!(filters.rc || filters.group || filters.level || filters.role);
  const keep = (rows: BarRow[]) => (filtered ? rows.filter((r) => r.value > 0) : rows);
  const keepScale = (rows: ScaleRow[]) => (filtered ? rows.filter((r) => r.avg !== null) : rows);
  const sum = (d: Record<string, number>) => Object.values(d).reduce((a, n) => a + n, 0);

  // Level: a Niveau, then (when it has them) one of its Stufen. Tapping the
  // chosen one again steps back — a Stufe to its Niveau, a Niveau to none.
  const pickLevel = (v: string) => {
    if (filters.level === v) setFilter('level', v.includes('-') ? v.split('-')[0] : '');
    else setFilter('level', v);
  };
  const pickGroup = (v: string) => setFilter('group', filters.group === v ? '' : v);
  const body = (() => {
    if (!stats || !T) return null;
    // ── Observations
    const monthsAny = stats.byMonth.some((b) => b.observations > 0);
    const coverageRows = keep(['0', '1', '2', '3+'].map((k) => ({ key: k, label: t.visits(k), value: stats.coacheeVisits[k] ?? 0 })));
    const roleRows = keep(stats.byRole.map((b) => bucketRow(b, roleLabel(b.key, lang), t)));
    const rcRows = stats.byRc.filter((r) => r.observations > 0 || (!filtered && r.goal > 0));
    const groupRows = keep(stats.byGroup.map((b) => bucketRow(b, groupKeyLabel(b.key, lang), t)));
    // One Niveau picked: its bar would be the whole chart, so only its Stufen stay.
    const levelRows = filters.level ? [] : keep(stats.byLevel.map((b) => bucketRow(b, levelKeyLabel(b.key, lang), t)));
    // Each Niveau as a whole, then its Stufen under it. A Niveau with no
    // Stufen (N1) is one row; a Stufe that is its own Niveau is not repeated.
    const stufeRows = keepScale(stats.byLevel.flatMap((lv) => {
      const subs = stats.byStufe.filter((b) => b.key !== lv.key && b.key.startsWith(`${lv.key}-`));
      return [
        { key: `lv-${lv.key}`, label: levelKeyLabel(lv.key, lang), avg: gradeAvg(lv.grade), n: lv.observations, strong: subs.length > 0 },
        ...subs.map((b) => ({ key: b.key, label: levelKeyLabel(b.key, lang), avg: gradeAvg(b.grade), n: b.observations, indent: true })),
      ];
    }));
    const showMonths = !filtered || monthsAny;
    const showObservations = showMonths || coverageRows.length > 0 || roleRows.length > 0 || rcRows.length > 0 || groupRows.length > 0 || levelRows.length > 0 || stufeRows.length > 0;
    // ── Grades
    const showHistogram = !filtered || sum(stats.histogram) > 0;
    const roleScale = keepScale(stats.byRole.map((b) => ({ key: b.key, label: roleLabel(b.key, lang), avg: gradeAvg(b.grade), n: b.observations })));
    const showGradeSummary = !filtered || avg !== null;
    const sectionRows = (['1SR', '2SR'] as StatRole[]).map((role) => ({
      role,
      rows: keepScale(stats.sections.filter((s) => s.role === role).map((s) => ({ key: `${role}-${s.section}`, label: sectionTitle(role, s.section, lang), avg: gradeAvg(s.grade), n: s.grade.obs }))),
    })).filter((x) => !filtered || x.rows.length > 0);
    const criteriaFor = (role: StatRole) => Array.from({ length: sectionCount(role) }, (_, sectionIndex) => {
      const form = role === '2SR' ? SECTIONS_2SR_DE : SECTIONS_1SR_DE;
      const rows = keepScale(form[sectionIndex].items.map((item) => {
        const c = stats.criteria.find((x) => x.role === role && x.id === item.id);
        return { key: item.id, label: criterionLabel(role, item.id, lang), avg: c ? gradeAvg(c.grade) : null, n: c?.grade.obs ?? 0 };
      }));
      return { sectionIndex, rows };
    }).filter((x) => !filtered || x.rows.length > 0);
    const criteriaRoles = (['1SR', '2SR'] as StatRole[]).filter((role) => !filtered || criteriaFor(role).length > 0);
    const shownCriteriaRole: StatRole | null = criteriaRoles.includes(criteriaRole) ? criteriaRole : (criteriaRoles[0] ?? null);
    const gradeMonths = stats.byMonth.map((b) => ({ key: b.key, label: monthLabel(b.key, lang), value: gradeAvg(b.grade), n: b.observations, hint: `${monthLabel(b.key, lang)} ${b.key.slice(0, 4)}` }));
    const showGrades = showHistogram || showGradeSummary || sectionRows.length > 0 || shownCriteriaRole !== null;
    // ── Assessments
    const outcomeKinds = (['einstufung', 'motivation', 'spielniveau', 'secondBesuch'] as const).filter((kind) => !filtered || sum(stats.outcomes[kind]) > 0);
    // ── Games
    const showGamesBlock = !filtered || T.games > 0;
    const leagueRows = keep(stats.byLeague.slice(0, 10).map((b) => ({ key: b.key || '-', label: b.label || '–', value: b.observations })));
    const categoryRows = keep(stats.byCategory.map((b) => ({ key: b.key || '-', label: categoryLabel(b.key, lang), value: b.observations })));
    const divisionRows = keep(stats.byDivision.map((b) => ({ key: b.key || '-', label: divisionLabel(b.key, lang), value: b.observations })));
    const weekdayRows = keep(stats.byWeekday.map((b) => ({ key: b.key, label: weekdayKeyLabel(b.key, lang), value: b.observations })));
    const hourRows = keep(stats.byHour.map((b) => ({ key: b.key, label: `${b.key}:00`, value: b.observations })));
    const showLeagues = leagueRows.length + categoryRows.length + divisionRows.length > 0;
    const showWhen = weekdayRows.length + hourRows.length > 0;
    const showGames = showGamesBlock || showLeagues || showWhen;
    // ── Writing & process
    const hasObs = !filtered || T.observations > 0;
    const F = stats.fun;
    const showFun = !filtered || !!(F.busiestDay || F.topHall || F.topCoachee || F.topWriter || F.first);
    const showWriting = hasObs || showFun;

    return (
        <div className={cn('space-y-4 transition-opacity', loading && 'opacity-60')} data-testid="stats-body">
          {/* ── Overview ── */}
          <Section title={t.secOverview} hint={t.secOverviewHint} testId="stats-overview">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3" data-testid="stats-tiles">
              <StatTile hero label={t.observations} value={fmtInt(T.observations)} sub={T.games ? t.games(T.games) : undefined} delta={P ? delta(T.observations, P.observations) : null} deltaLabel={t.deltaVs(prevName)}
                spark={<Sparkline values={stats.byMonth.map((b) => b.observations)} title={`${t.perMonth}: ${stats.byMonth.map((b) => `${monthLabel(b.key, lang)} ${b.observations}`).join(', ')}`} />} />
              <StatTile label={t.coacheesVisited} value={`${fmtInt(T.coachees)} / ${fmtInt(T.roster)}`} sub={pctText(pct(T.coachees, T.roster))} delta={P ? delta(T.coachees, P.coachees) : null} deltaLabel={t.deltaVs(prevName)} />
              <StatTile label={t.activeRcs} value={`${fmtInt(T.rcsActive)} / ${fmtInt(T.rcsTotal)}`} sub={`${t.pensum} ${pctText(pct(T.observations, T.goal))}`} />
              <StatTile label={t.avgGrade} value={avg === null ? '–' : <><span className={isThin(T.grade.obs) ? 'text-stone-600' : undefined}>{scoreToLetter(avg)}</span> <span className="text-base font-medium text-stone-500">{fmtDec(avg)}</span></>} sub={isThin(T.grade.obs) ? `${t.tooFew(T.grade.obs)} · ${t.normalCase}` : t.normalCase} delta={P && avg !== null && gradeAvg(P.grade) !== null ? `${avg - gradeAvg(P.grade)! >= 0 ? '+' : ''}${fmtDec(avg - gradeAvg(P.grade)!)}` : null} deltaLabel={t.deltaVs(prevName)} />
              <StatTile label={t.sets} value={fmtInt(T.sets)} sub={T.games ? `${fmtDec(T.sets / T.games)} ${t.setsPerGame}` : undefined} delta={P ? delta(T.sets, P.sets) : null} deltaLabel={t.deltaVs(prevName)} />
              <StatTile label={t.points} value={fmtInt(T.points)} sub={t.hours(estimatedHours(T.sets))} delta={P ? delta(T.points, P.points) : null} deltaLabel={t.deltaVs(prevName)} />
              <StatTile label={t.words} value={fmtInt(T.words)} sub={T.observations ? `${t.perObs} ${fmtInt(T.words / T.observations)}` : undefined} delta={P ? delta(T.words, P.words) : null} deltaLabel={t.deltaVs(prevName)} />
            </div>
            {T.observations === 0 && <p className="mt-3 text-sm text-stone-400">{t.none}</p>}
          </Section>

          {/* ── Observations: when, by whom, of whom ── */}
          {showObservations && (
          <Section title={t.secObservations} hint={t.secObservationsHint} testId="stats-section-observations">
            <Grid>
              {showMonths && (
              <Block span="lg:col-span-5" title={t.perMonth} hint={`${t.role1} / ${t.role2}`} testId="stats-months">
                {/* Time runs left to right: eight months fit a phone as columns. */}
                <ColumnChart
                  series={[t.role1, t.role2]}
                  slotWidth={32}
                  data={stats.byMonth.map((b) => ({ key: b.key, label: monthLabel(b.key, lang), values: [b.roles['1SR'], b.roles['2SR']], hint: `${monthLabel(b.key, lang)} ${b.key.slice(0, 4)}` }))}
                />
              </Block>
              )}
              {coverageRows.length > 0 && (
              <Block span="lg:col-span-3" title={t.coverage} hint={t.coverageHint} testId="stats-coverage">
                {/* Part of the roster by visits: one bar, lighter = fewer visits. */}
                <StackBar segments={['0', '1', '2', '3+'].map((k, i) => ({ key: k, label: t.visits(k), value: stats.coacheeVisits[k] ?? 0, color: SEQ_BLUE[i] })).filter((x) => !filtered || x.value > 0)} />
                <p className="mt-3 text-[11px] text-stone-500">{t.coacheesVisited}: <b className="text-stone-700">{fmtInt(T.coachees)} / {fmtInt(T.roster)}</b> · {pctText(pct(T.coachees, T.roster))}</p>
              </Block>
              )}
              {roleRows.length > 0 && (
              <Block span="lg:col-span-4" title={t.role} hint={t.observations} testId="stats-roles">
                <StackBar segments={stats.byRole.map((b, i) => ({ key: b.key, label: roleLabel(b.key, lang), value: b.observations, color: SERIES[i] })).filter((x) => !filtered || x.value > 0)} />
              </Block>
              )}
              {rcRows.length > 0 && (
              <Block span="lg:col-span-12" title={t.perRc} testId="stats-rcs">
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-stone-400">
                        <th className="text-left font-medium py-1.5 px-1 align-bottom">{t.rc}</th>
                        <th className="text-right font-medium py-1.5 px-1 align-bottom" title={t.observations}><span className="sm:hidden">{t.compareObs}</span><span className="hidden sm:inline">{t.observations}</span></th>
                        <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom">{t.coacheesCol}</th>
                        <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom">{t.gamesCol}</th>
                        <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom">{t.setsCol}</th>
                        <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom">{t.wordsCol}</th>
                        <th className="text-right font-medium py-1.5 px-1 align-bottom">{t.gradeCol}</th>
                        <th className="text-left font-medium py-1.5 pl-2 sm:pl-3 sm:min-w-[9rem] align-bottom">{t.goalCol}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rcRows.map((r) => {
                        const a = gradeAvg(r.grade);
                        const fill = r.goal > 0 ? Math.min(100, (r.observations / r.goal) * 100) : 0;
                        return (
                          <tr key={r.key} className="border-t border-stone-100">
                            <td className="py-1.5 px-1 text-stone-800 leading-tight">
                              {r.label}
                              {/* The columns a phone has no room for, as one line under the name. */}
                              {r.observations > 0 && <span className="sm:hidden block text-[10px] text-stone-400 tabular-nums">{fmtInt(r.coachees)} {t.coacheesCol} · {fmtInt(r.games)} {t.gamesCol} · {fmtInt(r.sets)} {t.setsCol}</span>}
                            </td>
                            <td className="py-1.5 px-1 text-right tabular-nums font-semibold">{fmtInt(r.observations)}</td>
                            <td className="hidden sm:table-cell py-1.5 px-1 text-right tabular-nums">{fmtInt(r.coachees)}</td>
                            <td className="hidden sm:table-cell py-1.5 px-1 text-right tabular-nums">{fmtInt(r.games)}</td>
                            <td className="hidden sm:table-cell py-1.5 px-1 text-right tabular-nums">{fmtInt(r.sets)}</td>
                            <td className="hidden sm:table-cell py-1.5 px-1 text-right tabular-nums">{fmtInt(r.words)}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums whitespace-nowrap" title={a === null ? '–' : `${fmtDec(a)} · ${t.nObs(r.observations)}`}>{a === null ? <span className="text-stone-400">–</span> : <><b className={isThin(r.observations) ? 'text-stone-600' : undefined}>{scoreToLetter(a)}</b> <span className="hidden sm:inline text-stone-500">{fmtDec(a)}</span>{isThin(r.observations) && <span className="hidden sm:inline text-stone-400"> · n = {r.observations}</span>}</>}</td>
                            <td className="py-1.5 pl-2 sm:pl-3">
                              <div className="flex items-center gap-2" title={`${fmtInt(r.observations)} / ${fmtInt(r.goal)} · ${r.planned} ${t.planned} · ${r.outstanding} ${t.outstanding}`}>
                                <span className="h-2 flex-1 min-w-[1.5rem] sm:min-w-[4rem] rounded-full bg-stone-100 overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${fill}%`, background: fill >= 100 ? '#1f7a4d' : '#2a78d6' }} /></span>
                                <span className="tabular-nums text-stone-500 whitespace-nowrap">{fmtInt(r.observations)}/{fmtInt(r.goal)}</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Block>
              )}
              {groupRows.length > 0 && (
              <Block span="lg:col-span-6" title={t.perGroup} hint={t.observations} testId="stats-groups">
                <BarList rows={groupRows} />
              </Block>
              )}
              {(levelRows.length > 0 || stufeRows.length > 0) && (
              <Block span="lg:col-span-6" title={t.perLevel} hint={t.observations} testId="stats-levels">
                {levelRows.length > 0 && <BarList rows={levelRows} />}
                {stufeRows.length > 0 && (
                  <div className={levelRows.length > 0 ? 'mt-4' : undefined}>
                    <SubHead>{t.perLevelStufe}</SubHead>
                    <GradeScale rows={stufeRows} nLabel={t.nObs} />
                  </div>
                )}
              </Block>
              )}
            </Grid>
          </Section>
          )}

          {/* ── Grades ── */}
          {showGrades && (
          <Section title={t.secGrades} hint={t.secGradesHint} testId="stats-section-grades">
            <Grid>
              {showHistogram && (
              <Block span="lg:col-span-7" title={t.histogram} hint={t.histogramHint} testId="stats-histogram">
                {/* A+ … E− top to bottom, a letter's three grades together; the ±
                    grades in the soft tint. With a filter on, a letter nobody
                    was given is left out whole. */}
                <HBarChart
                  series={[t.histogram]}
                  data={GRADE_ORDER
                    .filter((g) => !filtered || GRADE_ORDER.some((h) => h[0] === g[0] && (stats.histogram[h] ?? 0) > 0))
                    .map((g, i, list) => ({ key: g, label: g.replace('-', '−'), values: [stats.histogram[g] ?? 0], soft: !GRADE_LETTERS.includes(g), gapBefore: i > 0 && list[i - 1][0] !== g[0] }))}
                />
              </Block>
              )}
              {showGradeSummary && (
              <Block span="lg:col-span-5" title={t.avgGrade} hint={t.normalCase} testId="stats-grade-summary">
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label={t.avgGrade} value={avg === null ? '–' : `${scoreToLetter(avg)} · ${fmtDec(avg)}${isThin(T.grade.obs) ? ` (n = ${T.grade.obs})` : ''}`} />
                  <MiniStat label={t.shareC} value={pctText(pct(T.ratingsC, T.ratingsAll))} />
                  <MiniStat label={t.shareB} value={pctText(pct(T.ratingsBPlus, T.ratingsAll))} />
                </div>
                {roleScale.length > 0 && (
                  <div className="mt-4">
                    <SubHead>{t.avgGrade} · {t.role}</SubHead>
                    <GradeScale rows={roleScale} nLabel={t.nObs} />
                  </div>
                )}
                <p className="mt-3 text-[11px] text-stone-500">{t.completeness}: <b className="text-stone-700">{pctText(pct(T.ratedItems, T.offeredItems))}</b></p>
              </Block>
              )}
              {gradeMonths.some((p) => p.value !== null) && (
              <Block span="lg:col-span-12" title={t.gradePerMonth} hint={`${t.normalCase} · ${t.thinNote}`} testId="stats-grade-month">
                <GradeLine points={gradeMonths} nLabel={t.nObs} />
              </Block>
              )}
              {sectionRows.length > 0 && (
              <Block span="lg:col-span-5" title={t.sections} hint={t.normalCase} testId="stats-sections">
                {sectionRows.map(({ role, rows }) => (
                  <div key={role} className="mb-4 last:mb-0">
                    <SubHead>{roleLabel(role, lang)}</SubHead>
                    {rows.length ? <GradeScale rows={rows} nLabel={t.nObs} /> : <p className="text-xs text-stone-400">–</p>}
                  </div>
                ))}
              </Block>
              )}
              {shownCriteriaRole && (
              <Block span="lg:col-span-7" title={t.criteria} hint={t.normalCase} testId="stats-criteria"
                aside={criteriaRoles.length > 1 ? (
                  <div className="inline-flex rounded-lg border border-stone-200 p-0.5 text-xs bg-white">
                    {criteriaRoles.map((role) => (
                      <button key={role} type="button" onClick={() => setCriteriaRole(role)} className={cn('px-2.5 h-7 rounded-md', shownCriteriaRole === role ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-100')}>{roleLabel(role, lang)}</button>
                    ))}
                  </div>
                ) : <span className="text-xs text-stone-500">{roleLabel(shownCriteriaRole, lang)}</span>}>
                {criteriaFor(shownCriteriaRole).map(({ sectionIndex, rows }) => (
                  <div key={sectionIndex} className="mb-4 last:mb-0">
                    <SubHead>{sectionTitle(shownCriteriaRole, sectionIndex, lang)}</SubHead>
                    <GradeScale rows={rows} nLabel={t.nObs} />
                  </div>
                ))}
              </Block>
              )}
            </Grid>
          </Section>
          )}

          {/* ── Trend: first visit against the latest, per coachee ── */}
          {stats.trend && (stats.trend.coachees > 0 || !filtered) && (
          <Section title={t.trendTitle} hint={t.trendHint} testId="stats-trend">
            {stats.trend.coachees === 0 ? <p className="text-sm text-stone-400">{t.trendNone}</p> : (
            <Grid>
              <Block span="lg:col-span-4" title={t.trendTitle} hint={t.trendBand} testId="stats-trend-total">
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <MiniStat label={t.trendCoachees} value={fmtInt(stats.trend.coachees)} />
                  <MiniStat label={t.trendAvg} value={(() => { const d = trendAvgDelta(stats.trend); return d === null ? '–' : `${d > 0 ? '+' : ''}${fmtDec(d)}`; })()} />
                </div>
                <DivergingBars
                  rows={[{ key: 'all', label: t.trendCoachees, neg: stats.trend.worse, mid: stats.trend.same, pos: stats.trend.improved }]}
                  colors={{ neg: TREND_COLOR.worse, mid: '#d6d3d1', pos: TREND_COLOR.improved }}
                  labels={{ neg: t.trendWorse, mid: t.trendSame, pos: t.trendImproved }}
                />
              </Block>
              {stats.trend.byLevel.length > 0 && (
              <Block span="lg:col-span-4" title={`${t.trendTitle} · ${t.byLevel}`} testId="stats-trend-level">
                <DivergingBars rows={stats.trend.byLevel.map((r) => trendRow(r, levelKeyLabel(r.key, lang)))} colors={{ neg: TREND_COLOR.worse, mid: '#d6d3d1', pos: TREND_COLOR.improved }} labels={{ neg: t.trendWorse, mid: t.trendSame, pos: t.trendImproved }} />
              </Block>
              )}
              {stats.trend.byGroup.length > 0 && (
              <Block span="lg:col-span-4" title={`${t.trendTitle} · ${t.byGroup}`} testId="stats-trend-group">
                <DivergingBars rows={stats.trend.byGroup.map((r) => trendRow(r, groupKeyLabel(r.key, lang)))} colors={{ neg: TREND_COLOR.worse, mid: '#d6d3d1', pos: TREND_COLOR.improved }} labels={{ neg: t.trendWorse, mid: t.trendSame, pos: t.trendImproved }} />
              </Block>
              )}
            </Grid>
            )}
          </Section>
          )}

          {/* ── Assessments ── */}
          {outcomeKinds.length > 0 && (
          <Section title={t.secOutcomes} hint={t.secOutcomesHint} testId="stats-section-outcomes">
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* Einstufung and motivation are the form's ↑ ✓ ↓: centred on ✓,
                  down to the left, up to the right, so the two rows compare. */}
              {outcomeKinds.some((k) => k === 'einstufung' || k === 'motivation') && (
              <Block title={`${t.einstufung} · ${t.motivation}`} testId="stats-einstufung">
                <DivergingBars
                  rows={outcomeKinds.filter((k) => k === 'einstufung' || k === 'motivation').map((kind) => ({
                    key: kind,
                    label: kind === 'einstufung' ? t.einstufung : t.motivation,
                    neg: stats.outcomes[kind].down ?? 0, mid: stats.outcomes[kind].check ?? 0, pos: stats.outcomes[kind].up ?? 0,
                  }))}
                  colors={{ neg: outcomeColor('einstufung', 'down'), mid: '#d6d3d1', pos: outcomeColor('einstufung', 'up') }}
                  labels={{ neg: '↓', mid: '✓', pos: '↑' }}
                />
              </Block>
              )}
              {outcomeKinds.includes('spielniveau') && (
              <Block title={t.difficulty} testId="stats-spielniveau">
                <StackBar segments={OUTCOME_ORDER.spielniveau.map((k, i) => ({ key: k, label: outcomeLabel('spielniveau', k, lang), value: stats.outcomes.spielniveau[k] ?? 0, color: [SEQ_BLUE[0], SEQ_BLUE[2], SEQ_BLUE[3]][i] })).filter((x) => !filtered || x.value > 0)} />
              </Block>
              )}
              {outcomeKinds.includes('secondBesuch') && (
              <Block title={t.secondVisit} testId="stats-secondBesuch">
                <StackBar segments={OUTCOME_ORDER.secondBesuch.map((k) => ({ key: k, label: outcomeLabel('secondBesuch', k, lang), value: stats.outcomes.secondBesuch[k] ?? 0, color: k === 'Y' ? SERIES[0] : '#d6d3d1' })).filter((x) => !filtered || x.value > 0)} />
              </Block>
              )}
            </div>
          </Section>
          )}

          {/* ── Games ── */}
          {showGames && (
          <Section title={t.secGames} hint={t.secGamesHint} testId="stats-section-games">
            <Grid>
              {showGamesBlock && (
              <Block span="lg:col-span-4" title={t.gamesBlock} testId="stats-games">
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <MiniStat label={t.sets} value={fmtInt(T.sets)} />
                  <MiniStat label={t.points} value={fmtInt(T.points)} />
                  <MiniStat label={t.setsPerGame} value={T.games ? fmtDec(T.sets / T.games) : '–'} />
                  <MiniStat label={t.estHours} value={`≈ ${fmtInt(estimatedHours(T.sets))} h`} />
                </div>
                <KV rows={[
                  [t.deciders, `${fmtInt(T.deciders)} (${pctText(pct(T.deciders, T.games))})`],
                  [t.longestGame, T.longestGame ? `${fmtInt(T.longestGame.points)} · ${T.longestGame.sets} ${t.sets}` : '–'],
                  [t.hallsSeen, fmtInt(T.halls)],
                  [t.teamsSeen, fmtInt(T.teams)],
                ]} />
                {T.longestGame && <p className="mt-2 text-[11px] text-stone-400 truncate">{t.longestGame}: {T.longestGame.label}</p>}
              </Block>
              )}
              {showLeagues && (
              <Block span="lg:col-span-4" title={t.perLeague} hint={t.observations} testId="stats-leagues">
                {leagueRows.length > 0 && <BarList rows={leagueRows} />}
                {categoryRows.length > 0 && (
                  <div className="mt-4">
                    <SubHead>{categoryLabel('H', lang)} · {categoryLabel('D', lang)}</SubHead>
                    <StackBar segments={stats.byCategory.map((b, i) => ({ key: b.key || '-', label: categoryLabel(b.key, lang), value: b.observations, color: SERIES[i % SERIES.length] })).filter((x) => !filtered || x.value > 0)} />
                  </div>
                )}
                {divisionRows.length > 0 && (
                  <div className="mt-4">
                    <SubHead>{lang === 'DE' ? 'Liga' : 'League'}</SubHead>
                    <BarList rows={divisionRows} />
                  </div>
                )}
              </Block>
              )}
              {showWhen && (
              <Block span="lg:col-span-4" title={`${t.weekday} · ${t.hour}`} hint={t.observations} testId="stats-when">
                {weekdayRows.length > 0 && (<>
                  <SubHead>{t.weekday}</SubHead>
                  <div data-testid="stats-weekday"><ColumnChart series={[t.observations]} slotWidth={30} height={150} data={(filtered ? stats.byWeekday.filter((b) => b.observations > 0) : stats.byWeekday).map((b) => ({ key: b.key, label: weekdayKeyLabel(b.key, lang).slice(0, 2), values: [b.observations], hint: weekdayKeyLabel(b.key, lang) }))} /></div>
                </>)}
                {hourRows.length > 0 && (
                  <div className={weekdayRows.length > 0 ? 'mt-4' : undefined}>
                    <SubHead>{t.hour}</SubHead>
                    <div data-testid="stats-hour"><ColumnChart series={[t.observations]} slotWidth={30} height={150} data={(filtered ? stats.byHour.filter((b) => b.observations > 0) : stats.byHour).map((b) => ({ key: b.key, label: `${Number(b.key)}h`, values: [b.observations], hint: `${b.key}:00` }))} /></div>
                  </div>
                )}
              </Block>
              )}
            </Grid>
          </Section>
          )}

          {/* ── Writing & process ── */}
          {showWriting && (
          <Section title={t.secWriting} hint={t.secWritingHint} testId="stats-section-writing">
            <Grid>
              {hasObs && (
              <Block span="lg:col-span-4" title={t.writing} testId="stats-writing">
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <MiniStat label={t.words} value={fmtInt(T.words)} />
                  <MiniStat label={t.chars} value={fmtInt(T.chars)} />
                  <MiniStat label={t.perObs} value={T.observations ? fmtInt(T.words / T.observations) : '–'} />
                  <MiniStat label={t.pagesA4} value={fmtDec(a4Pages(T.words))} />
                </div>
                <KV rows={[
                  [t.wordsMedian, T.wordsMedian !== null ? fmtInt(T.wordsMedian) : '–'],
                  [t.longestRemark, `${fmtInt(T.longestRemark)} ${t.words}`],
                  [`${t.filled}: ${t.highlights}`, pctText(pct(T.filledHighlights, T.observations))],
                  [`${t.filled}: ${t.improvements}`, pctText(pct(T.filledImprovements, T.observations))],
                  [`${t.filled}: ${t.goals}`, pctText(pct(T.filledGoals, T.observations))],
                ]} />
                {stats.byRc.some((r) => r.words > 0) && (
                  <div className="mt-4">
                    <SubHead>{t.wordsCol} · {t.perRc}</SubHead>
                    <BarList rows={stats.byRc.filter((r) => r.words > 0).slice(0, 5).map((r) => ({ key: r.key, label: r.label, value: r.words }))} />
                  </div>
                )}
              </Block>
              )}
              {hasObs && (
              <Block span="lg:col-span-4" title={t.process} testId="stats-process">
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <MiniStat label={t.filingMedian} value={T.filingMedianDays !== null ? t.days(Math.round(T.filingMedianDays)) : '–'} />
                  <MiniStat label={t.sameDay} value={pctText(pct(T.filedSameDay, T.observations))} />
                </div>
                <KV rows={[
                  [t.late, pctText(pct(T.filedLate, T.observations))],
                  [t.signedRef, pctText(pct(T.signedReferee, T.observations))],
                  [t.signedRc, pctText(pct(T.signedRc, T.observations))],
                  [t.completeness, pctText(pct(T.ratedItems, T.offeredItems))],
                ]} />
              </Block>
              )}
              {showFun && (
              <Block span="lg:col-span-4" title={t.fun} testId="stats-fun">
                <KV rows={[
                  [t.busiestDay, F.busiestDay ? `${fmtInt(F.busiestDay.count)} · ${dayLabel(F.busiestDay.key, { year: true })}` : '–'],
                  [t.topHall, F.topHall ? `${F.topHall.name} (${fmtInt(F.topHall.count)})` : '–'],
                  [t.topCoachee, F.topCoachee ? `${F.topCoachee.name} (${fmtInt(F.topCoachee.count)})` : '–'],
                  [t.topWriter, F.topWriter ? `${F.topWriter.name} (${fmtInt(F.topWriter.words)})` : '–'],
                  [t.firstLast, F.first ? `${dayLabel(F.first, { year: true })} – ${F.last ? dayLabel(F.last, { year: true }) : ''}` : '–'],
                ]} />
              </Block>
              )}
            </Grid>
          </Section>
          )}

          {/* ── By level / by group: one row per slice ── */}
          {dim !== 'none' && (
          <Section title={dim === 'level' && selNiv ? `${t.compareTitle(dim)} · ${selNiv}` : t.compareTitle(dim)} hint={t.compareHint} testId="stats-compare">
            {!cmpRows ? (
              <div className="flex items-center gap-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /> {t.loading}</div>
            ) : (() => {
              const rows = cmpRows.filter((r) => r.stats.totals.observations > 0 || r.stats.totals.roster > 0);
              if (!rows.length) return <p className="text-sm text-stone-400">{t.compareEmpty}</p>;
              const selected = dim === 'level' ? filters.level : filters.group;
              return (
                <div className={cn('overflow-x-auto -mx-1 transition-opacity', cmpLoading && 'opacity-60')}>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-stone-400">
                        <th className="text-left font-medium py-1.5 px-1 align-bottom">{dim === 'level' ? t.byLevel : t.byGroup}</th>
                        <th className="text-right font-medium py-1.5 px-1 align-bottom" title={t.observations}>{t.compareObs}</th>
                        <th className="text-right font-medium py-1.5 px-1 align-bottom">{t.compareCoverage}</th>
                        <th className="text-right font-medium py-1.5 px-1 align-bottom">{t.gradeCol}</th>
                        <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom" title={t.comparePromotionHint}>{t.comparePromotion}</th>
                        <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom leading-tight" title={t.compareFurtherHint}>{t.compareFurther}</th>
                        {rows.some((r) => r.stats.trend) && <th className="hidden sm:table-cell text-right font-medium py-1.5 px-1 align-bottom" title={t.trendHint}>{t.trendCol}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(({ key, stats: s }) => {
                        const c = s.totals;
                        const a = gradeAvg(c.grade);
                        const label = dim === 'level' ? levelKeyLabel(key, lang) : groupKeyLabel(key, lang);
                        const on = selected === key;
                        return (
                          <tr
                            key={key}
                            onClick={() => (dim === 'level' ? pickLevel(key) : pickGroup(key))}
                            className={cn('border-t border-stone-100 cursor-pointer hover:bg-stone-50', on && 'bg-stone-100 font-semibold')}
                          >
                            <td className="py-2.5 px-1 text-stone-800 leading-tight">
                              {label}
                              {/* Promotion, further visit and trend under the label on a phone. */}
                              <span className="sm:hidden mt-0.5 flex flex-wrap gap-x-2 text-[10px] font-normal text-stone-500 tabular-nums">
                                <span>{t.comparePromotion} {pctText(pct(s.outcomes.einstufung.up ?? 0, sum(s.outcomes.einstufung)))}</span>
                                <span>{t.compareFurtherShort} {pctText(pct(s.outcomes.secondBesuch.Y ?? 0, sum(s.outcomes.secondBesuch)))}</span>
                                {s.trend && s.trend.coachees > 0 && <TrendCounts tr={s.trend} />}
                              </span>
                            </td>
                            <td className="py-2.5 px-1 text-right tabular-nums font-semibold">{fmtInt(c.observations)}</td>
                            <td className="py-2.5 px-1 text-right tabular-nums whitespace-nowrap leading-tight">{pctText(pct(c.coachees, c.roster))}<span className="block text-[10px] text-stone-400">{fmtInt(c.coachees)}/{fmtInt(c.roster)}</span></td>
                            <td className="py-2.5 px-1 text-right tabular-nums whitespace-nowrap">{a === null ? <span className="text-stone-400">–</span> : <><b className={isThin(c.observations) ? 'text-stone-600' : undefined}>{scoreToLetter(a)}</b> <span className="hidden sm:inline text-stone-500">{fmtDec(a)}</span></>}</td>
                            <td className="hidden sm:table-cell py-2.5 px-1 text-right tabular-nums">{pctText(pct(s.outcomes.einstufung.up ?? 0, sum(s.outcomes.einstufung)))}</td>
                            <td className="hidden sm:table-cell py-2.5 px-1 text-right tabular-nums">{pctText(pct(s.outcomes.secondBesuch.Y ?? 0, sum(s.outcomes.secondBesuch)))}</td>
                            {rows.some((r) => r.stats.trend) && (
                              <td className="hidden sm:table-cell py-2.5 px-1 text-right tabular-nums whitespace-nowrap">
                                {s.trend && s.trend.coachees > 0 ? <TrendCounts tr={s.trend} /> : <span className="text-stone-400">–</span>}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </Section>
          )}

          <details className="px-1 text-[11px] text-stone-500">
            <summary className="cursor-pointer font-medium text-stone-600">{t.method}</summary>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">{t.methodLines.map((l) => <li key={l}>{l}</li>)}</ul>
            <p className="mt-1">{t.stand}: {dayLabel(stats.generatedAt, { year: true })}</p>
          </details>
        </div>
    );
  })();

  const chip = (on: boolean) => cn(
    'shrink-0 h-9 px-3.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors',
    on ? 'bg-slate-900 border-slate-900 text-white' : 'bg-white border-stone-200 text-stone-600 hover:bg-stone-100',
  );
  // The filter bar: pinned to the bottom of the screen while the page scrolls,
  // above the console's own tab bar on a phone.
  const groupBar = options && (
    <div className="sticky z-10 mt-4 bottom-[calc(4rem+env(safe-area-inset-bottom,0px))] lg:bottom-3" data-testid="stats-groupbar">
      <div className="rounded-2xl border border-stone-200 bg-white/95 backdrop-blur shadow-card-lg p-2 space-y-2">
        <div role="radiogroup" aria-label={t.groupBy} className="grid grid-cols-3 gap-1 rounded-xl bg-stone-100 p-1">
          {([['none', t.noFilter], ['level', t.byLevel], ['group', t.byGroup]] as const).map(([d, label]) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={dim === d}
              onClick={() => chooseDim(d)}
              className={cn('h-9 rounded-lg text-xs font-medium transition-colors', dim === d ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-600 hover:bg-stone-200/60')}
            >
              {label}
            </button>
          ))}
        </div>
        {dim === 'level' && (
          <>
            <div className="flex gap-1.5 overflow-x-auto" data-testid="stats-filter-level">
              {niveaus.map((l) => (
                <button key={l} type="button" aria-pressed={selNiv === l} onClick={() => setFilter('level', selNiv === l ? '' : l)} className={chip(selNiv === l)}>{l}</button>
              ))}
            </div>
            {stufen.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto" data-testid="stats-filter-stufe">
                <button type="button" aria-pressed={filters.level === selNiv} onClick={() => setFilter('level', selNiv)} className={chip(filters.level === selNiv)}>{t.allOfLevel(selNiv)}</button>
                {stufen.map((l) => (
                  <button key={l} type="button" aria-pressed={filters.level === l} onClick={() => pickLevel(l)} className={chip(filters.level === l)}>{l}</button>
                ))}
              </div>
            )}
          </>
        )}
        {dim === 'group' && (
          <div className="flex gap-1.5 overflow-x-auto" data-testid="stats-filter-group">
            {(options.groups ?? []).map((g) => (
              <button key={g} type="button" aria-pressed={filters.group === g} onClick={() => pickGroup(g)} className={chip(filters.group === g)}>{groupKeyLabel(g, lang)}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const filterField = (label: string, control: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-[11px] font-medium uppercase tracking-wide text-stone-400 min-w-0">
      <span>{label}</span>
      {control}
    </label>
  );

  return (
    <div data-testid="stats-admin">
      {/* ── Header: what this is, the slice, the export ── */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-stone-700 inline-flex items-center gap-1.5"><BarChart3 size={15} /> {t.title}</h2>
            <p className="mt-1 text-xs text-stone-500 max-w-prose">{t.hint}</p>
          </div>
          <div className="relative">
            <button type="button" onClick={() => setExportOpen((o) => !o)} disabled={!stats || loading} className={btn} data-testid="stats-export">
              <Download size={14} /> {t.export}
            </button>
            {exportOpen && (
              <div className="absolute left-0 sm:left-auto sm:right-0 mt-1 z-10 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-stone-200 bg-white shadow-lg p-3 text-xs space-y-2" data-testid="stats-export-menu">
                <p className="text-stone-500">{t.exportHint}</p>
                <div className="flex items-center gap-3 text-stone-700" role="radiogroup" aria-label={t.exportLang}>
                  <span className="text-stone-500">{t.exportLang}</span>
                  {(['DE', 'EN'] as Lang[]).map((l) => (
                    <label key={l} className="inline-flex items-center gap-1"><input type="radio" name="stats-export-lang" value={l} checked={exportLang === l} onChange={() => setExportLang(l)} /> {l}</label>
                  ))}
                </div>
                <label className="flex items-start gap-2 text-stone-700"><input type="checkbox" className="mt-0.5" checked={includeRcGrades} onChange={(e) => setIncludeRcGrades(e.target.checked)} /> {t.optRcGrades}</label>
                <label className="flex items-start gap-2 text-stone-700"><input type="checkbox" className="mt-0.5" checked={includeLeagues} onChange={(e) => setIncludeLeagues(e.target.checked)} /> {t.optLeagues}</label>
                {view?.breakdowns && <label className="flex items-start gap-2 text-stone-700"><input type="checkbox" className="mt-0.5" checked={includeSlices} onChange={(e) => setIncludeSlices(e.target.checked)} /> {t.optSlices}</label>}
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => void runExport('pptx')} disabled={exporting !== null} className={cn(btn, 'flex-1 justify-center')} data-testid="stats-export-pptx">
                    {exporting === 'pptx' ? <Loader2 size={14} className="animate-spin" /> : <Presentation size={14} />} {t.exportPptx}
                  </button>
                  <button type="button" onClick={() => void runExport('pdf')} disabled={exporting !== null} className={cn(btn, 'flex-1 justify-center')} data-testid="stats-export-pdf">
                    {exporting === 'pdf' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} {t.exportPdf}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Filters — one row of labelled controls; every section below follows them.
            Level and group are in the bar at the bottom of the page. */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-[8rem_minmax(0,1fr)_8rem_auto] gap-3 items-end" data-testid="stats-filters">
          {filterField(t.season, (
            <select className={select} value={effectiveSeason} onChange={(e) => setSeason(Number(e.target.value))} data-testid="stats-season">
              {seasons.map((s) => <option key={s} value={s}>{seasonName(s)}</option>)}
            </select>
          ))}
          {filterField(t.rc, (
            <select className={select} value={filters.rc ?? ''} onChange={(e) => setFilter('rc', e.target.value)} data-testid="stats-filter-rc">
              <option value="">{t.all}</option>
              {(options?.rcs ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          ))}
          {filterField(t.role, (
            <select className={select} value={filters.role ?? ''} onChange={(e) => setFilter('role', e.target.value)} data-testid="stats-filter-role">
              <option value="">{t.all}</option>
              <option value="1SR">{t.role1}</option>
              <option value="2SR">{t.role2}</option>
            </select>
          ))}
          <label className="inline-flex items-center gap-2 h-9 text-xs text-stone-600 col-span-2 sm:col-span-1">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> {t.compare}
          </label>
        </div>

        {error && <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
        {loading && !stats && <div className="mt-4 flex items-center gap-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /> {t.loading}</div>}
      </Card>

      {body}
      {groupBar}
    </div>
  );
}

// ── Trend pieces ──
const TREND_KEYS = ['improved', 'same', 'worse'] as const;
// The Einstufung's own colours: green up, blue level, red down.
const TREND_COLOR = { improved: outcomeColor('einstufung', 'up'), same: outcomeColor('einstufung', 'check'), worse: outcomeColor('einstufung', 'down') };
function trendLabel(k: typeof TREND_KEYS[number], t: ReturnType<typeof statStrings>) {
  return k === 'improved' ? t.trendImproved : k === 'same' ? t.trendSame : t.trendWorse;
}

/** "↑3 =1 ↓0" — compact enough for a table cell. */
function TrendCounts({ tr }: { tr: TrendAgg }) {
  return (
    <span className="inline-flex gap-1.5">
      <span style={{ color: TREND_COLOR.improved }}>↑{tr.improved}</span>
      <span className="text-stone-500">={tr.same}</span>
      <span style={{ color: TREND_COLOR.worse }}>↓{tr.worse}</span>
    </span>
  );
}

/** A trend row for DivergingBars: worse left, same centred, better right; n and the mean change beside the name. */
function trendRow(r: TrendAgg & { key: string }, label: string) {
  const d = trendAvgDelta(r);
  return { key: r.key || '-', label, neg: r.worse, mid: r.same, pos: r.improved, sub: `n = ${r.coachees}${d === null ? '' : ` · Ø ${d > 0 ? '+' : ''}${fmtDec(d)}`}` };
}

function bucketRow(b: StatBucket, label: string, t: ReturnType<typeof statStrings>) {
  const a = gradeAvg(b.grade);
  const thin = a !== null && isThin(b.observations);
  return {
    key: b.key || '-',
    label,
    value: b.observations,
    sub: a === null ? `${b.coachees} ${t.coacheesCol}` : `${b.coachees} ${t.coacheesCol} · Ø ${scoreToLetter(a)}${thin ? ` (n = ${b.observations})` : ''}`,
    hint: `${label}: ${b.observations} · ${b.coachees} ${t.coacheesCol} · ${a === null ? '–' : `Ø ${scoreToLetter(a)} ${fmtDec(a)}${thin ? ` · n = ${b.observations}` : ''}`}`,
  };
}

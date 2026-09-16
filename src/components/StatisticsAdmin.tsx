// Admin → Statistik: the season in numbers. One request per season + filter
// slice (the server aggregates, src/lib/statistics.ts is the shape), tiles
// and charts from it, and an export that turns the same numbers into a
// PowerPoint deck or a PDF (src/lib/statsDeck.ts).
import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Download, FileText, Loader2, Presentation } from 'lucide-react';
import { cn } from '../lib/utils';
import type { Lang } from '../lib/appTime';
import { dayLabel } from '../lib/appTime';
import { loadStatistics } from '../lib/pocketbase';
import {
  a4Pages, estimatedHours, gradeAvg, isThin, pct, scoreToLetter, GRADE_ORDER, GRADE_LETTERS,
  type StatBucket, type StatFilters, type StatRole, type StatisticsResponse,
} from '../lib/statistics';
import {
  categoryLabel, criterionLabel, divisionLabel, groupKeyLabel, levelKeyLabel, monthLabel, OUTCOME_ORDER, outcomeLabel,
  roleLabel, sectionCount, sectionTitle, seasonName, srGoalLabel, statStrings, weekdayKeyLabel,
} from '../lib/statsLabels';
import { SECTIONS_1SR_DE, SECTIONS_2SR_DE } from '../types';
import { buildDeck, deckFileName } from '../lib/statsDeck';
import { BarList, ColumnChart, Donut, GradeScale, StatTile, fmtDec, fmtInt, type ScaleRow } from './StatsCharts';

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
  // The request is heavier than the other tabs' (four full lists on the
  // server), so it waits for the first time the tab is actually opened —
  // and then stays loaded across tab switches.
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (active) setArmed(true); }, [active]);

  const effectiveSeason = season ?? defaultSeason;
  useEffect(() => {
    if (settingsLoading || !armed) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    loadStatistics(effectiveSeason, filters, compare)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [settingsLoading, armed, effectiveSeason, filters, compare]);

  const stats = data?.stats ?? null;
  const options = data?.options ?? null;
  const rcNames = useMemo(() => Object.fromEntries((options?.rcs ?? []).map((r) => [r.id, r.name])), [options]);

  const runExport = async (kind: 'pptx' | 'pdf') => {
    if (!stats) return;
    setExporting(kind);
    try {
      const deck = buildDeck(stats, { lang, includeRcGrades, includeLeagues, rcNames });
      if (kind === 'pptx') {
        const { buildDeckPptx } = await import('../lib/statsPptx');
        download(await buildDeckPptx(deck), deckFileName(stats, 'pptx'));
      } else {
        const { buildDeckPdf } = await import('../lib/statsPdf');
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

  const seasons = options?.seasons ?? [effectiveSeason];
  const T = stats?.totals;
  const P = stats?.previous?.totals;
  const prevName = stats?.previous ? seasonName(stats.previous.season) : '';
  const avg = T ? gradeAvg(T.grade) : null;

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
                <label className="flex items-start gap-2 text-stone-700"><input type="checkbox" className="mt-0.5" checked={includeRcGrades} onChange={(e) => setIncludeRcGrades(e.target.checked)} /> {t.optRcGrades}</label>
                <label className="flex items-start gap-2 text-stone-700"><input type="checkbox" className="mt-0.5" checked={includeLeagues} onChange={(e) => setIncludeLeagues(e.target.checked)} /> {t.optLeagues}</label>
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

        {/* Filters — one row of labelled controls; every section below follows them. */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)_8rem_8rem_auto] gap-3 items-end" data-testid="stats-filters">
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
          {filterField(t.group, (
            <select className={select} value={filters.group ?? ''} onChange={(e) => setFilter('group', e.target.value)} data-testid="stats-filter-group">
              <option value="">{t.all}</option>
              {(options?.groups ?? []).map((g) => <option key={g} value={g}>{groupKeyLabel(g, lang)}</option>)}
            </select>
          ))}
          {filterField(t.level, (
            <select className={select} value={filters.level ?? ''} onChange={(e) => setFilter('level', e.target.value)} data-testid="stats-filter-level">
              <option value="">{t.all}</option>
              {(options?.levels ?? []).map((l) => <option key={l} value={l}>{l}</option>)}
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

      {stats && T && (
        <div className={cn('space-y-4 transition-opacity', loading && 'opacity-60')} data-testid="stats-body">
          {/* ── Overview ── */}
          <Section title={t.secOverview} hint={t.secOverviewHint} testId="stats-overview">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3" data-testid="stats-tiles">
              <StatTile hero label={t.observations} value={fmtInt(T.observations)} sub={T.games ? t.games(T.games) : undefined} delta={P ? delta(T.observations, P.observations) : null} deltaLabel={t.deltaVs(prevName)} />
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
          <Section title={t.secObservations} hint={t.secObservationsHint} testId="stats-section-observations">
            <Grid>
              <Block span="lg:col-span-6" title={t.perMonth} hint={`${t.role1} / ${t.role2}`} testId="stats-months">
                <ColumnChart
                  series={[t.role1, t.role2]}
                  data={stats.byMonth.map((b) => ({ key: b.key, label: monthLabel(b.key, lang), values: [b.roles['1SR'], b.roles['2SR']], hint: `${monthLabel(b.key, lang)} ${b.key.slice(0, 4)}` }))}
                />
              </Block>
              <Block span="lg:col-span-3" title={t.coverage} hint={t.coverageHint} testId="stats-coverage">
                <BarList rows={['0', '1', '2', '3+'].map((k) => ({ key: k, label: t.visits(k), value: stats.coacheeVisits[k] ?? 0 }))} />
                <p className="mt-3 text-[11px] text-stone-500">{t.coacheesVisited}: <b className="text-stone-700">{fmtInt(T.coachees)} / {fmtInt(T.roster)}</b> · {pctText(pct(T.coachees, T.roster))}</p>
              </Block>
              <Block span="lg:col-span-3" title={t.role} hint={t.observations} testId="stats-roles">
                <BarList rows={stats.byRole.map((b) => bucketRow(b, roleLabel(b.key, lang), t))} />
                <p className="mt-3 text-[11px] text-stone-500">{t.language}: <b className="text-stone-700">DE {fmtInt(T.langDE)} · EN {fmtInt(T.langEN)}</b></p>
              </Block>
              <Block span="lg:col-span-12" title={t.perRc} testId="stats-rcs">
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-stone-400">
                        <th className="text-left font-medium py-1.5 px-1">{t.rc}</th>
                        <th className="text-right font-medium py-1.5 px-1">{t.observations}</th>
                        <th className="text-right font-medium py-1.5 px-1">{t.coacheesCol}</th>
                        <th className="text-right font-medium py-1.5 px-1">{t.gamesCol}</th>
                        <th className="text-right font-medium py-1.5 px-1">{t.setsCol}</th>
                        <th className="text-right font-medium py-1.5 px-1">{t.wordsCol}</th>
                        <th className="text-right font-medium py-1.5 px-1">{t.gradeCol}</th>
                        <th className="text-left font-medium py-1.5 pl-3 min-w-[9rem]">{t.goalCol}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.byRc.filter((r) => r.observations > 0 || r.goal > 0).map((r) => {
                        const a = gradeAvg(r.grade);
                        const fill = r.goal > 0 ? Math.min(100, (r.observations / r.goal) * 100) : 0;
                        return (
                          <tr key={r.key} className="border-t border-stone-100">
                            <td className="py-1.5 px-1 text-stone-800 whitespace-nowrap">{r.label}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums font-semibold">{fmtInt(r.observations)}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums">{fmtInt(r.coachees)}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums">{fmtInt(r.games)}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums">{fmtInt(r.sets)}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums">{fmtInt(r.words)}</td>
                            <td className="py-1.5 px-1 text-right tabular-nums whitespace-nowrap" title={a === null ? '–' : `${fmtDec(a)} · ${t.nObs(r.observations)}`}>{a === null ? <span className="text-stone-400">–</span> : <><b className={isThin(r.observations) ? 'text-stone-600' : undefined}>{scoreToLetter(a)}</b> <span className="text-stone-500">{fmtDec(a)}</span>{isThin(r.observations) && <span className="text-stone-400"> · n = {r.observations}</span>}</>}</td>
                            <td className="py-1.5 pl-3">
                              <div className="flex items-center gap-2" title={`${fmtInt(r.observations)} / ${fmtInt(r.goal)} · ${r.planned} ${t.planned} · ${r.outstanding} ${t.outstanding}`}>
                                <span className="h-2 flex-1 min-w-[4rem] rounded-full bg-stone-100 overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${fill}%`, background: fill >= 100 ? '#1f7a4d' : '#2a78d6' }} /></span>
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
              <Block span="lg:col-span-6" title={t.perGroup} hint={t.observations} testId="stats-groups">
                <BarList rows={stats.byGroup.map((b) => bucketRow(b, groupKeyLabel(b.key, lang), t))} />
              </Block>
              <Block span="lg:col-span-6" title={t.perLevel} hint={t.observations} testId="stats-levels">
                <BarList rows={stats.byLevel.map((b) => bucketRow(b, levelKeyLabel(b.key, lang), t))} />
                {stats.byStufe.length > 0 && (
                  <div className="mt-4">
                    <SubHead>{t.perStufe} · {t.avgGrade}</SubHead>
                    <GradeScale rows={stats.byStufe.map((b) => ({ key: b.key, label: levelKeyLabel(b.key, lang), avg: gradeAvg(b.grade), n: b.observations }))} nLabel={t.nObs} />
                  </div>
                )}
              </Block>
            </Grid>
          </Section>

          {/* ── Grades ── */}
          <Section title={t.secGrades} hint={t.secGradesHint} testId="stats-section-grades">
            <Grid>
              <Block span="lg:col-span-7" title={t.histogram} hint={t.histogramHint} testId="stats-histogram">
                <ColumnChart
                  series={[t.histogram]}
                  slotWidth={26}
                  soft={GRADE_ORDER.map((g, i) => (g.length > 1 ? i : -1)).filter((i) => i >= 0)}
                  data={GRADE_ORDER.map((g) => ({ key: g, label: GRADE_LETTERS.includes(g) ? g : '', values: [stats.histogram[g] ?? 0], hint: g }))}
                />
              </Block>
              <Block span="lg:col-span-5" title={t.avgGrade} hint={t.normalCase} testId="stats-grade-summary">
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat label={t.avgGrade} value={avg === null ? '–' : `${scoreToLetter(avg)} · ${fmtDec(avg)}${isThin(T.grade.obs) ? ` (n = ${T.grade.obs})` : ''}`} />
                  <MiniStat label={t.shareC} value={pctText(pct(T.ratingsC, T.ratingsAll))} />
                  <MiniStat label={t.shareB} value={pctText(pct(T.ratingsBPlus, T.ratingsAll))} />
                </div>
                <div className="mt-4">
                  <SubHead>{t.avgGrade} · {t.role}</SubHead>
                  <GradeScale rows={stats.byRole.map((b) => ({ key: b.key, label: roleLabel(b.key, lang), avg: gradeAvg(b.grade), n: b.observations }))} nLabel={t.nObs} />
                </div>
                <p className="mt-3 text-[11px] text-stone-500">{t.completeness}: <b className="text-stone-700">{pctText(pct(T.ratedItems, T.offeredItems))}</b></p>
              </Block>
              <Block span="lg:col-span-5" title={t.sections} hint={t.normalCase} testId="stats-sections">
                {(['1SR', '2SR'] as StatRole[]).map((role) => {
                  const rows: ScaleRow[] = stats.sections.filter((s) => s.role === role).map((s) => ({ key: `${role}-${s.section}`, label: sectionTitle(role, s.section, lang), avg: gradeAvg(s.grade), n: s.grade.obs }));
                  return (
                    <div key={role} className="mb-4 last:mb-0">
                      <SubHead>{roleLabel(role, lang)}</SubHead>
                      {rows.length ? <GradeScale rows={rows} nLabel={t.nObs} /> : <p className="text-xs text-stone-400">–</p>}
                    </div>
                  );
                })}
              </Block>
              <Block span="lg:col-span-7" title={t.criteria} hint={t.normalCase} testId="stats-criteria"
                aside={(
                  <div className="inline-flex rounded-lg border border-stone-200 p-0.5 text-xs bg-white">
                    {(['1SR', '2SR'] as StatRole[]).map((role) => (
                      <button key={role} type="button" onClick={() => setCriteriaRole(role)} className={cn('px-2.5 h-7 rounded-md', criteriaRole === role ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-100')}>{roleLabel(role, lang)}</button>
                    ))}
                  </div>
                )}>
                {Array.from({ length: sectionCount(criteriaRole) }, (_, sectionIndex) => {
                  const form = criteriaRole === '2SR' ? SECTIONS_2SR_DE : SECTIONS_1SR_DE;
                  const rows: ScaleRow[] = form[sectionIndex].items.map((item) => {
                    const c = stats.criteria.find((x) => x.role === criteriaRole && x.id === item.id);
                    return { key: item.id, label: criterionLabel(criteriaRole, item.id, lang), avg: c ? gradeAvg(c.grade) : null, n: c?.grade.obs ?? 0 };
                  });
                  return (
                    <div key={sectionIndex} className="mb-4 last:mb-0">
                      <SubHead>{sectionTitle(criteriaRole, sectionIndex, lang)}</SubHead>
                      <GradeScale rows={rows} nLabel={t.nObs} />
                    </div>
                  );
                })}
              </Block>
            </Grid>
          </Section>

          {/* ── Assessments ── */}
          <Section title={t.secOutcomes} hint={t.secOutcomesHint} testId="stats-section-outcomes">
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
              {(['einstufung', 'motivation', 'spielniveau', 'secondBesuch'] as const).map((kind) => (
                <Block key={kind} title={kind === 'einstufung' ? t.einstufung : kind === 'motivation' ? t.motivation : kind === 'spielniveau' ? t.difficulty : t.secondVisit} testId={`stats-${kind}`}>
                  <Donut emptyLabel="–" slices={OUTCOME_ORDER[kind].map((k) => ({ key: k, label: outcomeLabel(kind, k, lang), value: stats.outcomes[kind][k] ?? 0 }))} />
                </Block>
              ))}
              <Block title={t.srGoal} hint={t.observations} testId="stats-srziel">
                <BarList rows={(Object.entries(stats.outcomes.srZiel) as Array<[string, number]>).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: srGoalLabel(k, lang), value: v }))} />
              </Block>
            </div>
          </Section>

          {/* ── Games ── */}
          <Section title={t.secGames} hint={t.secGamesHint} testId="stats-section-games">
            <Grid>
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
              <Block span="lg:col-span-4" title={t.perLeague} hint={t.observations} testId="stats-leagues">
                <BarList rows={stats.byLeague.slice(0, 10).map((b) => ({ key: b.key || '-', label: b.label || '–', value: b.observations }))} />
                <div className="mt-4">
                  <SubHead>{categoryLabel('H', lang)} · {categoryLabel('D', lang)} · U23</SubHead>
                  <BarList rows={stats.byCategory.map((b) => ({ key: b.key || '-', label: categoryLabel(b.key, lang), value: b.observations }))} />
                </div>
                <div className="mt-4">
                  <SubHead>{divisionLabel('NL', lang)} … {divisionLabel('5', lang)}</SubHead>
                  <BarList rows={stats.byDivision.map((b) => ({ key: b.key || '-', label: divisionLabel(b.key, lang), value: b.observations }))} />
                </div>
              </Block>
              <Block span="lg:col-span-4" title={`${t.weekday} · ${t.hour}`} hint={t.observations} testId="stats-when">
                <SubHead>{t.weekday}</SubHead>
                <div data-testid="stats-weekday"><BarList rows={stats.byWeekday.map((b) => ({ key: b.key, label: weekdayKeyLabel(b.key, lang), value: b.observations }))} /></div>
                <div className="mt-4">
                  <SubHead>{t.hour}</SubHead>
                  <div data-testid="stats-hour"><BarList rows={stats.byHour.map((b) => ({ key: b.key, label: `${b.key}:00`, value: b.observations }))} /></div>
                </div>
              </Block>
            </Grid>
          </Section>

          {/* ── Writing & process ── */}
          <Section title={t.secWriting} hint={t.secWritingHint} testId="stats-section-writing">
            <Grid>
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
                  [t.language, `DE ${fmtInt(T.langDE)} · EN ${fmtInt(T.langEN)}`],
                ]} />
              </Block>
              <Block span="lg:col-span-4" title={t.fun} testId="stats-fun">
                <KV rows={[
                  [t.busiestDay, stats.fun.busiestDay ? `${fmtInt(stats.fun.busiestDay.count)} · ${dayLabel(stats.fun.busiestDay.key, { year: true })}` : '–'],
                  [t.topHall, stats.fun.topHall ? `${stats.fun.topHall.name} (${fmtInt(stats.fun.topHall.count)})` : '–'],
                  [t.topCoachee, stats.fun.topCoachee ? `${stats.fun.topCoachee.name} (${fmtInt(stats.fun.topCoachee.count)})` : '–'],
                  [t.topWriter, stats.fun.topWriter ? `${stats.fun.topWriter.name} (${fmtInt(stats.fun.topWriter.words)})` : '–'],
                  [t.firstLast, stats.fun.first ? `${dayLabel(stats.fun.first, { year: true })} – ${stats.fun.last ? dayLabel(stats.fun.last, { year: true }) : ''}` : '–'],
                ]} />
              </Block>
            </Grid>
          </Section>

          <details className="px-1 text-[11px] text-stone-500">
            <summary className="cursor-pointer font-medium text-stone-600">{t.method}</summary>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">{t.methodLines.map((l) => <li key={l}>{l}</li>)}</ul>
            <p className="mt-1">{t.stand}: {dayLabel(stats.generatedAt, { year: true })}</p>
          </details>
        </div>
      )}
    </div>
  );
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

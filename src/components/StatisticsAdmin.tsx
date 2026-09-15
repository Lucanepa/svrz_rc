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
  a4Pages, estimatedHours, gradeAvg, pct, scoreToLetter, GRADE_ORDER, GRADE_LETTERS,
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
function Block({ title, hint, children, testId, className }: { title: string; hint?: string; children: React.ReactNode; testId?: string; className?: string; key?: React.Key }) {
  return (
    <section data-testid={testId} className={cn('rounded-xl border border-stone-200/70 bg-white p-3.5 min-w-0', className)}>
      <h3 className="text-xs font-semibold text-stone-700">{title}</h3>
      {hint && <p className="text-[11px] text-stone-400 mb-2">{hint}</p>}
      {!hint && <div className="mb-2" />}
      {children}
    </section>
  );
}
function KV({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-stone-500 leading-snug">{k}</dt>
          <dd className="text-stone-800 font-medium tabular-nums text-right">{v}</dd>
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

  return (
    <Card testId="stats-admin">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-stone-700 inline-flex items-center gap-1.5"><BarChart3 size={15} /> {t.title}</h2>
          <p className="mt-1 text-xs text-stone-500">{t.hint}</p>
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

      {/* Filters — one row, every block below follows them. */}
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="stats-filters">
        <label className="inline-flex items-center gap-1.5 text-xs text-stone-500">{t.season}
          <select className={select} value={effectiveSeason} onChange={(e) => setSeason(Number(e.target.value))} data-testid="stats-season">
            {seasons.map((s) => <option key={s} value={s}>{seasonName(s)}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-stone-500">{t.rc}
          <select className={select} value={filters.rc ?? ''} onChange={(e) => setFilter('rc', e.target.value)} data-testid="stats-filter-rc">
            <option value="">{t.all}</option>
            {(options?.rcs ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-stone-500">{t.group}
          <select className={select} value={filters.group ?? ''} onChange={(e) => setFilter('group', e.target.value)} data-testid="stats-filter-group">
            <option value="">{t.all}</option>
            {(options?.groups ?? []).map((g) => <option key={g} value={g}>{groupKeyLabel(g, lang)}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-stone-500">{t.level}
          <select className={select} value={filters.level ?? ''} onChange={(e) => setFilter('level', e.target.value)} data-testid="stats-filter-level">
            <option value="">{t.all}</option>
            {(options?.levels ?? []).map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-stone-500">{t.role}
          <select className={select} value={filters.role ?? ''} onChange={(e) => setFilter('role', e.target.value)} data-testid="stats-filter-role">
            <option value="">{t.all}</option>
            <option value="1SR">{t.role1}</option>
            <option value="2SR">{t.role2}</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs text-stone-600 ml-auto">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> {t.compare}
        </label>
      </div>

      {error && <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
      {loading && !stats && <div className="mt-4 flex items-center gap-2 text-sm text-stone-400"><Loader2 size={15} className="animate-spin" /> {t.loading}</div>}

      {stats && T && (
        <div className={cn('mt-4 space-y-3 transition-opacity', loading && 'opacity-60')} data-testid="stats-body">
          {/* Tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7 gap-2" data-testid="stats-tiles">
            <StatTile hero label={t.observations} value={fmtInt(T.observations)} sub={T.games ? t.games(T.games) : undefined} delta={P ? delta(T.observations, P.observations) : null} deltaLabel={t.deltaVs(prevName)} />
            <StatTile label={t.coacheesVisited} value={`${fmtInt(T.coachees)} / ${fmtInt(T.roster)}`} sub={pctText(pct(T.coachees, T.roster))} delta={P ? delta(T.coachees, P.coachees) : null} deltaLabel={t.deltaVs(prevName)} />
            <StatTile label={t.activeRcs} value={`${fmtInt(T.rcsActive)} / ${fmtInt(T.rcsTotal)}`} sub={`${t.pensum} ${pctText(pct(T.observations, T.goal))}`} />
            <StatTile label={t.avgGrade} value={avg === null ? t.tooFew(T.grade.obs) : <><span>{scoreToLetter(avg)}</span> <span className="text-base font-medium text-stone-500">{fmtDec(avg)}</span></>} sub={t.normalCase} delta={P && avg !== null && gradeAvg(P.grade) !== null ? `${avg - gradeAvg(P.grade)! >= 0 ? '+' : ''}${fmtDec(avg - gradeAvg(P.grade)!)}` : null} deltaLabel={t.deltaVs(prevName)} />
            <StatTile label={t.sets} value={fmtInt(T.sets)} sub={T.games ? `${fmtDec(T.sets / T.games)} ${t.setsPerGame}` : undefined} delta={P ? delta(T.sets, P.sets) : null} deltaLabel={t.deltaVs(prevName)} />
            <StatTile label={t.points} value={fmtInt(T.points)} sub={t.hours(estimatedHours(T.sets))} delta={P ? delta(T.points, P.points) : null} deltaLabel={t.deltaVs(prevName)} />
            <StatTile label={t.words} value={fmtInt(T.words)} sub={T.observations ? `${t.perObs} ${fmtInt(T.words / T.observations)}` : undefined} delta={P ? delta(T.words, P.words) : null} deltaLabel={t.deltaVs(prevName)} />
          </div>

          {T.observations === 0 && <p className="text-sm text-stone-400">{t.none}</p>}

          {/* Month + histogram */}
          <div className="grid md:grid-cols-2 gap-3">
            <Block title={t.perMonth} hint={`${t.role1} / ${t.role2}`} testId="stats-months">
              <ColumnChart
                series={[t.role1, t.role2]}
                data={stats.byMonth.map((b) => ({ key: b.key, label: monthLabel(b.key, lang), values: [b.roles['1SR'], b.roles['2SR']], hint: `${monthLabel(b.key, lang)} ${b.key.slice(0, 4)}` }))}
              />
            </Block>
            <Block title={t.histogram} hint={`${t.histogramHint} · ${t.shareC} ${pctText(pct(T.ratingsC, T.ratingsAll))} · ${t.shareB} ${pctText(pct(T.ratingsBPlus, T.ratingsAll))}`} testId="stats-histogram">
              <ColumnChart
                series={[t.histogram]}
                slotWidth={26}
                soft={GRADE_ORDER.map((g, i) => (g.length > 1 ? i : -1)).filter((i) => i >= 0)}
                data={GRADE_ORDER.map((g) => ({ key: g, label: GRADE_LETTERS.includes(g) ? g : '', values: [stats.histogram[g] ?? 0], hint: g }))}
              />
            </Block>
          </div>

          {/* Sections + criteria */}
          <div className="grid md:grid-cols-2 gap-3">
            <Block title={t.sections} hint={t.normalCase} testId="stats-sections">
              {(['1SR', '2SR'] as StatRole[]).map((role) => {
                const rows: ScaleRow[] = stats.sections.filter((s) => s.role === role).map((s) => ({ key: `${role}-${s.section}`, label: sectionTitle(role, s.section, lang), avg: gradeAvg(s.grade), n: s.grade.obs }));
                return (
                  <div key={role} className="mb-3 last:mb-0">
                    <div className="text-[11px] font-semibold text-stone-500 mb-1">{roleLabel(role, lang)}</div>
                    {rows.length ? <GradeScale rows={rows} nLabel={t.nObs} /> : <p className="text-xs text-stone-400">–</p>}
                  </div>
                );
              })}
            </Block>
            <Block title={t.criteria} hint={t.normalCase} testId="stats-criteria">
              <div className="inline-flex rounded-lg border border-stone-200 p-0.5 mb-2 text-xs">
                {(['1SR', '2SR'] as StatRole[]).map((role) => (
                  <button key={role} type="button" onClick={() => setCriteriaRole(role)} className={cn('px-2.5 h-7 rounded-md', criteriaRole === role ? 'bg-slate-900 text-white' : 'text-stone-600 hover:bg-stone-100')}>{roleLabel(role, lang)}</button>
                ))}
              </div>
              {Array.from({ length: sectionCount(criteriaRole) }, (_, sectionIndex) => {
                const form = criteriaRole === '2SR' ? SECTIONS_2SR_DE : SECTIONS_1SR_DE;
                const rows: ScaleRow[] = form[sectionIndex].items.map((item) => {
                  const c = stats.criteria.find((x) => x.role === criteriaRole && x.id === item.id);
                  return { key: item.id, label: criterionLabel(criteriaRole, item.id, lang), avg: c ? gradeAvg(c.grade) : null, n: c?.grade.obs ?? 0 };
                });
                return (
                  <div key={sectionIndex} className="mb-3 last:mb-0">
                    <div className="text-[11px] font-semibold text-stone-500 mb-1">{sectionTitle(criteriaRole, sectionIndex, lang)}</div>
                    <GradeScale rows={rows} nLabel={t.nObs} />
                  </div>
                );
              })}
            </Block>
          </div>

          {/* Per RC, then group / level */}
          <div className="grid gap-3">
            <Block title={t.perRc} testId="stats-rcs">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-stone-400">
                      <th className="text-left font-medium py-1 pr-2">{t.rc}</th>
                      <th className="text-right font-medium py-1 px-1">{t.observations}</th>
                      <th className="text-right font-medium py-1 px-1">{t.coacheesCol}</th>
                      <th className="text-right font-medium py-1 px-1">{t.gamesCol}</th>
                      <th className="text-right font-medium py-1 px-1">{t.setsCol}</th>
                      <th className="text-right font-medium py-1 px-1">{t.wordsCol}</th>
                      <th className="text-right font-medium py-1 px-1">{t.gradeCol}</th>
                      <th className="text-left font-medium py-1 pl-2 min-w-[7rem]">{t.goalCol}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byRc.filter((r) => r.observations > 0 || r.goal > 0).map((r) => {
                      const a = gradeAvg(r.grade);
                      const fill = r.goal > 0 ? Math.min(100, (r.observations / r.goal) * 100) : 0;
                      return (
                        <tr key={r.key} className="border-t border-stone-100">
                          <td className="py-1 pr-2 text-stone-800 truncate max-w-[12rem]">{r.label}</td>
                          <td className="py-1 px-1 text-right tabular-nums font-medium">{fmtInt(r.observations)}</td>
                          <td className="py-1 px-1 text-right tabular-nums">{fmtInt(r.coachees)}</td>
                          <td className="py-1 px-1 text-right tabular-nums">{fmtInt(r.games)}</td>
                          <td className="py-1 px-1 text-right tabular-nums">{fmtInt(r.sets)}</td>
                          <td className="py-1 px-1 text-right tabular-nums">{fmtInt(r.words)}</td>
                          <td className="py-1 px-1 text-right tabular-nums" title={a === null ? t.tooFew(r.observations) : fmtDec(a)}>{a === null ? <span className="text-stone-400">{t.tooFew(r.observations)}</span> : <><b>{scoreToLetter(a)}</b> <span className="text-stone-500">{fmtDec(a)}</span></>}</td>
                          <td className="py-1 pl-2">
                            <div className="flex items-center gap-1.5" title={`${fmtInt(r.observations)} / ${fmtInt(r.goal)} · ${r.planned} ${t.planned} · ${r.outstanding} ${t.outstanding}`}>
                              <span className="h-2 flex-1 rounded-full bg-stone-100 overflow-hidden"><span className="block h-full rounded-full" style={{ width: `${fill}%`, background: fill >= 100 ? '#1f7a4d' : '#2a78d6' }} /></span>
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
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <Block title={t.perGroup} hint={t.observations} testId="stats-groups">
              <BarList rows={stats.byGroup.map((b) => bucketRow(b, groupKeyLabel(b.key, lang), t))} />
            </Block>
            <Block title={t.perLevel} hint={t.observations} testId="stats-levels">
              <BarList rows={stats.byLevel.map((b) => bucketRow(b, levelKeyLabel(b.key, lang), t))} />
              {stats.byStufe.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold text-stone-500 mb-1">{t.perStufe} · {t.avgGrade}</div>
                  <GradeScale rows={stats.byStufe.map((b) => ({ key: b.key, label: levelKeyLabel(b.key, lang), avg: gradeAvg(b.grade), n: b.observations }))} nLabel={t.nObs} />
                </div>
              )}
            </Block>
          </div>

          {/* Coverage + outcomes */}
          <div className="grid md:grid-cols-2 xl:grid-cols-5 gap-3">
            <Block title={t.coverage} hint={t.coverageHint} testId="stats-coverage">
              <BarList rows={['0', '1', '2', '3+'].map((k) => ({ key: k, label: t.visits(k), value: stats.coacheeVisits[k] ?? 0 }))} />
            </Block>
            {(['einstufung', 'motivation', 'spielniveau', 'secondBesuch'] as const).map((kind) => (
              <Block key={kind} title={kind === 'einstufung' ? t.einstufung : kind === 'motivation' ? t.motivation : kind === 'spielniveau' ? t.difficulty : t.secondVisit} testId={`stats-${kind}`}>
                <Donut emptyLabel="–" slices={OUTCOME_ORDER[kind].map((k) => ({ key: k, label: outcomeLabel(kind, k, lang), value: stats.outcomes[kind][k] ?? 0 }))} />
              </Block>
            ))}
          </div>

          {/* Leagues, games, writing, process */}
          <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-3">
            <Block title={t.perLeague} hint={t.observations} testId="stats-leagues">
              <BarList rows={stats.byLeague.slice(0, 10).map((b) => ({ key: b.key || '-', label: b.label || '–', value: b.observations }))} />
              <div className="mt-3 space-y-1.5">
                <BarList rows={stats.byCategory.map((b) => ({ key: b.key || '-', label: categoryLabel(b.key, lang), value: b.observations }))} />
                <div className="border-t border-stone-100" />
                <BarList rows={stats.byDivision.map((b) => ({ key: b.key || '-', label: divisionLabel(b.key, lang), value: b.observations }))} />
              </div>
            </Block>
            <Block title={t.gamesBlock} testId="stats-games">
              <KV rows={[
                [t.sets, fmtInt(T.sets)],
                [t.points, fmtInt(T.points)],
                [t.setsPerGame, T.games ? fmtDec(T.sets / T.games) : '–'],
                [t.deciders, `${fmtInt(T.deciders)} (${pctText(pct(T.deciders, T.games))})`],
                [t.longestGame, T.longestGame ? `${fmtInt(T.longestGame.points)} · ${T.longestGame.sets} ${t.sets}` : '–'],
                [t.estHours, `≈ ${fmtInt(estimatedHours(T.sets))} h`],
                [t.hallsSeen, fmtInt(T.halls)],
                [t.teamsSeen, fmtInt(T.teams)],
              ]} />
              {T.longestGame && <p className="mt-1.5 text-[11px] text-stone-400 truncate">{t.longestGame}: {T.longestGame.label}</p>}
            </Block>
            <Block title={t.writing} testId="stats-writing">
              <KV rows={[
                [t.words, fmtInt(T.words)],
                [t.chars, fmtInt(T.chars)],
                [t.perObs, T.observations ? fmtInt(T.words / T.observations) : '–'],
                [t.wordsMedian, T.wordsMedian !== null ? fmtInt(T.wordsMedian) : '–'],
                [t.longestRemark, fmtInt(T.longestRemark)],
                [t.pagesA4, fmtDec(a4Pages(T.words))],
                [`${t.filled}: ${t.highlights}`, pctText(pct(T.filledHighlights, T.observations))],
                [`${t.filled}: ${t.improvements}`, pctText(pct(T.filledImprovements, T.observations))],
                [`${t.filled}: ${t.goals}`, pctText(pct(T.filledGoals, T.observations))],
              ]} />
              {stats.byRc.some((r) => r.words > 0) && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold text-stone-500 mb-1">{t.wordsCol} · {t.perRc}</div>
                  <BarList rows={stats.byRc.filter((r) => r.words > 0).slice(0, 5).map((r) => ({ key: r.key, label: r.label, value: r.words }))} />
                </div>
              )}
            </Block>
            <Block title={t.process} testId="stats-process">
              <KV rows={[
                [t.filingMedian, T.filingMedianDays !== null ? t.days(Math.round(T.filingMedianDays)) : '–'],
                [t.sameDay, pctText(pct(T.filedSameDay, T.observations))],
                [t.late, pctText(pct(T.filedLate, T.observations))],
                [t.signedRef, pctText(pct(T.signedReferee, T.observations))],
                [t.signedRc, pctText(pct(T.signedRc, T.observations))],
                [t.completeness, pctText(pct(T.ratedItems, T.offeredItems))],
                [t.language, `DE ${fmtInt(T.langDE)} · EN ${fmtInt(T.langEN)}`],
              ]} />
              <div className="mt-3">
                <div className="text-[11px] font-semibold text-stone-500 mb-1">{t.srGoal}</div>
                <BarList rows={(Object.entries(stats.outcomes.srZiel) as Array<[string, number]>).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: srGoalLabel(k, lang), value: v }))} />
              </div>
            </Block>
          </div>

          {/* Fun + time of play */}
          <div className="grid md:grid-cols-3 gap-3">
            <Block title={t.fun} testId="stats-fun">
              <KV rows={[
                [t.busiestDay, stats.fun.busiestDay ? `${fmtInt(stats.fun.busiestDay.count)} · ${dayLabel(stats.fun.busiestDay.key, { year: true })}` : '–'],
                [t.topHall, stats.fun.topHall ? `${stats.fun.topHall.name} (${fmtInt(stats.fun.topHall.count)})` : '–'],
                [t.topCoachee, stats.fun.topCoachee ? `${stats.fun.topCoachee.name} (${fmtInt(stats.fun.topCoachee.count)})` : '–'],
                [t.topWriter, stats.fun.topWriter ? `${stats.fun.topWriter.name} (${fmtInt(stats.fun.topWriter.words)})` : '–'],
                [t.firstLast, stats.fun.first ? `${dayLabel(stats.fun.first, { year: true })} – ${stats.fun.last ? dayLabel(stats.fun.last, { year: true }) : ''}` : '–'],
              ]} />
            </Block>
            <Block title={t.weekday} hint={t.observations} testId="stats-weekday">
              <BarList rows={stats.byWeekday.map((b) => ({ key: b.key, label: weekdayKeyLabel(b.key, lang), value: b.observations }))} />
            </Block>
            <Block title={t.hour} hint={t.observations} testId="stats-hour">
              <BarList rows={stats.byHour.map((b) => ({ key: b.key, label: `${b.key}:00`, value: b.observations }))} />
            </Block>
          </div>

          <details className="text-[11px] text-stone-500">
            <summary className="cursor-pointer font-medium text-stone-600">{t.method}</summary>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">{t.methodLines.map((l) => <li key={l}>{l}</li>)}</ul>
            <p className="mt-1">{t.stand}: {dayLabel(stats.generatedAt, { year: true })}</p>
          </details>
        </div>
      )}
    </Card>
  );
}

function bucketRow(b: StatBucket, label: string, t: ReturnType<typeof statStrings>) {
  const a = gradeAvg(b.grade);
  return {
    key: b.key || '-',
    label,
    value: b.observations,
    sub: a === null ? `${b.coachees} ${t.coacheesCol}` : `${b.coachees} ${t.coacheesCol} · Ø ${scoreToLetter(a)}`,
    hint: `${label}: ${b.observations} · ${b.coachees} ${t.coacheesCol} · ${a === null ? t.tooFew(b.observations) : `Ø ${scoreToLetter(a)} ${fmtDec(a)}`}`,
  };
}

// The season in numbers (asked 2026-09-30): one view, drawn in two places —
// every coach's Saison tab and the head of the chair's Planung board — from
// one server computation (server/planning.ts → seasonProgress), so the two can
// never disagree. Aggregates only: nobody is named here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getSeasonProgress, type SeasonProgress } from '../lib/pocketbase';
import { monthLabel } from '../lib/statsLabels';
import { groupLabel } from '../lib/coacheeGroup';
import { dayLabel } from '../lib/appTime';
import { BarList, ColumnChart, StatTile, fmtInt, SERIES } from './StatsCharts';
import { SkeletonRows } from './Skeleton';

type Lang = 'DE' | 'EN';

const STR = {
  DE: {
    visits: 'Beobachtungen', of: (goal: number) => `von ${fmtInt(goal)} (Pensum aller RCs)`,
    planned: 'Geplant', plannedSub: 'übernommen, Bericht offen',
    covered: 'Coachees beobachtet', coveredSub: (n: number) => `von ${fmtInt(n)} aktiven`,
    waiting: 'Noch ohne Besuch', waitingSub: (n: number) => (n ? `${fmtInt(n)} mit weiterem Besuch gewünscht` : 'und nicht gebucht'),
    left: 'Tage bis Saisonende', leftSub: (d: string) => (d ? `letztes Spiel ${d}` : ''),
    byMonth: 'Pro Monat', done: 'Beobachtet', booked: 'Geplant',
    byGroup: 'Beobachtet pro Gruppe', noGroup: 'ohne Gruppe',
    fail: 'Die Saison konnte nicht geladen werden.',
  },
  EN: {
    visits: 'Observations', of: (goal: number) => `of ${fmtInt(goal)} (all coaches' targets)`,
    planned: 'Planned', plannedSub: 'taken, report open',
    covered: 'Coachees observed', coveredSub: (n: number) => `of ${fmtInt(n)} active`,
    waiting: 'No visit yet', waitingSub: (n: number) => (n ? `${fmtInt(n)} with a further visit wanted` : 'and not booked'),
    left: 'Days to season end', leftSub: (d: string) => (d ? `last game ${d}` : ''),
    byMonth: 'Per month', done: 'Observed', booked: 'Planned',
    byGroup: 'Observed per group', noGroup: 'no group',
    fail: 'Could not load the season.',
  },
};

/** The figures themselves. `compact` is the Planung head: tiles only. */
export function SeasonProgressView({ progress, lang, compact }: { progress: SeasonProgress; lang: Lang; compact?: boolean }) {
  const L = STR[lang];
  const p = progress;
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '–');
  return (
    <div className="space-y-4" data-testid="season-progress">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatTile hero label={L.visits} value={fmtInt(p.visits.done)} sub={p.visits.goal > 0 ? `${L.of(p.visits.goal)} · ${pct(p.visits.done, p.visits.goal)}` : undefined} />
        <StatTile label={L.planned} value={fmtInt(p.visits.planned)} sub={L.plannedSub} />
        <StatTile label={L.covered} value={pct(p.coachees.observed, p.coachees.active)} sub={`${fmtInt(p.coachees.observed)} ${L.coveredSub(p.coachees.active)}`} />
        {compact
          ? <StatTile label={L.waiting} value={fmtInt(p.coachees.waiting)} sub={L.waitingSub(p.coachees.furtherWanted)} />
          : <StatTile label={L.left} value={p.daysLeft == null ? '–' : fmtInt(p.daysLeft)} sub={L.leftSub(p.lastGameDate ? dayLabel(p.lastGameDate, { year: true }) : '')} />}
      </div>
      {!compact && (
        <>
          {p.byMonth.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-stone-800 mb-1">{L.byMonth}</h3>
              <ColumnChart
                series={[L.done, L.booked]}
                slotWidth={40}
                height={160}
                data={p.byMonth.map((m) => ({ key: m.month, label: monthLabel(m.month, lang), values: [m.done, m.planned], hint: `${monthLabel(m.month, lang)} ${m.month.slice(0, 4)}` }))}
              />
            </section>
          )}
          {p.byGroup.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold text-stone-800 mb-1">{L.byGroup}</h3>
              <BarList
                color={SERIES[0]}
                max={100}
                format={(n) => `${Math.round(n)} %`}
                rows={p.byGroup.map((g) => ({
                  key: g.group || '-',
                  label: g.group ? (groupLabel(g.group, lang) || g.group) : L.noGroup,
                  value: g.active > 0 ? (g.observed / g.active) * 100 : 0,
                  sub: `${fmtInt(g.observed)} / ${fmtInt(g.active)}`,
                }))}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** The coach app's Saison tab: fetches on its own, one loading state until the
 *  first answer, the old figures kept while a later one is on its way. */
export default function SeasonTab({ lang, season, seasonSettled }: { lang: Lang; season: number; seasonSettled: boolean }) {
  const L = STR[lang];
  const [progress, setProgress] = useState<SeasonProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const load = useCallback(async () => {
    const ticket = ++seq.current;
    setLoading(true); setErr('');
    try {
      const p = await getSeasonProgress(season);
      if (ticket === seq.current) setProgress(p);
    } catch { if (ticket === seq.current) setErr(L.fail); }
    finally { if (ticket === seq.current) setLoading(false); }
  }, [season, L]);
  // Asked for once the stored season is known — the local guess before it is
  // last season's in August — and again on every visit to the tab.
  useEffect(() => { if (seasonSettled) void load(); }, [seasonSettled, load]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold text-stone-900">{lang === 'DE' ? 'Saison' : 'Season'} {season}/{String(season + 1).slice(2)}</h2>
        {loading && progress && <Loader2 size={14} className="animate-spin text-stone-400" />}
      </div>
      {progress ? <SeasonProgressView progress={progress} lang={lang} />
        : err ? <p className="text-sm text-red-700">{err}</p>
        : <SkeletonRows rows={6} />}
    </div>
  );
}


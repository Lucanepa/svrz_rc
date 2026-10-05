import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import BudgetCard, { chf } from './BudgetCard';
import { getFinance, type FinanceData } from '../lib/pocketbase';
import { computeBudget } from '../lib/budget';

/**
 * The chair's Finanzen tab: the same budget card the admin has on Finanzen &
 * Betrieb — budget and extras editable — and, under it, what each coach can
 * claim. Read from /api/finance, the one read her login is given for this
 * (Jasmin, 2026-10-05: "budget si"); marking a payout or ticking a meeting
 * stays in the admin's half.
 */

type Lang = 'DE' | 'EN';

const STR = {
  DE: { coach: 'Referee Coach', paid: 'Erledigt', upcoming: 'Geplant & offen', claim: 'CHF', paidOut: 'Ausbezahlt', none: 'Keine Referee Coaches in dieser Saison.' },
  EN: { coach: 'Referee coach', paid: 'Completed', upcoming: 'Planned & outstanding', claim: 'CHF', paidOut: 'Paid out', none: 'No referee coaches this season.' },
};

const surnameFirst = (name: string) => {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`;
};

export default function FinanceChair({ lang }: { lang: Lang }) {
  const t = STR[lang];
  const [data, setData] = useState<FinanceData | null>(null);
  const [err, setErr] = useState('');

  // The season is the server's default one: the chair's console never loads
  // the settings that would name it.
  useEffect(() => {
    let live = true;
    getFinance().then((d) => { if (live) setData(d); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, []);

  const perRc = useMemo(() => (data
    ? computeBudget({ rows: data.rows, cap: data.cap, visitRate: data.visitRate, meetings: data.meetings, settings: data.budget }).perRc
    : {}), [data]);
  const rows = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => surnameFirst(a.fullName).localeCompare(surnameFirst(b.fullName), 'de')), [data]);

  if (err) return <p className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>;
  if (!data) return <div className="py-12 flex justify-center"><Loader2 size={20} className="animate-spin text-stone-300" /></div>;

  return (
    <div data-testid="finance-chair">
      <BudgetCard lang={lang} season={data.season} settingsLoading={false} rows={data.rows} cap={data.cap} visitRate={data.visitRate} meetings={data.meetings} />
      <div className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4 overflow-x-auto">
        {rows.length === 0 ? <p className="text-sm text-stone-400">{t.none}</p> : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-stone-200 text-left text-xs text-stone-500">
                <th className="py-2 pr-3 font-semibold">{t.coach}</th>
                <th className="py-2 pr-3 font-semibold text-right">{t.paid}</th>
                <th className="py-2 pr-3 font-semibold text-right">{t.upcoming}</th>
                <th className="py-2 font-semibold text-right">{t.claim}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = perRc[r.id];
                return (
                  <tr key={r.id} className="border-b border-stone-100 last:border-0">
                    <td className="py-2 pr-3 text-stone-800">{r.fullName}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-stone-600">{c?.paidGames ?? 0}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-stone-600">{c?.upcomingGames ?? 0}</td>
                    <td className="py-2 text-right tabular-nums text-stone-800 whitespace-nowrap">
                      {chf(c?.claim ?? 0)}
                      {r.paidAt && <Check size={13} aria-label={t.paidOut} className="ml-1 inline-block align-[-2px] text-emerald-600" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

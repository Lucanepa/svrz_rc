import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { confirmDialog, toast } from './ui';
import { getBudget, putBudget } from '../lib/pocketbase';
import { computeBudget, normalizeBudget, type BudgetMeeting, type BudgetRow, type BudgetSettings } from '../lib/budget';

/**
 * Admin → Finance & Operations: the season's budget against what it pays — the
 * visits (Vergütet × rate), the games taken but not yet filed, the meetings
 * (attendees × each meeting's rate) and any extras — and what is left. The
 * sums are src/lib/budget.ts over the same rows the table below shows.
 */

type Lang = 'DE' | 'EN';

const STR = {
  DE: {
    title: (s: string) => `Budget ${s}`,
    hint: 'Was die Saison zur Verfügung hat und was davon schon gebunden ist. Geplante und offene Spiele zählen schon mit — so bleibt, womit du noch planen kannst.',
    remaining: 'Verbleibend', over: 'Budget überschritten',
    budget: 'Budget', edit: 'Ändern', save: 'Speichern', cancel: 'Abbrechen', remove: 'Entfernen',
    visits: 'Besuche erledigt', upcoming: 'Besuche geplant & offen', meetings: 'RC-Sitzungen', extras: 'Extras',
    games: (n: number, rate: string) => `${n} Spiel${n === 1 ? '' : 'e'} × CHF ${rate}`,
    attendances: (n: number) => `${n} Teilnahme${n === 1 ? '' : 'n'} · Ansatz pro Sitzung`,
    noExtras: 'keine',
    addExtra: 'Extra hinzufügen', extraLabel: 'Bezeichnung', extraAmount: 'CHF',
    delExtra: (l: string) => `Extra «${l}» entfernen?`,
    delExtraBody: 'Der Betrag wird nicht mehr vom Budget abgezogen.',
    paidOut: 'Ausbezahlt', owed: 'Noch auszuzahlen',
    saved: 'Budget gespeichert.',
    legendSpent: 'gebraucht', legendUpcoming: 'geplant & offen', legendLeft: 'frei',
  },
  EN: {
    title: (s: string) => `Budget ${s}`,
    hint: 'What the season has to spend and how much of it is already committed. Planned and outstanding games count already — what is left is what you can still plan with.',
    remaining: 'Remaining', over: 'Over budget',
    budget: 'Budget', edit: 'Change', save: 'Save', cancel: 'Cancel', remove: 'Remove',
    visits: 'Visits completed', upcoming: 'Visits planned & outstanding', meetings: 'RC meetings', extras: 'Extras',
    games: (n: number, rate: string) => `${n} game${n === 1 ? '' : 's'} × CHF ${rate}`,
    attendances: (n: number) => `${n} attendance${n === 1 ? '' : 's'} · rate per meeting`,
    noExtras: 'none',
    addExtra: 'Add extra', extraLabel: 'Description', extraAmount: 'CHF',
    delExtra: (l: string) => `Remove the extra “${l}”?`,
    delExtraBody: 'Its amount is no longer taken off the budget.',
    paidOut: 'Paid out', owed: 'Still to pay out',
    saved: 'Budget saved.',
    legendSpent: 'spent', legendUpcoming: 'planned & outstanding', legendLeft: 'left',
  },
};

const chfFmt = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const chf = (n: number) => chfFmt.format(n);

const input = 'h-9 px-3 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500';
const btnPrimary = 'inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-stone-300 transition-colors';
const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50 transition-colors';

export default function BudgetCard({ lang, season, settingsLoading, rows, cap, visitRate, meetings }: {
  lang: Lang;
  season: number;
  settingsLoading: boolean;
  rows: BudgetRow[];
  cap: number | null;
  visitRate: number;
  meetings: BudgetMeeting[];
}) {
  const t = STR[lang];
  const [settings, setSettings] = useState<BudgetSettings | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editBudget, setEditBudget] = useState<string | null>(null);
  const [extra, setExtra] = useState<{ label: string; amount: string } | null>(null);

  useEffect(() => {
    if (settingsLoading) return;
    let live = true;
    setSettings(null);
    getBudget(season).then((s) => { if (live) setSettings(s); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [season, settingsLoading]);

  const sum = useMemo(
    () => computeBudget({ rows, cap, visitRate, meetings, settings: settings ?? normalizeBudget(null) }),
    [rows, cap, visitRate, meetings, settings],
  );

  const save = async (next: BudgetSettings) => {
    setBusy(true); setErr('');
    try {
      setSettings(await putBudget(season, next));
      toast.success(t.saved, { lang });
      return true;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return false; }
    finally { setBusy(false); }
  };

  const saveBudget = async () => {
    const n = Number(editBudget);
    if (!settings || !Number.isFinite(n) || n < 0) return;
    if (await save({ ...settings, budget: Math.round(n * 100) / 100 })) setEditBudget(null);
  };

  const addExtra = async () => {
    if (!settings || !extra) return;
    const amount = Number(extra.amount);
    if (!extra.label.trim() || !Number.isFinite(amount) || amount < 0) return;
    const id = `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (await save({ ...settings, extras: [...settings.extras, { id, label: extra.label.trim(), amount: Math.round(amount * 100) / 100 }] })) setExtra(null);
  };

  const removeExtra = async (id: string, label: string) => {
    if (!settings) return;
    if (!(await confirmDialog({ title: t.delExtra(label), message: t.delExtraBody, confirmLabel: t.remove, tone: 'danger', lang }))) return;
    await save({ ...settings, extras: settings.extras.filter((e) => e.id !== id) });
  };

  const seasonLabel = `${season}/${String((season + 1) % 100).padStart(2, '0')}`;
  const over = sum.remaining < 0;
  const pct = (n: number) => (sum.budget > 0 ? Math.max(0, Math.min(100, (n / sum.budget) * 100)) : 0);
  const spentPct = pct(sum.spent);
  const upcomingPct = Math.min(100 - spentPct, pct(sum.upcomingVisits));

  const line = (label: string, detail: string, amount: number, minus = true, testId?: string) => (
    <div className="flex items-baseline justify-between gap-3 py-1.5" data-testid={testId}>
      <span className="min-w-0">
        <span className="text-sm text-stone-700">{label}</span>
        {detail && <span className="ml-2 text-xs text-stone-400">{detail}</span>}
      </span>
      <span className="text-sm tabular-nums text-stone-700 whitespace-nowrap">{minus && amount > 0 ? '− ' : ''}{chf(amount)}</span>
    </div>
  );

  return (
    <div data-testid="budget-card" className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-stone-700">{t.title(seasonLabel)}</h2>
          <p className="text-xs text-stone-400 mt-0.5 max-w-xl">{t.hint}</p>
        </div>
        <div className="text-right" data-testid="budget-remaining">
          <p className={`text-[11px] font-semibold uppercase tracking-wide ${over ? 'text-red-700' : 'text-stone-400'}`}>{over ? t.over : t.remaining}</p>
          <p className={`text-2xl font-bold tabular-nums ${over ? 'text-red-700' : 'text-stone-900'}`}>
            {settings ? `CHF ${chf(sum.remaining)}` : <Loader2 size={18} className="inline animate-spin text-stone-300" />}
          </p>
        </div>
      </div>

      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-stone-200 flex" aria-hidden>
        <div className="h-full bg-red-600" style={{ width: `${spentPct}%` }} />
        <div className="h-full bg-red-300" style={{ width: `${upcomingPct}%` }} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-500">
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-600" />{t.legendSpent}</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-300" />{t.legendUpcoming}</span>
        <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-stone-300" />{t.legendLeft}</span>
      </div>

      <div className="mt-3 divide-y divide-stone-100 border-t border-stone-100">
        <div className="flex flex-wrap items-center justify-between gap-3 py-1.5" data-testid="budget-amount">
          <span className="text-sm font-medium text-stone-800">{t.budget}</span>
          {editBudget == null ? (
            <span className="inline-flex items-center gap-2">
              <span className="text-sm font-semibold tabular-nums text-stone-900">{settings ? chf(sum.budget) : '…'}</span>
              <button type="button" className={btnGhost} disabled={!settings} onClick={() => setEditBudget(String(sum.budget))} aria-label={t.edit}><Pencil size={12} /> {t.edit}</button>
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <input type="number" min={0} step="50" inputMode="decimal" aria-label={t.budget} className={`${input} w-32`} value={editBudget} onChange={(e) => setEditBudget(e.target.value)} />
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => void saveBudget()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t.save}</button>
              <button type="button" className={btnGhost} onClick={() => setEditBudget(null)}><X size={12} /></button>
            </span>
          )}
        </div>
        {line(t.visits, t.games(sum.paidGames, chf(visitRate)), sum.visits, true, 'budget-visits')}
        {line(t.upcoming, t.games(sum.upcomingGames, chf(visitRate)), sum.upcomingVisits, true, 'budget-upcoming')}
        {line(t.meetings, t.attendances(sum.meetingAttendances), sum.meetings, true, 'budget-meetings')}
        <div className="py-1.5" data-testid="budget-extras">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm text-stone-700">{t.extras}{settings && settings.extras.length === 0 && <span className="ml-2 text-xs text-stone-400">{t.noExtras}</span>}</span>
            <span className="text-sm tabular-nums text-stone-700">{sum.extras > 0 ? '− ' : ''}{chf(sum.extras)}</span>
          </div>
          {settings?.extras.map((e) => (
            <div key={e.id} className="mt-1 flex items-center justify-between gap-3 pl-3 text-xs text-stone-500">
              <span className="truncate">{e.label}</span>
              <span className="inline-flex items-center gap-2 tabular-nums">
                {chf(e.amount)}
                <button type="button" className="text-stone-400 hover:text-red-700" disabled={busy} onClick={() => void removeExtra(e.id, e.label)} aria-label={t.delExtra(e.label)}><Trash2 size={12} /></button>
              </span>
            </div>
          ))}
          {extra ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-3">
              <input className={`${input} flex-1 min-w-[10rem]`} placeholder={t.extraLabel} aria-label={t.extraLabel} value={extra.label} onChange={(e) => setExtra({ ...extra, label: e.target.value })} maxLength={120} />
              <input type="number" min={0} step="0.05" inputMode="decimal" className={`${input} w-28`} placeholder={t.extraAmount} aria-label={t.extraAmount} value={extra.amount} onChange={(e) => setExtra({ ...extra, amount: e.target.value })} />
              <button type="button" className={btnPrimary} disabled={busy} onClick={() => void addExtra()}><Check size={14} /> {t.save}</button>
              <button type="button" className={btnGhost} onClick={() => setExtra(null)}><X size={12} /></button>
            </div>
          ) : (
            <button type="button" className={`${btnGhost} mt-1.5 ml-3`} disabled={!settings} onClick={() => setExtra({ label: '', amount: '' })}><Plus size={12} /> {t.addExtra}</button>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <span className="text-sm font-semibold text-stone-900">{t.remaining}</span>
          <span className={`text-sm font-bold tabular-nums ${over ? 'text-red-700' : 'text-stone-900'}`}>{chf(sum.remaining)}</span>
        </div>
      </div>

      <p className="mt-1 text-xs text-stone-500" data-testid="budget-payout">
        {t.paidOut} CHF {chf(sum.paidOut)} · {t.owed} CHF {chf(sum.owed)}
      </p>
      {err && <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
    </div>
  );
}

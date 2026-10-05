import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, KeyRound, Loader2, RotateCcw, Search } from 'lucide-react';
import { confirmDialog, toast } from './ui';
import {
  backfillCoacheeFilePins, coacheeFilePin, getCoacheeFileAdmin, listCoacheeFilePins,
  type CoacheeFilePerson,
} from '../lib/pocketbase';

/**
 * Admin → E-Mails: the coachee file (/dossier). Every referee with a report
 * and their PIN, to hand out by hand — no mail tells coachees for now (Luca,
 * 2026-10-05; the chair wants to wait for Swiss Volley's acceptance). A PIN
 * is minted when a report is filed; "Fehlende PINs erzeugen" mints them for
 * the reports filed before. There is deliberately no switch here for the PIN
 * mail: turning it on is a database write, not a click.
 */

type Lang = 'DE' | 'EN';

const STR = {
  DE: {
    title: 'Coaching-Dossier für Coachees',
    badge: 'Keine E-Mails an Coachees',
    hint: 'Coachees sehen unter /dossier alle Berichte, die sie erhalten haben — mit SV-Nr. und persönlichem 6-stelligem PIN. Jede:r mit SV-Nr. erhält beim ersten Bericht automatisch einen PIN. Es wird nichts an Coachees versendet: PINs gibst du selbst weiter.',
    mailOn: 'Achtung: Der PIN-Versand ist in der Datenbank eingeschaltet.',
    backfill: (n: number) => `Fehlende PINs erzeugen (${n})`,
    backfillDone: (n: number) => `${n} PIN${n === 1 ? '' : 's'} erzeugt.`,
    search: 'Name oder SV-Nr.…',
    people: (n: number) => `${n} Person${n === 1 ? '' : 'en'}`,
    none: 'Noch keine Berichte mit SV-Nr.',
    noPin: 'kein PIN',
    reports: (n: number) => `${n} Bericht${n === 1 ? '' : 'e'}`,
    copy: 'Text kopieren',
    copied: 'Kopiert — zum Weitergeben an die Person.',
    shareText: (url: string, sv: string, pin: string, name: string) =>
      `Hallo${name ? ` ${name.split(/\s+/)[0]}` : ''}, alle deine Coaching-Berichte findest du in deinem Coaching-Dossier: ${url}\nSV-Nr.: ${sv}\nPIN: ${pin}\nDer PIN gehört nur dir — bitte nicht weitergeben.`,
    reset: 'Neuer PIN',
    resetTitle: (who: string) => `Neuen PIN für ${who}?`,
    resetBody: 'Der bisherige PIN gilt sofort nicht mehr, offene Sitzungen enden. Den neuen PIN musst du selbst weitergeben.',
    other: 'Andere SV-Nr.',
    otherHint: 'Für eine SV-Nr. ohne Bericht: erzeugt einen PIN. Es wird nichts versendet.',
    show: 'PIN anzeigen',
    sv: 'SV-Nr.',
    open: 'Seite öffnen',
  },
  EN: {
    title: 'Coaching file for coachees',
    badge: 'No e-mails to coachees',
    hint: 'Coachees see every report they received at /dossier — with their SV no. and a personal 6-digit PIN. Everyone with an SV no. gets a PIN automatically with their first report. Nothing is sent to coachees: you pass the PINs on yourself.',
    mailOn: 'Warning: the PIN mail is switched on in the database.',
    backfill: (n: number) => `Create missing PINs (${n})`,
    backfillDone: (n: number) => `${n} PIN${n === 1 ? '' : 's'} created.`,
    search: 'Name or SV no.…',
    people: (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`,
    none: 'No reports with an SV no. yet.',
    noPin: 'no PIN',
    reports: (n: number) => `${n} report${n === 1 ? '' : 's'}`,
    copy: 'Copy text',
    copied: 'Copied — to pass on to the person.',
    // The referees are German-speaking; the text handed to them stays German.
    shareText: (url: string, sv: string, pin: string, name: string) =>
      `Hallo${name ? ` ${name.split(/\s+/)[0]}` : ''}, alle deine Coaching-Berichte findest du in deinem Coaching-Dossier: ${url}\nSV-Nr.: ${sv}\nPIN: ${pin}\nDer PIN gehört nur dir — bitte nicht weitergeben.`,
    reset: 'New PIN',
    resetTitle: (who: string) => `New PIN for ${who}?`,
    resetBody: 'The old PIN stops working at once and open sessions end. You have to pass the new PIN on yourself.',
    other: 'Other SV no.',
    otherHint: 'For an SV no. without a report: creates a PIN. Nothing is sent.',
    show: 'Show PIN',
    sv: 'SV no.',
    open: 'Open page',
  },
};

const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50 transition-colors';

const fmtDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

export default function CoacheeFileAdmin({ lang }: { lang: Lang }) {
  const t = STR[lang];
  const [meta, setMeta] = useState<{ enabled: boolean; url: string } | null>(null);
  const [people, setPeople] = useState<CoacheeFilePerson[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [sv, setSv] = useState('');
  const [looked, setLooked] = useState<{ sv: string; pin: string; name: string } | null>(null);

  const load = useCallback(() => {
    Promise.all([getCoacheeFileAdmin(), listCoacheeFilePins()])
      .then(([m, p]) => { setMeta(m); setPeople(p); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const missing = people?.filter((p) => !p.pin && p.reports > 0).length ?? 0;
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return (people ?? []).filter((p) => !q || fold(`${p.name} ${p.sv}`).includes(q));
  }, [people, query]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setErr('');
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const backfill = () => run('backfill', async () => {
    const n = await backfillCoacheeFilePins();
    toast.success(t.backfillDone(n));
    load();
  });

  const reset = async (p: CoacheeFilePerson) => {
    if (!(await confirmDialog({ title: t.resetTitle(p.name || p.sv), message: t.resetBody, confirmLabel: t.reset, tone: 'danger', lang }))) return;
    await run(`reset:${p.sv}`, async () => { await coacheeFilePin(p.sv, true); load(); });
  };

  const copy = async (p: { sv: string; pin: string; name: string }) => {
    try {
      await navigator.clipboard.writeText(t.shareText(meta?.url || '', p.sv, p.pin, p.name));
      toast.success(t.copied);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const lookup = () => run('lookup', async () => {
    const r = await coacheeFilePin(sv, false);
    setLooked(r);
    load();
  });

  return (
    <div data-testid="coachee-file-admin" className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h3 className="text-sm font-semibold text-stone-800">{t.title}</h3>
        <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-amber-100 text-amber-800">{t.badge}</span>
      </div>
      <p className="text-xs text-stone-500 mb-3">{t.hint}</p>
      {meta?.enabled && (
        <p className="mb-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{t.mailOn}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400 pointer-events-none" />
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.search} aria-label={t.search}
            className="w-full h-8 pl-8 pr-2.5 rounded-lg border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-700/20"
          />
        </div>
        <button type="button" className={btnGhost} disabled={!!busy || missing === 0} onClick={() => void backfill()}>
          {busy === 'backfill' ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t.backfill(missing)}
        </button>
        {meta?.url && (
          <a href={meta.url} target="_blank" rel="noopener noreferrer" className={btnGhost}><ExternalLink size={13} /> {t.open}</a>
        )}
      </div>

      {people === null && !err && <div className="py-6 flex justify-center"><Loader2 size={18} className="animate-spin text-stone-300" /></div>}
      {people && people.length === 0 && <p className="py-4 text-sm text-stone-400 text-center">{t.none}</p>}
      {people && people.length > 0 && (
        <>
          <p className="mb-1.5 text-[11px] text-stone-400">{t.people(shown.length)}</p>
          <ul data-log-redact className="divide-y divide-stone-100 border border-stone-200 rounded-xl max-h-[28rem] overflow-y-auto">
            {shown.map((p) => (
              <li key={p.sv} data-testid="coachee-file-person" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-stone-800 truncate">{p.name || '—'}</p>
                  <p className="text-[11px] text-stone-400">
                    {t.sv} {p.sv} · {t.reports(p.reports)}{p.lastDate ? ` · ${fmtDate(p.lastDate)}` : ''}
                  </p>
                </div>
                {p.pin
                  ? <span className="font-mono text-sm font-semibold tracking-[0.2em] text-stone-900">{p.pin}</span>
                  : <span className="text-xs text-stone-400">{t.noPin}</span>}
                <div className="flex items-center gap-1.5">
                  <button type="button" className={btnGhost} disabled={!p.pin} onClick={() => void copy(p)} aria-label={t.copy} title={t.copy}>
                    <Copy size={13} />
                  </button>
                  <button type="button" className={btnGhost} disabled={!!busy} onClick={() => void reset(p)} aria-label={t.reset} title={t.reset}>
                    {busy === `reset:${p.sv}` ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="mt-4 pt-4 border-t border-stone-100">
        <p className="text-xs font-semibold uppercase tracking-wide text-stone-500 mb-2">{t.other}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={sv} onChange={(e) => setSv(e.target.value)} inputMode="numeric" placeholder={t.sv} aria-label={t.sv}
            className="h-8 w-32 px-2.5 rounded-lg border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-700/20"
          />
          <button type="button" className={btnGhost} disabled={!!busy || !sv.trim()} onClick={() => void lookup()}>
            {busy === 'lookup' ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t.show}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-stone-400">{t.otherHint}</p>
        {looked && (
          <div data-log-redact className="mt-3 flex items-center gap-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-stone-700">{looked.name || '—'} · {t.sv} {looked.sv}</p>
              <p className="mt-0.5 font-mono text-xl font-bold tracking-[0.3em] text-stone-900">{looked.pin}</p>
            </div>
            <button type="button" className={btnGhost} onClick={() => void copy(looked)}><Copy size={13} /> {t.copy}</button>
          </div>
        )}
      </div>
      {err && <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
    </div>
  );
}

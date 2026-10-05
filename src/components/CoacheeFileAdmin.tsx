import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Loader2, RotateCcw } from 'lucide-react';
import { confirmDialog } from './ui';
import { coacheeFilePin, getCoacheeFileAdmin, setCoacheeFileEnabled } from '../lib/pocketbase';

/**
 * Admin → E-Mails: the coachee file (/dossier). One switch — the PIN mail that
 * goes to the referee with every report, the only way a coachee ever learns a
 * PIN — and a PIN looked up by SV-Nr., so the page can be tried before anyone
 * is told and "I lost my PIN" can be answered later.
 *
 * Off on purpose until the chair says go (Jasmin, 2026-10-04: wait for Swiss
 * Volley's acceptance). Turning it on asks first.
 */

type Lang = 'DE' | 'EN';

const STR = {
  DE: {
    title: 'Coaching-Dossier für Coachees',
    off: 'Nicht ausgerollt', on: 'Aktiv',
    hint: 'Coachees sehen unter /dossier alle Berichte, die sie erhalten haben — mit SV-Nr. und persönlichem 6-stelligem PIN. Den PIN erhalten sie in einer separaten E-Mail (nur an sie, ohne RC und Kommission) mit jedem Bericht.',
    toggle: 'PIN-Mail mit jedem Bericht senden',
    toggleHint: 'Solange aus, kennt kein Coachee einen PIN — die Seite öffnet sich nur mit einem PIN, den du hier erzeugst.',
    confirmTitle: 'Coaching-Dossier ausrollen?',
    confirmBody: 'Ab dem nächsten Bericht erhält jede:r Schiedsrichter:in mit SV-Nr. eine zweite E-Mail mit dem PIN zum Dossier. Die RC-Vorsitzende wollte damit warten, bis Swiss Volley das Tool akzeptiert hat.',
    confirmOk: 'Ausrollen',
    pins: (n: number) => `${n} PIN${n === 1 ? '' : 's'} vergeben`,
    lookup: 'PIN nachschlagen',
    sv: 'SV-Nr.',
    show: 'PIN anzeigen',
    reset: 'Neuen PIN',
    resetTitle: 'Neuen PIN erzeugen?',
    resetBody: 'Der bisherige PIN gilt sofort nicht mehr, offene Sitzungen enden. Der neue PIN geht mit dem nächsten Bericht raus — oder du gibst ihn selbst weiter.',
    lookupHint: 'Erzeugt einen PIN, falls die Person noch keinen hat. Es wird nichts versendet.',
    reports: (n: number) => `${n} Bericht${n === 1 ? '' : 'e'} mit dieser SV-Nr.`,
    open: 'Seite öffnen',
  },
  EN: {
    title: 'Coaching file for coachees',
    off: 'Not rolled out', on: 'Live',
    hint: 'Coachees see every report they received at /dossier — with their SV no. and a personal 6-digit PIN. The PIN reaches them in a separate e-mail (to them only, without the RC and the commission) with every report.',
    toggle: 'Send the PIN mail with every report',
    toggleHint: 'While off, no coachee knows a PIN — the page opens only with a PIN you create here.',
    confirmTitle: 'Roll out the coaching file?',
    confirmBody: 'From the next report on, every referee with an SV no. receives a second e-mail with the PIN to their file. The RC chair wanted to wait until Swiss Volley has accepted the tool.',
    confirmOk: 'Roll out',
    pins: (n: number) => `${n} PIN${n === 1 ? '' : 's'} issued`,
    lookup: 'Look up a PIN',
    sv: 'SV no.',
    show: 'Show PIN',
    reset: 'New PIN',
    resetTitle: 'Create a new PIN?',
    resetBody: 'The old PIN stops working at once and open sessions end. The new PIN goes out with the next report — or you pass it on yourself.',
    lookupHint: 'Creates a PIN if the person has none yet. Nothing is sent.',
    reports: (n: number) => `${n} report${n === 1 ? '' : 's'} under this SV no.`,
    open: 'Open page',
  },
};

const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50 transition-colors';

export default function CoacheeFileAdmin({ lang }: { lang: Lang }) {
  const t = STR[lang];
  const [state, setState] = useState<{ enabled: boolean; pinCount: number; url: string } | null>(null);
  const [err, setErr] = useState('');
  const [sv, setSv] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ sv: string; pin: string; name: string; reports: number } | null>(null);

  useEffect(() => {
    getCoacheeFileAdmin().then(setState).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const toggle = async (next: boolean) => {
    if (!state) return;
    if (next && !(await confirmDialog({ title: t.confirmTitle, message: t.confirmBody, confirmLabel: t.confirmOk, tone: 'danger', lang }))) return;
    const previous = state.enabled;
    setState({ ...state, enabled: next });
    setErr('');
    try { await setCoacheeFileEnabled(next); }
    catch (e) {
      setState((s) => (s ? { ...s, enabled: previous } : s));
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const lookup = async (reset: boolean) => {
    if (reset && !(await confirmDialog({ title: t.resetTitle, message: t.resetBody, confirmLabel: t.reset, tone: 'danger', lang }))) return;
    setBusy(true); setErr(''); setResult(null);
    try {
      const r = await coacheeFilePin(sv, reset);
      setResult(r);
      getCoacheeFileAdmin().then(setState).catch(() => {});
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div data-testid="coachee-file-admin" className="bg-white rounded-2xl shadow-card border border-stone-200/70 p-4 sm:p-5 mb-4">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-sm font-semibold text-stone-800">{t.title}</h3>
        {state && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${state.enabled ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
            {state.enabled ? t.on : t.off}
          </span>
        )}
      </div>
      <p className="text-xs text-stone-500 mb-3">{t.hint}</p>

      <label className="flex items-start gap-3 cursor-pointer">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-red-600" checked={!!state?.enabled} disabled={!state}
          onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <span className="block text-sm font-medium text-stone-700">{t.toggle}</span>
          <span className="block text-xs text-stone-400">{t.toggleHint}</span>
        </span>
      </label>

      <div className="mt-4 pt-4 border-t border-stone-100">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">{t.lookup}</p>
          {state && <span className="text-[11px] text-stone-400">{t.pins(state.pinCount)}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={sv} onChange={(e) => setSv(e.target.value)} inputMode="numeric" placeholder={t.sv} aria-label={t.sv}
            className="h-8 w-32 px-2.5 rounded-lg border border-stone-200 text-sm focus:outline-none focus:ring-2 focus:ring-red-700/20"
          />
          <button type="button" className={btnGhost} disabled={busy || !sv.trim()} onClick={() => void lookup(false)}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <KeyRound size={13} />} {t.show}
          </button>
          <button type="button" className={btnGhost} disabled={busy || !sv.trim()} onClick={() => void lookup(true)}>
            <RotateCcw size={13} /> {t.reset}
          </button>
          {state?.url && (
            <a href={state.url} target="_blank" rel="noopener noreferrer" className={btnGhost}><ExternalLink size={13} /> {t.open}</a>
          )}
        </div>
        <p className="mt-1.5 text-[11px] text-stone-400">{t.lookupHint}</p>
        {result && (
          <div data-log-redact className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-sm">
            <p className="text-stone-700">{result.name || '—'} · {t.sv} {result.sv}</p>
            <p className="text-xs text-stone-500">{t.reports(result.reports)}</p>
            <p className="mt-1.5 font-mono text-xl font-bold tracking-[0.3em] text-stone-900">{result.pin}</p>
          </div>
        )}
      </div>
      {err && <p className="mt-3 text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{err}</p>}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, ExternalLink, KeyRound, Loader2, RotateCcw, Search } from 'lucide-react';
import { confirmDialog, toast } from './ui';
import {
  backfillCoacheeFilePins, coacheeFilePin, getCoacheeFileAdmin, listCoacheeFilePins, setCoacheeFileMail,
  type CoacheeFilePerson,
} from '../lib/pocketbase';

/**
 * Admin → E-Mails: the coachee file (/dossier). Every referee with a report
 * and their PIN, to hand out by hand. A PIN is minted when a report is filed;
 * "Fehlende PINs erzeugen" mints them for the reports filed before.
 *
 * The PIN mail's switch: off by default, and it asks before it turns on. It
 * was drawn locked from 2026-10-05 (no mail to coachees until SVRZ / RC
 * approve); Luca unlocked it on 2026-10-13. On, every report sent from then
 * on also mails its referee the link, SV-Nr. and PIN in a message of their
 * own; nobody is mailed for the reports before.
 *
 * Admin → Coachees draws each coachee's PIN under their row from the same
 * map (CoacheePinLine below, Luca 2026-10-12).
 */

type Lang = 'DE' | 'EN';

const STR = {
  DE: {
    title: 'Coaching-Dossier für Coachees',
    badge: 'Keine E-Mails an Coachees',
    badgeOn: 'PIN-Mail an',
    hint: 'Coachees sehen unter /dossier alle Berichte, die sie erhalten haben — mit SV-Nr. und persönlichem 6-stelligem PIN. Jede:r mit SV-Nr. erhält beim ersten Bericht automatisch einen PIN.',
    mailToggle: 'PIN per E-Mail an Coachees senden',
    mailOff: 'Aus — es wird nichts an Coachees versendet, PINs gibst du selbst weiter.',
    mailOnNote: 'An — mit jedem neu versendeten Bericht geht eine eigene E-Mail mit Link, SV-Nr. und PIN an die Person, an niemanden sonst. Für frühere Berichte wird nichts versendet.',
    confirmOnTitle: 'PIN-Mail an Coachees einschalten?',
    confirmOnBody: 'Ab sofort erhält jede:r Schiedsrichter:in mit jedem neuen Bericht eine eigene E-Mail mit dem Link zum Dossier, der SV-Nr. und dem PIN. Für die bisherigen Berichte wird nichts versendet. Im Testmodus geht die E-Mail an die Testadresse.',
    confirmOn: 'Einschalten',
    savedOn: 'PIN-Mail eingeschaltet.',
    savedOff: 'PIN-Mail ausgeschaltet.',
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
    resetBody: (mail: boolean) => `Der bisherige PIN gilt sofort nicht mehr, offene Sitzungen enden. ${mail ? 'Der neue PIN geht mit dem nächsten Bericht an die Person — oder du gibst ihn selbst weiter.' : 'Den neuen PIN musst du selbst weitergeben.'}`,
    other: 'Andere SV-Nr.',
    otherHint: 'Für eine SV-Nr. ohne Bericht: erzeugt einen PIN. Es wird nichts versendet.',
    show: 'PIN anzeigen',
    sv: 'SV-Nr.',
    open: 'Seite öffnen',
    pinLabel: 'PIN',
    copyPin: 'PIN kopieren',
    pinCopied: 'PIN kopiert.',
    noPinYet: 'kein PIN',
    pinTitle: 'PIN für das Coaching-Dossier (/dossier)',
    create: 'PIN erstellen',
    created: 'PIN erstellt. Es wurde nichts versendet.',
  },
  EN: {
    title: 'Coaching file for coachees',
    badge: 'No e-mails to coachees',
    badgeOn: 'PIN mail on',
    hint: 'Coachees see every report they received at /dossier — with their SV no. and a personal 6-digit PIN. Everyone with an SV no. gets a PIN automatically with their first report.',
    mailToggle: 'Send the PIN to coachees by e-mail',
    mailOff: 'Off — nothing is sent to coachees, you pass the PINs on yourself.',
    mailOnNote: 'On — every newly sent report is followed by an e-mail of its own with the link, SV no. and PIN, to the person and nobody else. Nothing is sent for earlier reports.',
    confirmOnTitle: 'Turn on the PIN mail to coachees?',
    confirmOnBody: 'From now on every referee gets, with each new report, an e-mail of its own with the link to the file, their SV no. and PIN. Nothing is sent for the reports so far. In test mode the e-mail goes to the test address.',
    confirmOn: 'Turn on',
    savedOn: 'PIN mail turned on.',
    savedOff: 'PIN mail turned off.',
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
    resetBody: (mail: boolean) => `The old PIN stops working at once and open sessions end. ${mail ? 'The new PIN goes to the person with their next report — or you pass it on yourself.' : 'You have to pass the new PIN on yourself.'}`,
    other: 'Other SV no.',
    otherHint: 'For an SV no. without a report: creates a PIN. Nothing is sent.',
    show: 'Show PIN',
    sv: 'SV no.',
    open: 'Open page',
    pinLabel: 'PIN',
    copyPin: 'Copy PIN',
    pinCopied: 'PIN copied.',
    noPinYet: 'no PIN',
    pinTitle: 'PIN for the coaching file (/dossier)',
    create: 'Create PIN',
    created: 'PIN created. Nothing was sent.',
  },
};

const btnGhost = 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50 transition-colors';

const fmtDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

/** An SV-Nr. the way the server keys the PINs (normalizeSvNumber in
 *  server/coacheeFile.ts): spaces and dots forgiven, leading zeros dropped,
 *  '' for anything that cannot be one. */
export function svKey(raw: string | undefined): string {
  const digits = String(raw ?? '').trim().replace(/[\s.'’-]/g, '');
  return /^\d{3,9}$/.test(digits) ? digits.replace(/^0+(?=\d)/, '') : '';
}

export type DossierPins = { url: string; bySv: Map<string, string> };

/** Admin → Coachees: the dossier PINs by SV-Nr., read whenever the tab opens.
 *  `pins` stays null until read and when the answer is not the roster — the
 *  rows then draw no PIN line rather than a "no PIN" that may be wrong. */
export function useDossierPins(active: boolean) {
  const [pins, setPins] = useState<DossierPins | null>(null);
  const load = useCallback(async () => {
    try {
      const [meta, people] = await Promise.all([getCoacheeFileAdmin(), listCoacheeFilePins()]);
      if (!Array.isArray(people)) return;
      setPins({ url: meta?.url || '', bySv: new Map(people.filter((p) => p.pin).map((p) => [p.sv, p.pin])) });
    } catch { /* no line; Admin → E-Mails shows why */ }
  }, []);
  useEffect(() => { if (active) void load(); }, [active, load]);
  const mint = useCallback(async (sv: string) => {
    const r = await coacheeFilePin(sv, false);
    setPins((cur) => cur && { ...cur, bySv: new Map(cur.bySv).set(r.sv, r.pin) });
  }, []);
  return { pins, mint };
}

/** One coachee's dossier PIN under their row in Admin → Coachees, or a button
 *  that creates it. A PIN normally comes with the first report; creating one
 *  earlier sends nothing either. The icon beside the PIN copies the PIN and
 *  nothing else (Luca, 2026-10-13: it used to copy the whole ready-to-send
 *  text, which is not what a copy icon next to a number promises) — that text
 *  is still one click away in Admin → E-Mails, where its button says so. */
export function CoacheePinLine({ lang, sv, pins, onMint }: {
  lang: Lang; sv: string; pins: DossierPins; onMint: (sv: string) => Promise<void>;
}) {
  const t = STR[lang];
  const [busy, setBusy] = useState(false);
  const key = svKey(sv);
  if (!key) return null;
  const pin = pins.bySv.get(key) || '';
  const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e), { lang });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pin);
      toast.success(t.pinCopied, { lang });
    } catch (e) { fail(e); }
  };
  const create = async () => {
    setBusy(true);
    try { await onMint(key); toast.success(t.created, { lang }); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  // Redacted: a click here must not copy the PIN into the activity log.
  return (
    <p data-log-redact data-testid="coachee-pin" title={t.pinTitle} className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-stone-400">
      <KeyRound size={11} className="shrink-0" />
      {pin ? (
        <>
          <span>{t.pinLabel}</span>
          {/* Inter's own tabular figures, not font-mono: no mono face is
              bundled, and the system fallback sat higher and larger than
              the "PIN" beside it. */}
          <span className="font-semibold tabular-nums tracking-[0.15em] text-stone-700">{pin}</span>
          <button type="button" onClick={() => void copy()} aria-label={t.copyPin} title={t.copyPin}
            className="inline-flex items-center justify-center h-6 w-6 rounded-md text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition-colors">
            <Copy size={12} />
          </button>
        </>
      ) : (
        <>
          <span>{t.noPinYet}</span>
          <button type="button" disabled={busy} onClick={() => void create()}
            className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-stone-200 text-[11px] font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-50 transition-colors">
            {busy && <Loader2 size={11} className="animate-spin" />}{t.create}
          </button>
        </>
      )}
    </p>
  );
}

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
    if (!(await confirmDialog({ title: t.resetTitle(p.name || p.sv), message: t.resetBody(!!meta?.enabled), confirmLabel: t.reset, tone: 'danger', lang }))) return;
    await run(`reset:${p.sv}`, async () => { await coacheeFilePin(p.sv, true); load(); });
  };

  const copy = async (p: { sv: string; pin: string; name: string }) => {
    try {
      await navigator.clipboard.writeText(t.shareText(meta?.url || '', p.sv, p.pin, p.name));
      toast.success(t.copied);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  // Turning the mail on asks first; turning it off does not — off is the safe side.
  const setMail = async (on: boolean) => {
    if (on && !(await confirmDialog({ title: t.confirmOnTitle, message: t.confirmOnBody, confirmLabel: t.confirmOn, lang }))) return;
    await run('mail', async () => {
      const m = await setCoacheeFileMail(on);
      setMeta(m);
      toast.success(m.enabled ? t.savedOn : t.savedOff, { lang });
    });
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
        {meta?.enabled
          ? <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-emerald-100 text-emerald-800">{t.badgeOn}</span>
          : <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase bg-amber-100 text-amber-800">{t.badge}</span>}
      </div>
      <p className="text-xs text-stone-500 mb-3">{t.hint}</p>
      <label data-testid="coachee-file-mail-toggle" className={`mb-3 flex items-start gap-3 ${meta && !busy ? 'cursor-pointer' : 'cursor-wait opacity-60'}`}>
        <input
          type="checkbox" className="mt-0.5 h-4 w-4 accent-red-600" checked={!!meta?.enabled} disabled={!meta || !!busy}
          onChange={(e) => void setMail(e.target.checked)} aria-describedby="coachee-file-mail-state"
        />
        <span>
          <span className="block text-sm font-medium text-stone-700">{t.mailToggle}</span>
          <span id="coachee-file-mail-state" className="block text-xs text-stone-500">{meta?.enabled ? t.mailOnNote : t.mailOff}</span>
        </span>
        {busy === 'mail' && <Loader2 size={14} className="mt-0.5 animate-spin text-stone-400" />}
      </label>

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

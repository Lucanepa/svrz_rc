import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BarChart3, Download, ExternalLink, Eye, EyeOff, FileText, Loader2, LogOut, Lock, X } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getStoredLang, type Lang } from '../lib/prefs';
import { useScreenLang } from '../lib/useScreenLang';
import {
  coacheeFileLogin, getCoacheeFile, getCoacheeFileForm, CoacheeFileError,
  type CoacheeFile, type CoacheeFileEntry,
} from '../lib/pocketbase';
import { importFresh } from '../lib/freshImport';
import StaleBuildNotice from './StaleBuildNotice';
import CoacheeFileStats from './CoacheeFileStats';

// pdf.js is a megabyte: loaded when a report is first opened, not with the page.
const PdfReader = lazy(() => importFresh(() => import('./PdfReader')).catch((error: unknown) => ({
  default: (props: { onClose: () => void }) => <StaleBuildNotice message={error instanceof Error ? error.message : String(error)} onClose={props.onClose} />,
})));

/**
 * "Mein Coaching-Dossier" — a coached referee's own reports, at /dossier.
 *
 * Public, like the survey page: the readers are referees, who have no login to
 * this app. Its own door instead: the SV-Nr. and a personal 6-digit PIN,
 * minted with the referee's first report and handed out by the admin — no
 * mail tells coachees for now (2026-10-05, see server/coacheeFile.ts). The
 * session is short (30 min), sent in a header, and kept in this tab only — a
 * referee may well open this on a shared computer.
 *
 * Two tabs: the reports, each readable right here (the app's own PDF reader,
 * fed from memory — never Cache Storage), in a new browser tab, or saved; and
 * the referee's own statistics (CoacheeFileStats).
 */

const STR = {
  DE: {
    kicker: 'SVRZ · Referee Coaching',
    title: 'Mein Coaching-Dossier',
    lead: 'Alle Coaching-Berichte, die du von uns erhalten hast — auch aus früheren Saisons.',
    sv: 'SV-Nr.',
    pin: 'PIN (6 Ziffern)',
    pinHint: 'Deinen persönlichen PIN erhältst du vom SVRZ Referee Coaching. PIN verloren? schiricoaching@svrz.ch',
    showPin: 'PIN anzeigen',
    hidePin: 'PIN verbergen',
    signIn: 'Anmelden',
    wrong: 'SV-Nr. oder PIN stimmt nicht.',
    tooMany: (min: number) => `Zu viele Versuche. Bitte in ${min} Minute${min === 1 ? '' : 'n'} erneut versuchen.`,
    failed: 'Das hat nicht geklappt. Bitte später erneut versuchen.',
    expired: 'Deine Sitzung ist abgelaufen. Bitte erneut anmelden.',
    signOut: 'Abmelden',
    reports: (n: number) => `${n} Bericht${n === 1 ? '' : 'e'}`,
    none: 'Zu deiner SV-Nr. sind noch keine Berichte abgelegt.',
    open: 'Ansehen',
    openLong: 'Bericht ansehen',
    download: 'Herunterladen',
    downloadLong: 'Bericht herunterladen',
    newTab: 'In neuem Tab öffnen',
    close: 'Schliessen',
    report: 'Bericht',
    imageFailed: 'Dieses Bild kann der Browser nicht anzeigen. Lade es herunter, um es zu öffnen.',
    tabReports: 'Berichte',
    tabStats: 'Statistik',
    noFile: 'Keine Datei gespeichert',
    goals: 'Ziele für nächste Spiele',
    coach: 'Referee Coach',
    match: 'Spiel',
    test: 'Testspiel',
    footer: 'Fragen? schiricoaching@svrz.ch',
  },
  EN: {
    kicker: 'SVRZ · Referee Coaching',
    title: 'My coaching file',
    lead: 'Every coaching report you have received from us — earlier seasons included.',
    sv: 'SV no.',
    pin: 'PIN (6 digits)',
    pinHint: 'Your personal PIN comes from SVRZ Referee Coaching. Lost it? schiricoaching@svrz.ch',
    showPin: 'Show PIN',
    hidePin: 'Hide PIN',
    signIn: 'Sign in',
    wrong: 'SV no. or PIN is not correct.',
    tooMany: (min: number) => `Too many attempts. Please try again in ${min} minute${min === 1 ? '' : 's'}.`,
    failed: 'That did not work. Please try again later.',
    expired: 'Your session has expired. Please sign in again.',
    signOut: 'Sign out',
    reports: (n: number) => `${n} report${n === 1 ? '' : 's'}`,
    none: 'No reports are filed under your SV no. yet.',
    open: 'View',
    openLong: 'View report',
    download: 'Download',
    downloadLong: 'Download report',
    newTab: 'Open in a new tab',
    close: 'Close',
    report: 'Report',
    imageFailed: 'This browser cannot show this image. Download it to open it.',
    tabReports: 'Reports',
    tabStats: 'Statistics',
    noFile: 'No file stored',
    goals: 'Goals for the next games',
    coach: 'Referee coach',
    match: 'Match',
    test: 'Test game',
    footer: 'Questions? schiricoaching@svrz.ch',
  },
};

const SESSION_KEY = 'svrz-coachee-file';

type Stored = { token: string; expiresAt: number };

function readSession(): Stored | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    return s.token && s.expiresAt > Date.now() ? s : null;
  } catch { return null; }
}
function writeSession(s: Stored | null): void {
  try {
    if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* private mode: the session lives in React state only */ }
}

const fmtDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

/** Share sheet on a phone, a download elsewhere — what the coach app does
 *  with a filed PDF (shareFeedbackFile). On a phone the sheet is where
 *  "Save to Files" lives. */
async function deliver(blob: Blob, name: string, title: string): Promise<void> {
  const file = new File([blob], name, { type: blob.type || 'application/pdf' });
  if (navigator.canShare && navigator.share && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ title, files: [file] }); return; }
    catch (e) { if ((e as Error)?.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export default function CoacheeFilePage() {
  const [lang, setLang] = useState<Lang>(() =>
    getStoredLang() ?? (navigator.language?.toLowerCase().startsWith('en') ? 'EN' : 'DE'));
  useScreenLang(lang);
  const t = STR[lang];
  const [session, setSession] = useState<Stored | null>(() => readSession());
  const [file, setFile] = useState<CoacheeFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [sv, setSv] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showPin, setShowPin] = useState(false);
  /** `<entry id>:view` or `<entry id>:download` while that one is fetching. */
  const [opening, setOpening] = useState('');
  const [tab, setTab] = useState<'reports' | 'stats'>('reports');
  /** The report on screen: its bytes stay in memory, never in Cache Storage. */
  const [viewer, setViewer] = useState<{ entry: CoacheeFileEntry; blob: Blob; name: string; url: string } | null>(null);
  // Fetched documents for this session, so viewing and then saving one is a
  // single download. Dropped with the session.
  const forms = useRef(new Map<string, { blob: Blob; name: string }>());
  // Object URLs handed to an image or a new tab. A tab opened from one may
  // still be reading it, so they live until the session ends, not the viewer.
  const objectUrls = useRef(new Set<string>());

  useEffect(() => {
    document.documentElement.lang = lang === 'DE' ? 'de' : 'en';
    document.title = `${t.title} · SVRZ`;
  }, [lang, t.title]);

  const dropDocuments = useCallback(() => {
    forms.current.clear();
    for (const url of objectUrls.current) URL.revokeObjectURL(url);
    objectUrls.current.clear();
  }, []);

  const signOut = useCallback((message = '') => {
    writeSession(null);
    setSession(null);
    setFile(null);
    setPin('');
    setShowPin(false);
    setViewer(null);
    setTab('reports');
    dropDocuments();
    setError(message);
  }, [dropDocuments]);

  useEffect(() => dropDocuments, [dropDocuments]);

  // Load the file whenever a session exists; a 401 (expired, or the PIN was
  // replaced in the console) sends the reader back to the door.
  useEffect(() => {
    if (!session) return;
    let live = true;
    setLoading(true);
    getCoacheeFile(session.token)
      .then((f) => { if (live) setFile(f); })
      .catch((e) => {
        if (!live) return;
        if (e instanceof CoacheeFileError && e.status === 401) signOut(STR[lang].expired);
        else setError(STR[lang].failed);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [session?.token]);

  // The session ends on its own at expiry, so a page left open does not keep
  // showing reports to whoever sits down next.
  useEffect(() => {
    if (!session) return;
    const id = window.setTimeout(() => signOut(STR[lang].expired), Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(id);
  }, [session, signOut, lang]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const s = await coacheeFileLogin(sv, pin);
      writeSession(s);
      setPin('');
      setSession(s);
    } catch (err) {
      if (err instanceof CoacheeFileError && err.status === 429) setError(t.tooMany(Math.max(1, Math.ceil(err.retryAfterMs / 60_000))));
      else if (err instanceof CoacheeFileError && err.status === 401) setError(t.wrong);
      else setError(t.failed);
    } finally {
      setBusy(false);
    }
  };

  const objectUrl = (blob: Blob) => {
    const url = URL.createObjectURL(blob);
    objectUrls.current.add(url);
    return url;
  };

  const fetchForm = async (entry: CoacheeFileEntry) => {
    const kept = forms.current.get(entry.id);
    if (kept) return kept;
    const got = await getCoacheeFileForm(session!.token, entry.id);
    forms.current.set(entry.id, got);
    return got;
  };

  const reportTitle = (entry: CoacheeFileEntry) => `${t.report} ${fmtDate(entry.date)} · ${entry.role}`;

  const act = async (entry: CoacheeFileEntry, action: 'view' | 'download') => {
    if (!session) return;
    setOpening(`${entry.id}:${action}`);
    setError('');
    try {
      const { blob, name } = await fetchForm(entry);
      if (action === 'download') await deliver(blob, name, `${t.title} · ${fmtDate(entry.date)}`);
      else setViewer({ entry, blob, name, url: blob.type.startsWith('image/') ? objectUrl(blob) : '' });
    } catch (e) {
      if (e instanceof CoacheeFileError && e.status === 401) signOut(t.expired);
      else setError(t.failed);
    } finally {
      setOpening('');
    }
  };

  // The bytes are in hand, so this runs inside the click — no popup blocker
  // stops a tab opened synchronously.
  const openInNewTab = () => {
    if (!viewer) return;
    window.open(viewer.url || objectUrl(viewer.blob), '_blank', 'noopener');
  };
  const saveViewed = () => {
    if (viewer) void deliver(viewer.blob, viewer.name, `${t.title} · ${fmtDate(viewer.entry.date)}`);
  };

  const card = 'bg-white rounded-2xl shadow-card border border-stone-200/70';
  const input = 'w-full h-11 px-3 rounded-xl border border-stone-200 bg-white text-base text-stone-800 tracking-wide placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-red-700/20 focus:border-red-700/40';

  return (
    <div className="min-h-screen bg-gradient-to-b from-stone-50 to-stone-100">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
        <header className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400">{t.kicker}</p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-stone-900">{t.title}</h1>
          </div>
          <div className="flex flex-col items-end gap-3 shrink-0">
            <SvrzLogo className="h-9 sm:h-11 w-auto" />
            <div role="group" aria-label="Sprache / Language" className="inline-flex rounded-lg border border-stone-200 bg-white p-0.5">
              {(['DE', 'EN'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLang(l)}
                  aria-pressed={lang === l}
                  className={`h-7 px-2.5 rounded-md text-xs font-semibold transition-colors ${lang === l ? 'bg-stone-900 text-white' : 'text-stone-500 hover:text-stone-800'}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
        </header>

        <p className="text-sm sm:text-base leading-relaxed text-stone-600 mb-6">{t.lead}</p>

        {!session && (
          <form onSubmit={submit} className={`${card} p-5 sm:p-6 space-y-4`} data-testid="coachee-file-login">
            <label className="block">
              <span className="block text-sm font-medium text-stone-700 mb-1.5">{t.sv}</span>
              <input
                className={input} name="sv" inputMode="numeric" autoComplete="username"
                value={sv} onChange={(e) => setSv(e.target.value)} required maxLength={12}
              />
            </label>
            <div>
              <label htmlFor="coachee-file-pin" className="block text-sm font-medium text-stone-700 mb-1.5">{t.pin}</label>
              <div className="relative">
                <input
                  id="coachee-file-pin" aria-describedby="coachee-file-pin-hint"
                  className={`${input} pr-12 font-mono tracking-[0.4em]`} name="pin" type={showPin ? 'text' : 'password'} inputMode="numeric"
                  autoComplete="current-password" pattern="[0-9 ]*" spellCheck={false} autoCapitalize="off"
                  value={pin} onChange={(e) => setPin(e.target.value)} required maxLength={7}
                />
                <button
                  type="button" onClick={() => setShowPin((v) => !v)} aria-pressed={showPin} aria-controls="coachee-file-pin"
                  aria-label={showPin ? t.hidePin : t.showPin} title={showPin ? t.hidePin : t.showPin}
                  className="absolute inset-y-0 right-0 w-11 inline-flex items-center justify-center rounded-r-xl text-stone-400 hover:text-stone-700 focus:outline-none focus-visible:text-stone-800"
                >
                  {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
              <span id="coachee-file-pin-hint" className="mt-1.5 block text-xs text-stone-500">{t.pinHint}</span>
            </div>
            {error && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
            <button
              type="submit" disabled={busy}
              className="w-full h-11 inline-flex items-center justify-center gap-2 rounded-xl bg-red-600 text-white text-sm font-semibold hover:bg-red-700 disabled:bg-stone-300 transition-colors"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Lock size={16} />} {t.signIn}
            </button>
          </form>
        )}

        {session && (
          <div data-testid="coachee-file">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div className="min-w-0" data-log-redact>
                <p className="text-base font-semibold text-stone-900 truncate">{file?.name || ' '}</p>
                <p className="text-xs text-stone-500">
                  {file ? `${t.sv} ${file.refereeId} · ${t.reports(file.entries.length)}` : ' '}
                </p>
              </div>
              <button
                type="button" onClick={() => signOut()}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-stone-200 bg-white text-sm font-medium text-stone-600 hover:bg-stone-100 transition-colors shrink-0"
              >
                <LogOut size={15} /> {t.signOut}
              </button>
            </div>

            {error && <p role="alert" className="mb-4 text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}

            {loading && !file && (
              <div className={`${card} py-12 flex justify-center`}><Loader2 className="h-6 w-6 animate-spin text-stone-300" /></div>
            )}

            {file && file.entries.length === 0 && (
              <div className={`${card} p-6 text-center text-sm text-stone-500`}>{t.none}</div>
            )}

            {file && file.entries.length > 0 && (
              <>
                <div role="tablist" aria-label={t.title} className="mb-4 grid grid-cols-2 sm:inline-grid sm:w-auto w-full rounded-xl border border-stone-200 bg-white p-1">
                  {(['reports', 'stats'] as const).map((k) => (
                    <button
                      key={k} type="button" role="tab" id={`dossier-tab-${k}`} aria-selected={tab === k} aria-controls={`dossier-panel-${k}`}
                      onClick={() => setTab(k)}
                      className={`h-9 px-4 inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors ${tab === k ? 'bg-stone-900 text-white' : 'text-stone-600 hover:text-stone-900'}`}
                    >
                      {k === 'reports' ? <FileText size={15} /> : <BarChart3 size={15} />}
                      {k === 'reports' ? t.tabReports : t.tabStats}
                    </button>
                  ))}
                </div>

                {tab === 'reports' && (
                  <ol className="space-y-3" data-log-redact role="tabpanel" id="dossier-panel-reports" aria-labelledby="dossier-tab-reports">
                    {file.entries.map((entry) => (
                      <li key={entry.id} className={`${card} p-4 sm:p-5`} data-testid="coachee-file-entry">
                        <p className="text-[15px] font-semibold text-stone-900">
                          {fmtDate(entry.date)}
                          <span className="ml-2 text-sm font-medium text-stone-500">{entry.role}</span>
                          {entry.isTest && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">{t.test}</span>}
                        </p>
                        <p className="mt-0.5 text-sm text-stone-700">{entry.homeTeam} – {entry.awayTeam}</p>
                        <p className="mt-0.5 text-xs text-stone-500">
                          {[entry.league, entry.matchNo && `${t.match} ${entry.matchNo}`, entry.rc && `${t.coach}: ${entry.rc}`].filter(Boolean).join(' · ')}
                        </p>
                        {entry.goals && (
                          <div className="mt-3 rounded-xl bg-stone-50 border-l-[3px] border-red-600 px-3 py-2.5">
                            <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-500">{t.goals}</p>
                            <p className="mt-1 text-sm text-stone-700 whitespace-pre-line">{entry.goals}</p>
                          </div>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {entry.hasFile ? (
                            <>
                              <button
                                type="button" onClick={() => void act(entry, 'view')} disabled={!!opening} aria-label={t.openLong}
                                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-stone-900 text-white text-sm font-medium hover:bg-stone-700 disabled:bg-stone-300 transition-colors"
                              >
                                {opening === `${entry.id}:view` ? <Loader2 size={15} className="animate-spin" /> : <Eye size={15} />}
                                {t.open}
                              </button>
                              <button
                                type="button" onClick={() => void act(entry, 'download')} disabled={!!opening} aria-label={t.downloadLong}
                                className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg border border-stone-200 bg-white text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:text-stone-300 transition-colors"
                              >
                                {opening === `${entry.id}:download` ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                                {t.download}
                              </button>
                            </>
                          ) : (
                            <span className="text-xs text-stone-400">{t.noFile}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}

                {tab === 'stats' && (
                  <div role="tabpanel" id="dossier-panel-stats" aria-labelledby="dossier-tab-stats">
                    <CoacheeFileStats entries={file.entries} lang={lang} />
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <p className="mt-8 text-center text-[11px] text-stone-400">{t.footer}</p>
      </div>

      {viewer && (() => {
        const title = reportTitle(viewer.entry);
        const close = () => setViewer(null);
        const actions = (
          <>
            <button type="button" onClick={saveViewed} aria-label={t.downloadLong} title={t.download} className="inline-flex items-center gap-1.5 h-8 px-1.5 sm:px-2 rounded text-xs font-medium hover:bg-stone-700">
              <Download size={15} /> <span className="hidden sm:inline">{t.download}</span>
            </button>
            <button type="button" onClick={openInNewTab} aria-label={t.newTab} title={t.newTab} className="p-1.5 rounded hover:bg-stone-700">
              <ExternalLink size={15} />
            </button>
          </>
        );
        const fallback = (
          <button type="button" onClick={saveViewed} className="inline-flex items-center gap-2 mt-3 text-sm text-red-400 hover:text-red-300 underline">
            <Download size={14} /> {t.downloadLong}
          </button>
        );
        if (viewer.blob.type.startsWith('image/')) {
          return <ImageViewer url={viewer.url} title={title} onClose={close} actions={actions} closeLabel={t.close} failedText={t.imageFailed} fallback={fallback} />;
        }
        return (
          <Suspense fallback={(
            <div className="fixed inset-0 z-[60] grid place-items-center bg-stone-900/90 text-stone-100">
              <Loader2 size={22} className="animate-spin" />
            </div>
          )}>
            <PdfReader
              url={`dossier:${viewer.entry.id}`} title={title} lang={lang} onClose={close}
              load={() => viewer.blob.arrayBuffer()} actions={actions} fallback={fallback}
            />
          </Suspense>
        );
      })()}
    </div>
  );
}

/** A scanned report (a photo of the paper form): the picture, fitted to the
 *  width, with the same buttons as the PDF reader. HEIC opens only in Safari;
 *  elsewhere the way out is the download. */
function ImageViewer({ url, title, onClose, actions, closeLabel, failedText, fallback }: {
  url: string; title: string; onClose: () => void; actions: ReactNode; closeLabel: string; failedText: string; fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-stone-900/95" role="dialog" aria-modal="true" aria-label={title}>
      <header className="flex-none flex items-center gap-2 px-2 sm:px-3 h-12 bg-stone-900 text-stone-100 border-b border-stone-700">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {actions}
        <button type="button" onClick={onClose} aria-label={closeLabel} className="p-1.5 rounded hover:bg-stone-700"><X size={17} /></button>
      </header>
      <div className="flex-1 overflow-auto overscroll-contain bg-stone-800 p-1.5 sm:p-6">
        {failed ? (
          <div className="h-full grid place-items-center text-center px-6">
            <div>
              <p className="text-sm text-stone-300">{failedText}</p>
              {fallback}
            </div>
          </div>
        ) : (
          <img src={url} alt={title} onError={() => setFailed(true)} className="mx-auto block max-w-full h-auto bg-white shadow-lg" />
        )}
      </div>
    </div>
  );
}

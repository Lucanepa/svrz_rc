import React, { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { Lock, Loader2, ArrowLeft, Eye, EyeOff, User, Languages, Search, Check, ChevronDown } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import {
  getAuthMe, rcLogout, logoutAdmin, hasPendingLogout, settlePendingLogout,
  sharedLogin, listRcRoster, identifyAsRc, type AuthMe, type RcRosterEntry,
} from '../lib/pocketbase';
import { clientLog, setLogUser, flush } from '../lib/logger';
import AppSpinner from './AppSpinner';
import { getStoredLang, setStoredLang, getStoredRcId, setStoredRcId, type Lang } from '../lib/prefs';

type ApiError = Error & { status?: number; retryAfterMs?: number };

// Every string on the gate, in both languages. The gate is where the language
// gets chosen, so it cannot lean on the app's own translations — those live
// inside the tree it has not mounted yet.
const STR = {
  DE: {
    brand: 'Referee Coaching',
    username: 'Benutzername',
    password: 'Passwort',
    login: 'Anmelden',
    checking: 'Prüfe…',
    loading: 'Wird geladen…',
    showPassword: 'Passwort anzeigen',
    hidePassword: 'Passwort verbergen',
    adminLogin: 'Admin-Login',
    backToLogin: 'Zurück zur Anmeldung',
    wrongShared: 'Falscher Benutzername oder falsches Passwort',
    langToggle: 'Sprache wechseln',
    whoTitle: 'Wer bist du?',
    whoHint: 'Wähle deinen Namen. Spiele, Beobachtungen und Einträge werden darunter gespeichert.',
    search: 'Suchen…',
    continue: 'Weiter',
    noMatch: 'Kein Treffer',
    choose: 'Namen wählen',
    rosterFailed: 'Die Liste konnte nicht geladen werden.',
    retry: 'Erneut versuchen',
    genericError: 'Etwas ist schiefgelaufen. Bitte versuche es erneut.',
    rateLimitSecs: (s: number) => `Zu viele Versuche. Bitte in ${s}s erneut probieren.`,
    rateLimitMins: (m: number) => `Zu viele Versuche. Bitte in ca. ${m} Minuten erneut probieren.`,
    unavailable: 'Server vorübergehend nicht erreichbar. Bitte in einer Minute erneut probieren.',
    serverError: 'Serverfehler. Bitte versuche es später erneut.',
    offlineNetwork: 'Verbindungsfehler. Bitte versuche es später erneut.',
    offline: 'Keine Internetverbindung. Bitte prüfe dein Netz und versuche es erneut.',
    cookieBlocked: 'Anmeldung unvollständig: Der Browser hat die Sitzung nicht gespeichert. '
      + 'Bitte im Datenschutz die Option „Cross-Site-Tracking verhindern" für diese Seite deaktivieren '
      + 'oder einen anderen Browser verwenden.',
  },
  EN: {
    brand: 'Referee Coaching',
    username: 'Username',
    password: 'Password',
    login: 'Sign in',
    checking: 'Checking…',
    loading: 'Loading…',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    adminLogin: 'Admin login',
    backToLogin: 'Back to sign-in',
    wrongShared: 'Wrong username or password',
    langToggle: 'Switch language',
    whoTitle: 'Who are you?',
    whoHint: 'Pick your name. Games, observations and entries are filed under it.',
    search: 'Search…',
    continue: 'Continue',
    noMatch: 'No match',
    choose: 'Choose your name',
    rosterFailed: 'The list could not be loaded.',
    retry: 'Try again',
    genericError: 'Something went wrong. Please try again.',
    rateLimitSecs: (s: number) => `Too many attempts. Please try again in ${s}s.`,
    rateLimitMins: (m: number) => `Too many attempts. Please try again in about ${m} minutes.`,
    unavailable: 'Server temporarily unreachable. Please try again in a minute.',
    serverError: 'Server error. Please try again later.',
    offlineNetwork: 'Connection error. Please try again later.',
    offline: 'No internet connection. Please check your network and try again.',
    cookieBlocked: 'Sign-in incomplete: the browser did not store the session. '
      + 'Please turn off "Prevent cross-site tracking" for this site in your privacy settings, '
      + 'or use a different browser.',
  },
} satisfies Record<Lang, Record<string, unknown>>;

type Strings = typeof STR['DE'];

// One place that turns a failure into words. The distinction that matters:
// "connection error" is reserved for a request that never got a response
// (offline / DNS / CORS). Anything with a status says what the status means —
// a rate limit used to fall through to "connection error", which sent people
// looking for network problems they didn't have.
function errorMessage(err: unknown, t: Strings, fallback = ''): string {
  const e = err as ApiError;
  if (e?.status === 429) {
    const secs = Math.ceil((e.retryAfterMs || 60_000) / 1000);
    return secs > 90 ? t.rateLimitMins(Math.ceil(secs / 60)) : t.rateLimitSecs(secs);
  }
  if (e?.status === 503) return t.unavailable;
  if (e?.status && e.status >= 500) return t.serverError;
  // No status at all == fetch itself rejected == genuinely a connection problem.
  if (e?.status === undefined) return navigator.onLine ? t.offlineNetwork : t.offline;
  return fallback || t.genericError;
}

// Identity of the session that passed the gate. rcName/rcId are null when the
// only cookie present is a console one — someone who signed in at #/admin and
// then navigated to the app without a team session of their own.
export type RcAuth = {
  rcId: string | null;
  rcName: string | null;
  isAdminSession: boolean;
  /** Signed in to the app — the name was chosen off a list, not proven. */
  sharedSession: boolean;
  /** Reopens the picker without signing out. */
  switchRc: () => void;
  logout: () => void;
};

const RcAuthContext = createContext<RcAuth>({
  rcId: null, rcName: null, isAdminSession: false, sharedSession: false,
  switchRc: () => {}, logout: () => {},
});

export function useRcAuth(): RcAuth {
  return useContext(RcAuthContext);
}

const inputClass = (error: string) =>
  `w-full pl-10 pr-4 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`;

const primaryButtonClass =
  'w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20';

// 'shared' is the login screen; 'identify' is the picker — reached after
// signing in, and again from the app whenever someone hands the device on.
// There used to be a third: a per-person e-mail and password, which is what
// admin rights and the chair's survey access hung off. Both now have their own
// password on the admin page, so the app has one way in and one screen for it.
type View = 'shared' | 'identify';

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>('shared');
  const [lang, setLang] = useState<Lang>(() => getStoredLang() ?? (navigator.language?.toLowerCase().startsWith('en') ? 'EN' : 'DE'));
  const t = STR[lang];

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rcId, setRcId] = useState<string | null>(null);
  const [rcName, setRcName] = useState<string | null>(null);
  const [isAdminSession, setIsAdminSession] = useState(false);
  const [sharedSession, setSharedSession] = useState(false);

  // Picker state.
  const [roster, setRoster] = useState<RcRosterEntry[] | null>(null);
  const [rosterError, setRosterError] = useState('');
  const [chosenRcId, setChosenRcId] = useState<string | null>(null);
  const [rcSearch, setRcSearch] = useState('');
  // The roster is a dozen-odd names and it used to fill the card, pushing
  // Continue off a phone screen. Collapsed to the chosen name; it opens on
  // demand, and on its own whenever there is nothing to show in it yet.
  const [pickerOpen, setPickerOpen] = useState(false);

  const chooseLang = (next: Lang) => { setLang(next); setStoredLang(next); };

  const loadRoster = useCallback(async (forceOpen = false) => {
    setRosterError('');
    try {
      const people = await listRcRoster();
      setRoster(people);
      // Pre-select whoever used this device last, but still ask: the whole
      // point of a shared credential is that the next holder may be someone
      // else, and a silent carry-over files their work under the wrong name.
      const remembered = getStoredRcId();
      const preselected = people.some((p) => p.id === remembered) ? remembered : null;
      setChosenRcId((current) => current ?? preselected);
      // Nothing to collapse around, or a hand-over in progress: start open, so
      // nobody has to work out that the button is the way in.
      setPickerOpen(forceOpen || !preselected);
    } catch (err) {
      clientLog.warn('auth.roster', 'could not load the RC list', { error: err });
      setRoster(null);
      setRosterError(errorMessage(err, STR[lang], STR[lang].rosterFailed));
    }
  }, [lang]);

  // Adopt whatever the server says the session is. One place, so the probe, the
  // two logins and the picker cannot drift into disagreeing about it.
  const adoptSession = useCallback((me: AuthMe) => {
    setLogUser(me.rc?.name || me.admin?.email);
    setRcId(me.rc?.id ?? null);
    setRcName(me.rc?.name ?? null);
    setIsAdminSession(Boolean(me.admin));
    setSharedSession(Boolean(me.shared));
    setAuthed(Boolean(me.rc || me.admin));
  }, []);

  useEffect(() => {
    // A logout that could not reach the server left the cookie alive. Honour it
    // locally and keep retrying the revocation, rather than letting the next
    // person on a shared device land in the previous coach's account.
    if (hasPendingLogout()) {
      clientLog.warn('auth.probe', 'a previous logout never reached the server — staying logged out');
      void settlePendingLogout();
      setChecking(false);
      return;
    }
    // Guard the status probe with a timeout so an unreachable API degrades to
    // the login screen instead of an infinite blank page.
    const timeout = setTimeout(() => {
      clientLog.warn('auth.probe', 'auth/me did not answer within 6s — falling back to the login screen');
      setChecking(false);
    }, 6000);
    getAuthMe()
      .then((me) => {
        clientLog.info('auth.probe', me.rc || me.admin ? 'existing session' : me.needsIdentity ? 'session without an RC' : 'no session', {
          rc: me.rc?.name, admin: Boolean(me.admin), shared: Boolean(me.shared),
        });
        adoptSession(me);
        // Signed in on the team credential but nobody yet — or the RC they had
        // chosen has since been deactivated. Either way the password is good;
        // asking for it again would be a lie about what is missing.
        if (me.needsIdentity) { setView('identify'); void loadRoster(); }
      })
      .catch((error) => { clientLog.warn('auth.probe', 'auth/me failed — showing the login screen', { error }); })
      .finally(() => {
        clearTimeout(timeout);
        setChecking(false);
      });
    return () => clearTimeout(timeout);
  }, [adoptSession, loadRoster]);

  const handleSharedSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    clientLog.info('auth.shared-login', 'team login submitted', { username: username.trim() });
    try {
      await sharedLogin(username.trim(), password);
      clientLog.info('auth.shared-login', 'team login ok — asking which RC');
      setPassword('');
      setView('identify');
      void loadRoster();
    } catch (err) {
      const e2 = err as ApiError;
      const message = (e2.status === 401 || e2.status === 400) ? t.wrongShared : errorMessage(err, t);
      clientLog.warn('auth.shared-login', `team login failed: ${message}`, { status: e2.status, retryAfterMs: e2.retryAfterMs, error: err });
      setError(message);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const handleIdentify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chosenRcId) return;
    setError('');
    setSubmitting(true);
    try {
      const rc = await identifyAsRc(chosenRcId);
      clientLog.info('auth.identify', 'identified', { rcId: rc.id, name: rc.name });
      setStoredRcId(rc.id);
      // Ask the server who it now thinks we are rather than assuming: the
      // answer also carries the flags this session does NOT get, and the app
      // must mount with exactly the rights the API will honour.
      const me = await getAuthMe().catch(() => null);
      if (!me?.rc?.id) throw new Error(t.cookieBlocked);
      adoptSession(me);
    } catch (err) {
      const message = errorMessage(err, t, (err as ApiError).message);
      clientLog.warn('auth.identify', `identify failed: ${message}`, { rcId: chosenRcId, error: err });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  // Hand the device on without signing out: back to the picker, session intact.
  const switchRc = useCallback(() => {
    clientLog.info('auth.identify', 'switching RC');
    setError('');
    setAuthed(false);
    setChosenRcId(null);
    setRcSearch('');
    setView('identify');
    void loadRoster(true);
  }, [loadRoster]);

  const logout = () => {
    clientLog.info('auth.logout', 'logout');
    void flush();
    // An admin session lives in a SECOND cookie, and /auth/rc/logout never
    // touches it. Revoking only the RC one dropped the screen back to the login
    // form while the admin session stayed alive — and the gate opens for
    // `rc || admin`, so the next reload walked straight back in. Harmless when
    // the admin rights came off the RC record instead of the console login:
    // the endpoint only clears a cookie that then wasn't there.
    void (async () => {
      await rcLogout();
      if (isAdminSession) await logoutAdmin().catch(() => { /* the RC session is already gone */ });
    })().finally(() => {
      setLogUser(null);
      setAuthed(false);
      setRcId(null);
      setRcName(null);
      setSharedSession(false);
      setIsAdminSession(false);
      setPassword('');
      setChosenRcId(null);
      setRoster(null);
      setView('shared');
    });
  };

  if (checking) {
    // The very first thing anyone sees, and it can sit here for up to six
    // seconds against a slow network — worth the branded spinner rather than a
    // bare grey ring that reads as "nothing is happening".
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
        <AppSpinner label={t.loading} />
      </div>
    );
  }
  if (authed) {
    return (
      <RcAuthContext.Provider value={{ rcId, rcName, isAdminSession, sharedSession, switchRc, logout }}>
        {children}
      </RcAuthContext.Provider>
    );
  }

  const query = rcSearch.trim().toLowerCase();
  const visibleRoster = (roster ?? []).filter((p) => !query || p.fullName.toLowerCase().includes(query));
  const chosenName = (roster ?? []).find((p) => p.id === chosenRcId)?.fullName ?? null;
  const passwordField = (id: string, autoComplete: string, placeholder: string, value: string, onChange: (v: string) => void) => (
    <div className="relative">
      <label htmlFor={id} className="sr-only">{placeholder}</label>
      <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
      <input
        id={id}
        type={showPassword ? 'text' : 'password'}
        autoComplete={autoComplete}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={submitting}
        className={`${inputClass(error)} !pr-10`}
      />
      <button
        type="button"
        onClick={() => setShowPassword(v => !v)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
        tabIndex={-1}
        aria-label={showPassword ? t.hidePassword : t.showPassword}
      >
        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />

          <button
            type="button"
            onClick={() => chooseLang(lang === 'DE' ? 'EN' : 'DE')}
            title={t.langToggle}
            className="absolute right-4 top-4 inline-flex items-center gap-1 text-[11px] font-semibold text-stone-400 hover:text-stone-600 transition-colors"
          >
            <Languages size={13} />{lang}
          </button>

          <div className="flex flex-col items-center text-center mb-7">
            <SvrzLogo className="h-11 w-auto" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">
              {t.brand}
            </p>
          </div>

          {view === 'shared' && (
            <>
              <form onSubmit={handleSharedSubmit} className="space-y-3">
                <div className="relative">
                  <label htmlFor="rc-username" className="sr-only">{t.username}</label>
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                  <input
                    id="rc-username"
                    type="text"
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder={t.username}
                    autoFocus
                    disabled={submitting}
                    className={inputClass(error)}
                  />
                </div>
                <div>
                  {passwordField('rc-password', 'current-password', t.password, password, setPassword)}
                  {error && <p className="text-red-600 text-xs mt-2 font-medium">{error}</p>}
                </div>
                <button
                  type="submit"
                  disabled={!username.trim() || password.length < 1 || submitting}
                  className={primaryButtonClass}
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? t.checking : t.login}
                </button>
              </form>
              {/* #/admin is a different door with its own password, not a
                  second form behind this one — the console no longer sits
                  behind this gate at all (see main.tsx). */}
              <p className="text-center text-[11px] text-stone-400 mt-5">
                <a href="#/admin" className="underline hover:text-stone-600">{t.adminLogin}</a>
              </p>
            </>
          )}

          {view === 'identify' && (
            <form onSubmit={handleIdentify} className="space-y-3">
              <div className="text-center">
                <h1 className="text-base font-semibold text-stone-800">{t.whoTitle}</h1>
                <p className="text-xs text-stone-500 mt-1">{t.whoHint}</p>
              </div>

              {roster === null && !rosterError && (
                <div className="flex justify-center py-6"><AppSpinner size={104} /></div>
              )}

              {rosterError && (
                <div className="text-center py-4 space-y-3">
                  <p className="text-red-600 text-xs font-medium">{rosterError}</p>
                  <button type="button" onClick={() => void loadRoster()} className="text-xs underline text-stone-500 hover:text-stone-700">
                    {t.retry}
                  </button>
                </div>
              )}

              {roster !== null && (
                <div onKeyDown={(e) => { if (e.key === 'Escape' && pickerOpen) { e.stopPropagation(); setPickerOpen(false); } }}>
                  {/* The whole roster laid out at once filled the card and
                      pushed Continue off a phone screen. Collapsed to the one
                      name that matters; the list is one tap away. */}
                  <button
                    type="button"
                    onClick={() => setPickerOpen((open) => !open)}
                    aria-expanded={pickerOpen}
                    aria-controls="rc-picker"
                    className={`w-full flex items-center gap-2 px-3.5 py-3 rounded-xl border text-sm transition-colors ${
                      chosenName
                        ? 'border-red-500 bg-red-50 text-stone-900 font-semibold'
                        : 'border-stone-300 bg-stone-50 text-stone-500 hover:bg-stone-100'
                    }`}
                  >
                    <User className="h-4 w-4 shrink-0 text-stone-400" />
                    <span className="flex-1 truncate text-left">{chosenName ?? t.choose}</span>
                    <ChevronDown className={`h-4 w-4 shrink-0 text-stone-400 transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {pickerOpen && (
                    <div id="rc-picker" className="mt-2 space-y-1.5">
                      {/* A search box only earns its space once scanning the list
                          stops being instant. */}
                      {roster.length > 8 && (
                        <div className="relative">
                          <label htmlFor="rc-search" className="sr-only">{t.search}</label>
                          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                          <input
                            id="rc-search"
                            type="text"
                            value={rcSearch}
                            onChange={e => setRcSearch(e.target.value)}
                            placeholder={t.search}
                            autoFocus
                            className={`${inputClass('')} !py-2.5`}
                          />
                        </div>
                      )}
                      <div className="max-h-56 overflow-y-auto -mx-1 px-1 space-y-1.5">
                        {visibleRoster.map((p) => (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => { setChosenRcId(p.id); setRcSearch(''); setPickerOpen(false); }}
                            aria-pressed={chosenRcId === p.id}
                            className={`w-full flex items-center gap-2 text-left px-3.5 py-2.5 rounded-xl border text-sm transition-colors ${
                              chosenRcId === p.id
                                ? 'border-red-500 bg-red-50 text-stone-900 font-semibold'
                                : 'border-stone-200 bg-stone-50 text-stone-700 hover:bg-stone-100'
                            }`}
                          >
                            <span className="flex-1 truncate">{p.fullName}</span>
                            {chosenRcId === p.id && <Check className="h-4 w-4 text-red-600 shrink-0" />}
                          </button>
                        ))}
                        {visibleRoster.length === 0 && (
                          <p className="text-center text-xs text-stone-400 py-6">{t.noMatch}</p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button type="submit" disabled={!chosenRcId || submitting} className={primaryButtonClass}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? t.checking : t.continue}
              </button>
              <button
                type="button"
                onClick={logout}
                className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1"
              >
                <ArrowLeft className="h-3 w-3" /> {t.backToLogin}
              </button>
            </form>
          )}

        </div>
        <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">
          Swiss Volley Region Zürich
        </p>
      </div>
    </div>
  );
}

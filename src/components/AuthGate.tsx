import React, { useState, useEffect, useCallback, createContext, useContext, type ReactNode } from 'react';
import { Lock, Loader2, Mail, ArrowLeft, KeyRound, Eye, EyeOff, User, Languages, Search, Check } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import {
  getAuthMe, rcLogin, rcLogout, rcForgotStart, rcForgotVerify, hasPendingLogout, settlePendingLogout,
  sharedLogin, listRcRoster, identifyAsRc, type AuthMe, type RcRosterEntry,
} from '../lib/pocketbase';
import { clientLog, setLogUser, flush } from '../lib/logger';
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
    email: 'E-Mail',
    login: 'Anmelden',
    checking: 'Prüfe…',
    sending: 'Sende…',
    showPassword: 'Passwort anzeigen',
    hidePassword: 'Passwort verbergen',
    // Parked, not dead: the link that used it was pulled from the team login
    // screen on purpose (see the comment there), and this is what puts it back.
    toPersonal: 'Persönlicher Zugang',
    toShared: 'Zurück zur Team-Anmeldung',
    personalHint: 'Für Admin und RC-Vorsitz — mit persönlicher E-Mail und Passwort.',
    adminLogin: 'Admin-Login',
    forgot: 'Passwort vergessen / einrichten',
    forgotIntro: 'Gib deine hinterlegte E-Mail ein — wir senden dir einen Bestätigungscode.',
    sendCode: 'Code senden',
    codeSent: 'Falls die E-Mail hinterlegt ist, wurde ein Bestätigungscode gesendet.',
    codePlaceholder: '6-stelliger Code',
    newPassword: 'Neues Passwort (min. 6 Zeichen)',
    setPassword: 'Passwort setzen',
    passwordSet: 'Passwort gesetzt. Du kannst dich jetzt anmelden.',
    requestNewCode: 'Neuen Code anfordern',
    backToLogin: 'Zurück zur Anmeldung',
    toLogin: 'Zur Anmeldung',
    wrongShared: 'Falscher Benutzername oder falsches Passwort',
    wrongPersonal: 'Falsche E-Mail oder falsches Passwort',
    codeInvalid: 'Code ungültig oder abgelaufen. Fordere bitte einen neuen Code an.',
    passwordTooShort: 'Passwort muss mindestens 6 Zeichen haben.',
    langToggle: 'Sprache wechseln',
    whoTitle: 'Wer bist du?',
    whoHint: 'Wähle deinen Namen. Spiele, Beobachtungen und Einträge werden darunter gespeichert.',
    search: 'Suchen…',
    continue: 'Weiter',
    noMatch: 'Kein Treffer',
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
    email: 'Email',
    login: 'Sign in',
    checking: 'Checking…',
    sending: 'Sending…',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    toPersonal: 'Personal access',
    toShared: 'Back to team sign-in',
    personalHint: 'For admins and the RC chair — with a personal email and password.',
    adminLogin: 'Admin login',
    forgot: 'Forgot / set password',
    forgotIntro: 'Enter your registered email — we will send you a confirmation code.',
    sendCode: 'Send code',
    codeSent: 'If the address is registered, a confirmation code has been sent.',
    codePlaceholder: '6-digit code',
    newPassword: 'New password (min. 6 characters)',
    setPassword: 'Set password',
    passwordSet: 'Password set. You can sign in now.',
    requestNewCode: 'Request a new code',
    backToLogin: 'Back to sign-in',
    toLogin: 'Go to sign-in',
    wrongShared: 'Wrong username or password',
    wrongPersonal: 'Wrong email or password',
    codeInvalid: 'Code invalid or expired. Please request a new one.',
    passwordTooShort: 'Password must be at least 6 characters.',
    langToggle: 'Switch language',
    whoTitle: 'Who are you?',
    whoHint: 'Pick your name. Games, observations and entries are filed under it.',
    search: 'Search…',
    continue: 'Continue',
    noMatch: 'No match',
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

// Identity of the session that passed the gate. rcName/rcId are null for
// admin-only sessions (admin console login without a personal RC record).
export type RcAuth = {
  rcId: string | null;
  rcName: string | null;
  isAdminSession: boolean;
  /** Signed in on the team credential — the name was chosen, not proven. */
  sharedSession: boolean;
  /** Reopens the picker without signing out. Only meaningful when shared. */
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

// 'shared' is the everyday screen; 'personal' is the e-mail/password one behind
// it. 'identify' is the picker — reached after a shared login, and again from
// the app whenever someone hands the device on.
type View = 'shared' | 'personal' | 'forgot-email' | 'forgot-code' | 'forgot-done' | 'identify';

// Which of the two login forms a signed-out visitor should meet. #/admin is
// reached by people who came for the admin console, and the team credential
// cannot open it — so that route opens on the personal form. Everywhere else
// starts on the everyday one; the two stay one click apart either way.
function defaultView(): View {
  return /^#\/?admin(\/|$)/i.test(window.location.hash) ? 'personal' : 'shared';
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>(defaultView);
  const [lang, setLang] = useState<Lang>(() => getStoredLang() ?? (navigator.language?.toLowerCase().startsWith('en') ? 'EN' : 'DE'));
  const t = STR[lang];

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
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

  // Forgot/set password: 'personal' → 'forgot-email' → 'forgot-code' → 'forgot-done'.
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotInfo, setForgotInfo] = useState('');

  const chooseLang = (next: Lang) => { setLang(next); setStoredLang(next); };

  const loadRoster = useCallback(async () => {
    setRosterError('');
    try {
      const people = await listRcRoster();
      setRoster(people);
      // Pre-select whoever used this device last, but still ask: the whole
      // point of a shared credential is that the next holder may be someone
      // else, and a silent carry-over files their work under the wrong name.
      const remembered = getStoredRcId();
      setChosenRcId((current) => current ?? (people.some((p) => p.id === remembered) ? remembered : null));
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

  const handlePersonalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    clientLog.info('auth.login', 'login submitted', { email: email.trim() });
    try {
      const result = await rcLogin(email.trim(), password);
      // Resolve the full identity BEFORE letting the app mount: it bootstraps
      // its data from rcId/rcName/admin, so handing it a half-known session
      // would make it load once as an anonymous user and again as itself.
      // One retry, because without an rcId anything queued offline this session
      // is filed under 'anon' and no later flush ever finds it again.
      const me = await getAuthMe().catch(async () => {
        clientLog.warn('auth.login', 'auth/me failed right after login — retrying once');
        return getAuthMe().catch(() => null);
      });
      // The password was accepted but the session did not come back. Almost
      // always the browser refused the cross-site session cookie (Safari and
      // WebKit block third-party cookies by default, and the app and the API
      // are different sites) — worth naming, because "try again" never fixes
      // that one. See infrastructure.md → Session cookies.
      if (!me?.rc?.id && !me?.admin) throw new Error(t.cookieBlocked);
      clientLog.info('auth.login', 'login ok', { name: me?.rc?.name ?? result.name, admin: Boolean(me?.admin) });
      adoptSession(me);
      return;
    } catch (err) {
      const e2 = err as ApiError;
      const message = (e2.status === 401 || e2.status === 400) ? t.wrongPersonal : errorMessage(err, t, e2.message);
      clientLog.warn('auth.login', `login failed: ${message}`, { email: email.trim(), status: e2.status, retryAfterMs: e2.retryAfterMs, error: err });
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
    void loadRoster();
  }, [loadRoster]);

  const logout = () => {
    clientLog.info('auth.logout', 'logout');
    void flush();
    void rcLogout().finally(() => {
      setLogUser(null);
      setAuthed(false);
      setRcId(null);
      setRcName(null);
      setSharedSession(false);
      setIsAdminSession(false);
      setPassword('');
      setChosenRcId(null);
      setRoster(null);
      setView(defaultView());
    });
  };

  const handleForgotStart = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    clientLog.info('auth.reset.start', 'requested a reset code', { email: forgotEmail.trim() });
    try {
      await rcForgotStart(forgotEmail.trim());
      // Advance without confirming anything — the server never reveals whether
      // the address is registered.
      setView('forgot-code');
      setForgotInfo(t.codeSent);
    } catch (err) {
      const message = errorMessage(err, t);
      clientLog.warn('auth.reset.start', `reset request failed: ${message}`, { email: forgotEmail.trim(), status: (err as ApiError).status, error: err });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    clientLog.info('auth.reset.verify', 'submitting code + new password', { email: forgotEmail.trim() });
    try {
      await rcForgotVerify(forgotEmail.trim(), forgotCode.trim(), forgotNewPassword);
      clientLog.info('auth.reset.verify', 'password set');
      setForgotInfo(t.passwordSet);
      setView('forgot-done');
    } catch (err) {
      const e2 = err as ApiError;
      const message = e2.status === 401 ? t.codeInvalid
        : e2.status === 400 ? t.passwordTooShort
        : errorMessage(err, t);
      clientLog.warn('auth.reset.verify', `verify failed: ${message}`, { email: forgotEmail.trim(), status: e2.status, retryAfterMs: e2.retryAfterMs, error: err });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const backToPersonalLogin = () => {
    setView('personal');
    setError('');
    setForgotCode('');
    setForgotNewPassword('');
    setForgotInfo('');
  };

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-stone-50 to-stone-100">
        <Loader2 className="h-6 w-6 animate-spin text-stone-300" />
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
              {/* The personal form is deliberately NOT linked from here: this
                  screen is for the team credential and nothing else. It is not
                  gone — #/admin still opens on it, which is where the two
                  people who need it are going anyway (admin console, and the
                  survey tabs the chair reads). Restore the link by putting
                  t.toPersonal back next to the admin one. */}
              <p className="text-center text-[11px] text-stone-400 mt-5">
                <a href="#/admin" className="underline hover:text-stone-600">{t.adminLogin}</a>
              </p>
            </>
          )}

          {view === 'personal' && (
            <>
              <p className="text-xs text-stone-500 text-center mb-4">{t.personalHint}</p>
              <form onSubmit={handlePersonalSubmit} className="space-y-3">
                <div className="relative">
                  <label htmlFor="rc-email" className="sr-only">{t.email}</label>
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                  <input
                    id="rc-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder={t.email}
                    autoFocus
                    disabled={submitting}
                    className={inputClass(error)}
                  />
                </div>
                <div>
                  {passwordField('rc-personal-password', 'current-password', t.password, password, setPassword)}
                  {error && <p className="text-red-600 text-xs mt-2 font-medium">{error}</p>}
                </div>
                <button
                  type="submit"
                  disabled={!/\S+@\S+\.\S+/.test(email) || password.length < 1 || submitting}
                  className={primaryButtonClass}
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? t.checking : t.login}
                </button>
              </form>
              <p className="text-center text-[11px] text-stone-400 mt-5">
                <button type="button" onClick={() => { setError(''); setForgotEmail(email); setView('forgot-email'); }} className="underline hover:text-stone-600">
                  {t.forgot}
                </button>
              </p>
              <button
                type="button"
                onClick={() => { setError(''); setPassword(''); setView('shared'); }}
                className="w-full mt-3 text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1"
              >
                <ArrowLeft className="h-3 w-3" /> {t.toShared}
              </button>
            </>
          )}

          {view === 'identify' && (
            <form onSubmit={handleIdentify} className="space-y-3">
              <div className="text-center">
                <h1 className="text-base font-semibold text-stone-800">{t.whoTitle}</h1>
                <p className="text-xs text-stone-500 mt-1">{t.whoHint}</p>
              </div>

              {roster === null && !rosterError && (
                <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-stone-300" /></div>
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
                <>
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
                  <div className="max-h-64 overflow-y-auto -mx-1 px-1 space-y-1.5">
                    {visibleRoster.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setChosenRcId(p.id)}
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
                </>
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

          {view === 'forgot-email' && (
            <form onSubmit={handleForgotStart} className="space-y-4">
              <p className="text-xs text-stone-500 text-center">{t.forgotIntro}</p>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  type="email"
                  autoComplete="email"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  placeholder={t.email}
                  autoFocus
                  disabled={submitting}
                  className={inputClass(error)}
                />
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button
                type="submit"
                disabled={!/\S+@\S+\.\S+/.test(forgotEmail) || submitting}
                className={primaryButtonClass}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? t.sending : t.sendCode}
              </button>
              <button type="button" onClick={backToPersonalLogin} className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1">
                <ArrowLeft className="h-3 w-3" /> {t.backToLogin}
              </button>
            </form>
          )}

          {view === 'forgot-code' && (
            <form onSubmit={handleForgotVerify} className="space-y-3">
              {forgotInfo && <p className="text-xs text-stone-500 text-center">{forgotInfo}</p>}
              <div className="relative">
                <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={forgotCode}
                  onChange={e => setForgotCode(e.target.value.replace(/\D/g, ''))}
                  placeholder={t.codePlaceholder}
                  autoFocus
                  disabled={submitting}
                  className={`${inputClass(error)} tracking-[0.3em]`}
                />
              </div>
              {passwordField('rc-new-password', 'new-password', t.newPassword, forgotNewPassword, setForgotNewPassword)}
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button
                type="submit"
                disabled={forgotCode.trim().length !== 6 || forgotNewPassword.length < 6 || submitting}
                className={primaryButtonClass}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? t.checking : t.setPassword}
              </button>
              {/* Codes expire after 10 minutes and are single-use, so "request a
                  new one" has to be reachable from here — not only by starting
                  the whole flow over from the login screen. */}
              <button
                type="button"
                onClick={() => { setError(''); setForgotCode(''); setForgotInfo(''); setView('forgot-email'); }}
                className="w-full text-[11px] text-stone-500 hover:text-stone-700 underline"
              >
                {t.requestNewCode}
              </button>
              <button type="button" onClick={backToPersonalLogin} className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1">
                <ArrowLeft className="h-3 w-3" /> {t.backToLogin}
              </button>
            </form>
          )}

          {view === 'forgot-done' && (
            <div className="space-y-4 text-center">
              <p className="text-sm text-stone-700 font-medium">{forgotInfo}</p>
              <button type="button" onClick={backToPersonalLogin} className={primaryButtonClass}>
                {t.toLogin}
              </button>
            </div>
          )}
        </div>
        <p className="text-center text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400 mt-5">
          Swiss Volley Region Zürich
        </p>
      </div>
    </div>
  );
}

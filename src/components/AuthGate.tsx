import React, { useState, useEffect, createContext, useContext, type ReactNode } from 'react';
import { Lock, Loader2, Mail, ArrowLeft, KeyRound, Eye, EyeOff } from 'lucide-react';
import SvrzLogo from '../SvrzLogo';
import { getAuthMe, rcLogin, rcLogout, rcForgotStart, rcForgotVerify, hasPendingLogout, settlePendingLogout } from '../lib/pocketbase';
import { clientLog, setLogUser, flush } from '../lib/logger';

type ApiError = Error & { status?: number; retryAfterMs?: number };

// One place that turns a failure into German. The distinction that matters:
// "Verbindungsfehler" is reserved for a request that never got a response
// (offline / DNS / CORS). Anything with a status says what the status means —
// a rate limit used to fall through to "Verbindungsfehler", which sent people
// looking for network problems they didn't have.
function errorMessage(err: unknown, fallback = 'Etwas ist schiefgelaufen. Bitte versuche es erneut.'): string {
  const e = err as ApiError;
  if (e?.status === 429) {
    const secs = Math.ceil((e.retryAfterMs || 60_000) / 1000);
    const mins = Math.ceil(secs / 60);
    return secs > 90
      ? `Zu viele Versuche. Bitte in ca. ${mins} Minuten erneut probieren.`
      : `Zu viele Versuche. Bitte in ${secs}s erneut probieren.`;
  }
  if (e?.status === 503) return 'Server vorübergehend nicht erreichbar. Bitte in einer Minute erneut probieren.';
  if (e?.status && e.status >= 500) return 'Serverfehler. Bitte versuche es später erneut.';
  // No status at all == fetch itself rejected == genuinely a connection problem.
  if (e?.status === undefined) {
    return navigator.onLine
      ? 'Verbindungsfehler. Bitte versuche es später erneut.'
      : 'Keine Internetverbindung. Bitte prüfe dein Netz und versuche es erneut.';
  }
  return fallback;
}

// Identity of the session that passed the gate. rcName/rcId are null for
// admin-only sessions (admin console login without a personal RC record).
export type RcAuth = {
  rcId: string | null;
  rcName: string | null;
  isAdminSession: boolean;
  logout: () => void;
};

const RcAuthContext = createContext<RcAuth>({ rcId: null, rcName: null, isAdminSession: false, logout: () => {} });

export function useRcAuth(): RcAuth {
  return useContext(RcAuthContext);
}

const inputClass = (error: string) =>
  `w-full pl-10 pr-4 py-3 rounded-xl border text-sm bg-stone-50 focus:bg-white transition-colors focus:outline-none focus:ring-2 focus:ring-red-500/70 focus:border-red-500 ${error ? 'border-red-400 bg-red-50' : 'border-stone-300'}`;

export default function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rcId, setRcId] = useState<string | null>(null);
  const [rcName, setRcName] = useState<string | null>(null);
  const [isAdminSession, setIsAdminSession] = useState(false);
  // Forgot/set password: 'login' → 'forgot-email' → 'forgot-code' → 'forgot-done'.
  const [mode, setMode] = useState<'login' | 'forgot-email' | 'forgot-code' | 'forgot-done'>('login');
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotCode, setForgotCode] = useState('');
  const [forgotNewPassword, setForgotNewPassword] = useState('');
  const [forgotInfo, setForgotInfo] = useState('');

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
        clientLog.info('auth.probe', me.rc || me.admin ? 'existing session' : 'no session', {
          rc: me.rc?.name, admin: Boolean(me.admin),
        });
        setLogUser(me.rc?.name || me.admin?.email);
        setRcId(me.rc?.id ?? null);
        setRcName(me.rc?.name ?? null);
        setIsAdminSession(Boolean(me.admin));
        setAuthed(Boolean(me.rc || me.admin));
      })
      .catch((error) => { clientLog.warn('auth.probe', 'auth/me failed — showing the login screen', { error }); })
      .finally(() => {
        clearTimeout(timeout);
        setChecking(false);
      });
    return () => clearTimeout(timeout);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
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
      if (!me?.rc?.id && !me?.admin) {
        throw new Error(
          'Anmeldung unvollständig: Der Browser hat die Sitzung nicht gespeichert. '
          + 'Bitte im Datenschutz die Option „Cross-Site-Tracking verhindern" für diese Seite deaktivieren '
          + 'oder einen anderen Browser verwenden.',
        );
      }
      clientLog.info('auth.login', 'login ok', { name: me?.rc?.name ?? result.name, admin: Boolean(me?.admin) });
      setLogUser(me?.rc?.name ?? result.name);
      setRcId(me?.rc?.id ?? null);
      setRcName(me?.rc?.name ?? result.name);
      setIsAdminSession(Boolean(me?.admin));
      setAuthed(true);
      return;
    } catch (err) {
      const e2 = err as ApiError;
      const message = (e2.status === 401 || e2.status === 400)
        ? 'Falsche E-Mail oder falsches Passwort'
        : errorMessage(err);
      clientLog.warn('auth.login', `login failed: ${message}`, { email: email.trim(), status: e2.status, retryAfterMs: e2.retryAfterMs, error: err });
      setError(message);
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const logout = () => {
    clientLog.info('auth.logout', 'logout');
    void flush();
    void rcLogout().finally(() => {
      setLogUser(null);
      setAuthed(false);
      setRcId(null);
      setRcName(null);
      setPassword('');
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
      setMode('forgot-code');
      setForgotInfo('Falls die E-Mail hinterlegt ist, wurde ein Bestätigungscode gesendet.');
    } catch (err) {
      const message = errorMessage(err);
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
      setForgotInfo('Passwort gesetzt. Du kannst dich jetzt anmelden.');
      setMode('forgot-done');
    } catch (err) {
      const e2 = err as ApiError;
      const message = e2.status === 401
        ? 'Code ungültig oder abgelaufen. Fordere bitte einen neuen Code an.'
        : e2.status === 400 ? 'Passwort muss mindestens 6 Zeichen haben.'
        : errorMessage(err);
      clientLog.warn('auth.reset.verify', `verify failed: ${message}`, { email: forgotEmail.trim(), status: e2.status, retryAfterMs: e2.retryAfterMs, error: err });
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const backToLogin = () => {
    setMode('login');
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
      <RcAuthContext.Provider value={{ rcId, rcName, isAdminSession, logout }}>
        {children}
      </RcAuthContext.Provider>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-100 via-stone-50 to-stone-100 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="relative overflow-hidden bg-white rounded-3xl shadow-card-lg border border-stone-200/70 p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-red-600 to-red-500" />

          <div className="flex flex-col items-center text-center mb-7">
            <SvrzLogo className="h-11 w-auto" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-400 mt-4">
              Referee Coaching
            </p>
          </div>

          {mode === 'login' && (
            <>
              <form onSubmit={handleSubmit} className="space-y-3">
                <div className="relative">
                  <label htmlFor="rc-email" className="sr-only">E-Mail</label>
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                  <input
                    id="rc-email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="E-Mail"
                    autoFocus
                    disabled={submitting}
                    className={inputClass(error)}
                  />
                </div>
                <div>
                  <div className="relative">
                    <label htmlFor="rc-password" className="sr-only">Passwort</label>
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                    <input
                      id="rc-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="Passwort"
                      disabled={submitting}
                      className={`${inputClass(error)} !pr-10`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
                      tabIndex={-1}
                      aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {error && <p className="text-red-600 text-xs mt-2 font-medium">{error}</p>}
                </div>
                <button
                  type="submit"
                  disabled={!/\S+@\S+\.\S+/.test(email) || password.length < 1 || submitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 active:scale-[0.99] disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all shadow-sm shadow-red-600/20"
                >
                  {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                  {submitting ? 'Prüfe…' : 'Anmelden'}
                </button>
              </form>
              <p className="text-center text-[11px] text-stone-400 mt-5">
                <button type="button" onClick={() => { setError(''); setForgotEmail(email); setMode('forgot-email'); }} className="underline hover:text-stone-600">
                  Passwort vergessen / einrichten
                </button>
                {' · '}
                <a href="#/admin" className="underline hover:text-stone-600">Admin-Login</a>
              </p>
            </>
          )}

          {mode === 'forgot-email' && (
            <form onSubmit={handleForgotStart} className="space-y-4">
              <p className="text-xs text-stone-500 text-center">Gib deine hinterlegte E-Mail ein — wir senden dir einen Bestätigungscode.</p>
              <div className="relative">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  type="email"
                  autoComplete="email"
                  value={forgotEmail}
                  onChange={e => setForgotEmail(e.target.value)}
                  placeholder="E-Mail"
                  autoFocus
                  disabled={submitting}
                  className={inputClass(error)}
                />
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button
                type="submit"
                disabled={!/\S+@\S+\.\S+/.test(forgotEmail) || submitting}
                className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Sende…' : 'Code senden'}
              </button>
              <button type="button" onClick={backToLogin} className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1">
                <ArrowLeft className="h-3 w-3" /> Zurück zur Anmeldung
              </button>
            </form>
          )}

          {mode === 'forgot-code' && (
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
                  placeholder="6-stelliger Code"
                  autoFocus
                  disabled={submitting}
                  className={`${inputClass(error)} tracking-[0.3em]`}
                />
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400 pointer-events-none" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={forgotNewPassword}
                  onChange={e => setForgotNewPassword(e.target.value)}
                  placeholder="Neues Passwort (min. 6 Zeichen)"
                  disabled={submitting}
                  className={`${inputClass(error)} !pr-10`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {error && <p className="text-red-600 text-xs font-medium">{error}</p>}
              <button
                type="submit"
                disabled={forgotCode.trim().length !== 6 || forgotNewPassword.length < 6 || submitting}
                className="w-full inline-flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 disabled:bg-stone-300 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl text-sm transition-all"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Prüfe…' : 'Passwort setzen'}
              </button>
              {/* Codes expire after 10 minutes and are single-use, so "request a
                  new one" has to be reachable from here — not only by starting
                  the whole flow over from the login screen. */}
              <button
                type="button"
                onClick={() => { setError(''); setForgotCode(''); setForgotInfo(''); setMode('forgot-email'); }}
                className="w-full text-[11px] text-stone-500 hover:text-stone-700 underline"
              >
                Neuen Code anfordern
              </button>
              <button type="button" onClick={backToLogin} className="w-full text-[11px] text-stone-400 hover:text-stone-600 inline-flex items-center justify-center gap-1">
                <ArrowLeft className="h-3 w-3" /> Zurück zur Anmeldung
              </button>
            </form>
          )}

          {mode === 'forgot-done' && (
            <div className="space-y-4 text-center">
              <p className="text-sm text-stone-700 font-medium">{forgotInfo}</p>
              <button
                type="button"
                onClick={backToLogin}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-semibold py-3 rounded-xl text-sm transition-all"
              >
                Zur Anmeldung
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
